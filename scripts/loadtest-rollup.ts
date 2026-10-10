/**
 * The load test against the real program. K traders, each opened and funded
 * through a running service's two fund routes exactly as a user is, each
 * sending real orders for T seconds. Every order is its own transaction with
 * a fresh one-time key and a fresh secret.
 *
 *   make loadtest VENUE=rollup LOADTEST_TRADERS=20 LOADTEST_SECONDS=60
 *
 * It reads DEPLOYMENT_PATH or DEPLOYMENT_JSON for the program and its markets,
 * and refuses any rollup endpoint that is not this machine unless that
 * endpoint is passed with --allow-rpc.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { Connection } from "@solana/web3.js";
import { Keypair } from "@solana/web3.js";
import { SeededRandom } from "../src/bots/rng.js";
import { percentile } from "../src/data/percentile.js";
import type { KeyCheckpoint, PlaceOutcome } from "../src/rollup/chain-types.js";
import { connectionTo } from "../src/rollup/connections.js";
import {
  CLIENT_RELEASE,
  Program,
  type ProgramTrader,
  firstOrderKeys,
  newOrderSecret,
  signedInConnection,
} from "../src/rollup/program.js";
import {
  type Deployment,
  deployedMarket,
  loadDeployment,
  roleKey,
} from "../src/rollup/settings.js";
import { COLLATERAL_TOKEN, deployedToken } from "../src/rollup/tokens.js";
import { sendDepositAndConfirm } from "../src/rollup/transactions.js";
import { toChainAmount } from "../src/rollup/units.js";
import { prepareRequest, submitRequest } from "./fund-client.js";
import { flag, machine, writeReport } from "./report.js";
import { requireAllowedRpc } from "./rpc-allow-list.js";

/**
 * The traders of earlier runs, with their owner keys, in the git-ignored data
 * folder. They are reused, because the program opens only so many new seats a
 * day. They hold test tokens on a test network and nothing else.
 */
const TRADERS_FILE = join("data", "loadtest-traders.json");
const GRANT_NUSD = 5_000n * 1_000_000n;
/** The service re-reads the tape every five seconds at the latest. */
const TAPE_CATCH_UP_MS = 6_000;
const MARK_REFRESH_MS = 1_000;
const HEALTH_SAMPLE_MS = 5_000;
const HEALTH_TIMEOUT_MS = 4_000;
/** A view has four order key slots, so a trader keeps four orders in flight at most. */
const MAX_IN_FLIGHT = 4;
/** Orders are priced 1% through the mark, so they cross the house maker's quotes. */
const REACH_THROUGH_MARK = 100n;
const RANDOM_SEED = 1337;

const flags = (name: string): string[] =>
  process.argv.flatMap((value, at) => (value === name ? [process.argv[at + 1] ?? ""] : []));

interface LoadTrader {
  owner: Keypair;
  trader: ProgramTrader;
}

interface KeptTrader {
  programId: string;
  owner: number[];
  checkpoint: KeyCheckpoint;
}

const readKept = async (): Promise<KeptTrader[]> => {
  try {
    return JSON.parse(await readFile(TRADERS_FILE, "utf8")) as KeptTrader[];
  } catch {
    return [];
  }
};

const sameOwner = (a: number[], b: number[]): boolean => a.every((byte, at) => byte === b[at]);

/**
 * Updates this run's traders in the file and leaves every other one in it:
 * a trader's key is its seat, and a seat is not given back.
 */
const keep = async (programId: string, traders: LoadTrader[]): Promise<void> => {
  const current: KeptTrader[] = traders.map(({ owner, trader }) => ({
    programId,
    owner: Array.from(owner.secretKey),
    checkpoint: trader.checkpoint,
  }));
  const others = (await readKept()).filter(
    (entry) => !current.some((trader) => sameOwner(trader.owner, entry.owner)),
  );
  await mkdir(dirname(TRADERS_FILE), { recursive: true });
  await writeFile(TRADERS_FILE, JSON.stringify([...current, ...others]), { mode: 0o600 });
};

const openThroughTheService = async (simUrl: string, owner: Keypair): Promise<void> => {
  const post = async (path: string, payload: unknown) => {
    const response = await fetch(`${simUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as { transaction?: string; error?: string };
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${body.error}`);
    return body;
  };
  const prepared = await post("/v1/fund/prepare", prepareRequest(owner));
  if (!prepared.transaction) throw new Error("/v1/fund/prepare answered without a transaction");
  await post("/v1/fund/submit", submitRequest(owner, prepared.transaction));
};

/**
 * `--open keys`: the same open-and-fund transaction the service's fund routes
 * build, signed here with the gate and faucet keys (GATE_SECRET_KEY_FILE,
 * FAUCET_SECRET_KEY_FILE), for when a running service must not be disturbed.
 */
const openWithTheKeys = async (
  program: Program,
  rollupRpcUrl: string,
  deployment: Deployment,
  owner: Keypair,
): Promise<void> => {
  const gate = roleKey(process.env, "GATE_SECRET_KEY");
  const faucet = roleKey(process.env, "FAUCET_SECRET_KEY");
  const collateral = deployedToken(deployment, COLLATERAL_TOKEN);
  if (!collateral) throw new Error(`The deployment has no ${COLLATERAL_TOKEN} token.`);
  const connection = await signedInConnection(rollupRpcUrl, faucet);
  const transaction = await program.openAndFundTransaction(connection, {
    gate: gate.publicKey,
    faucet: faucet.publicKey,
    owner: owner.publicKey,
    orderKeys: firstOrderKeys(owner),
    mint: collateral.mint,
    amount: toChainAmount(GRANT_NUSD, collateral.decimals),
  });
  transaction.sign(gate, owner, faucet);
  await sendDepositAndConfirm(connection, transaction);
};

interface Options {
  traderCount: number;
  seconds: number;
  lateMs: number;
  simUrl: string;
  rollupRpcUrl: string;
  rollupWsUrl: string;
  symbol: string;
  inFlight: number;
  openWithKeys: boolean;
  label: string;
}

const optionsFromFlags = (): Options => {
  const options: Options = {
    traderCount: Number(flag("--traders", "20")),
    seconds: Number(flag("--seconds", "10")),
    lateMs: Number(flag("--late-ms", "1000")),
    simUrl: flag("--sim-url", "http://127.0.0.1:4100"),
    rollupRpcUrl: flag("--rollup-rpc", "http://127.0.0.1:6699"),
    rollupWsUrl: flag("--rollup-ws", "ws://127.0.0.1:6700"),
    symbol: flag("--market", "NSOL-PERP"),
    inFlight: Math.min(MAX_IN_FLIGHT, Math.max(1, Number(flag("--in-flight", "1")))),
    openWithKeys: flag("--open", "service") === "keys",
    label: flag("--label", "latest-rollup"),
  };
  if (!Number.isInteger(options.traderCount) || options.traderCount < 1 || !(options.seconds > 0)) {
    throw new Error(
      "--traders must be a whole number of at least 1 and --seconds a positive number.",
    );
  }
  requireAllowedRpc([options.rollupRpcUrl, options.rollupWsUrl], flags("--allow-rpc"));
  return options;
};

/** The kept traders of this program first, then as many new ones as the run still needs. */
const tradersFor = async (
  options: Options,
  program: Program,
  deployment: Deployment,
): Promise<{ traders: LoadTrader[]; reused: number }> => {
  const { traderCount, simUrl, rollupRpcUrl, openWithKeys } = options;
  const kept = (await readKept()).filter((entry) => entry.programId === deployment.programId);
  const traders: LoadTrader[] = [];
  for (const { owner: secretKey, checkpoint } of kept.slice(0, traderCount)) {
    const owner = Keypair.fromSecretKey(Uint8Array.from(secretKey));
    const trader = await program.ownTrader(rollupRpcUrl, owner, checkpoint);
    if (trader) traders.push({ owner, trader });
  }
  const reused = traders.length;
  console.log(
    `Reusing ${reused} traders from ${TRADERS_FILE}; opening ${traderCount - reused} through ${simUrl} ...`,
  );
  while (traders.length < traderCount) {
    const owner = Keypair.generate();
    if (openWithKeys) await openWithTheKeys(program, rollupRpcUrl, deployment, owner);
    else await openThroughTheService(simUrl, owner);
    traders.push({ owner, trader: await program.newTrader(rollupRpcUrl, owner) });
    await keep(deployment.programId, traders);
  }
  return { traders, reused };
};

const newCounters = () => ({
  sent: 0,
  confirmed: 0,
  expired: 0,
  invalid: 0,
  refusedByProgram: 0,
  failed: 0,
  filled: 0,
  late: 0,
  latenciesMs: [] as number[],
  unknown: 0,
  unknownExecutedLate: 0,
  unknownExpired: 0,
  lateExecutionsMs: [] as number[],
  errors: new Map<string, number>(),
  /** Orders whose outcome was unknown, each resolving once the rollup's clock has settled it. */
  settling: [] as Promise<void>[],
});

type Counters = ReturnType<typeof newCounters>;

const noteError = (counters: Counters, error: unknown): void => {
  const [text] = (error instanceof Error ? error.message : String(error)).split("\n");
  const kind = text.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<id>").slice(0, 160);
  counters.errors.set(kind, (counters.errors.get(kind) ?? 0) + 1);
};

const countSettled = (counters: Counters, settled: PlaceOutcome): void => {
  if (settled.status === "expired") {
    counters.unknownExpired += 1;
    return;
  }
  counters.unknownExecutedLate += 1;
  counters.lateExecutionsMs.push(settled.sendToResultMs);
  if (settled.filled > 0n) counters.filled += 1;
};

const countOutcome = (counters: Counters, outcome: PlaceOutcome, lateMs: number): void => {
  if (outcome.settled) {
    counters.unknown += 1;
    counters.settling.push(outcome.settled.then((settled) => countSettled(counters, settled)));
  } else if (outcome.status === "expired") counters.expired += 1;
  else if (outcome.status === "invalid") counters.invalid += 1;
  else if (outcome.status === "failed") counters.refusedByProgram += 1;
  else {
    counters.confirmed += 1;
    counters.latenciesMs.push(outcome.sendToResultMs);
    if (outcome.sendToResultMs > lateMs) counters.late += 1;
    if (outcome.filled > 0n) counters.filled += 1;
  }
};

interface Target {
  program: Program;
  chain: Connection;
  marketId: number;
  perpMarketIds: number[];
}

/** Sends immediate-or-cancel orders from every trader until the time is up. */
const sendOrders = async (
  options: Options,
  target: Target,
  traders: LoadTrader[],
  counters: Counters,
): Promise<{ elapsedSeconds: number; health: { samples: number; ready: number } }> => {
  const { program, chain, marketId, perpMarketIds } = target;
  const { tick, minNotional } = await program.market(chain, marketId);
  const random = new SeededRandom(RANDOM_SEED);
  const startedAt = Date.now();
  const deadline = startedAt + options.seconds * 1_000;

  // The mark is read once a second for everyone, not once per order: the
  // run measures orders, and a read per order would be half its traffic.
  let mark = (await program.price(chain, marketId)).price;
  const markTimer = setInterval(() => {
    void program
      .price(chain, marketId)
      .then((price) => {
        mark = price.price;
      })
      .catch((error: unknown) => noteError(counters, error));
  }, MARK_REFRESH_MS);

  const health = { samples: 0, ready: 0 };
  const healthTimer = setInterval(() => {
    health.samples += 1;
    void fetch(`${options.simUrl}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      .then((response) => {
        if (response.status === 200) health.ready += 1;
      })
      .catch(() => undefined);
  }, HEALTH_SAMPLE_MS);

  const sendUntilDeadline = async (trader: ProgramTrader): Promise<void> => {
    while (Date.now() < deadline) {
      const side = random.nextBool() ? "buy" : "sell";
      const reach = (mark / REACH_THROUGH_MARK / tick) * tick;
      const price = side === "buy" ? mark + reach : mark - reach;
      const size = minNotional / price + BigInt(random.nextInt(1, 3));
      counters.sent += 1;
      try {
        const order = { side, type: "ioc", price, size, reduceOnly: false } as const;
        const outcome = await trader.place(
          marketId,
          { ...order, secret: newOrderSecret() },
          perpMarketIds,
        );
        countOutcome(counters, outcome, options.lateMs);
      } catch (error) {
        counters.failed += 1;
        noteError(counters, error);
      }
    }
  };
  await Promise.all(
    traders.flatMap(({ trader }) => {
      trader.inFlightLimit = options.inFlight;
      return Array.from({ length: options.inFlight }, () => sendUntilDeadline(trader));
    }),
  );
  clearInterval(markTimer);
  clearInterval(healthTimer);
  return { elapsedSeconds: (Date.now() - startedAt) / 1_000, health };
};

export async function main(): Promise<void> {
  const options = optionsFromFlags();
  const { symbol, rollupRpcUrl, simUrl } = options;
  const deployment = loadDeployment(process.env, [symbol]);
  const marketId = deployedMarket(deployment, symbol).id;
  const perpMarketIds = deployment.markets.filter((m) => m.kind === "perp").map((m) => m.id);
  const program = new Program(deployment.programId);
  const chain = connectionTo(rollupRpcUrl, options.rollupWsUrl);

  const { traders, reused } = await tradersFor(options, program, deployment);
  const counters = newCounters();
  const fillsBefore = (await program.stats(chain)).fills;
  const { elapsedSeconds, health } = await sendOrders(
    options,
    { program, chain, marketId, perpMarketIds },
    traders,
    counters,
  );
  await Promise.allSettled(counters.settling);
  await keep(deployment.programId, traders);
  for (const { trader } of traders) trader.close();

  const fillsOnChain = Number((await program.stats(chain)).fills - fillsBefore);
  await new Promise((resolve) => setTimeout(resolve, TAPE_CATCH_UP_MS));
  const chainLastFill = Number((await program.tape(chain, marketId)).lastSequence);
  const served = (await (await fetch(`${simUrl}/v1/tape?market=${symbol}&limit=1`)).json()) as {
    fills: { sequence: number }[];
  };
  const sorted = [...counters.latenciesMs].sort((a, b) => a - b);
  const sortedLate = [...counters.lateExecutionsMs].sort((a, b) => a - b);
  const notOnTime = counters.late + counters.expired + counters.unknown;
  const isLocal = /127\.0\.0\.1|localhost/.test(rollupRpcUrl);
  const report = {
    venueKind: "RollupVenue",
    measuredAgainst: `the order book program on ${deployment.network}, through the query filter at ${rollupRpcUrl}`,
    client: CLIENT_RELEASE,
    market: symbol,
    traderCount: options.traderCount,
    tradersReused: reused,
    ordersInFlightPerTrader: options.inFlight,
    durationSeconds: elapsedSeconds,
    ordersSent: counters.sent,
    ordersRefusedBeforeSigning: counters.invalid,
    ordersRefusedByTheProgram: counters.refusedByProgram,
    resultsConfirmed: counters.confirmed,
    ordersExpired: counters.expired,
    sendsFailed: counters.failed,
    ordersWithAFill: counters.filled,
    fillsOnChainDuringRun: fillsOnChain,
    confirmedOrdersPerSecond: counters.confirmed / elapsedSeconds,
    sendToResultMs: {
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
      maxMs: sorted.at(-1) ?? 0,
    },
    lateThresholdMs: options.lateMs,
    ordersLate: counters.late,
    lateShare: counters.confirmed === 0 ? 0 : counters.late / counters.confirmed,
    errorsByKind: Object.fromEntries(counters.errors),
    serviceHealth: health,
    tape: { chainLastFill, serviceLastFill: served.fills[0]?.sequence ?? 0 },
    outcomeUnknown: {
      total: counters.unknown,
      settledExecutedLate: counters.unknownExecutedLate,
      settledExpired: counters.unknownExpired,
      stillUnsettled: counters.unknown - counters.unknownExecutedLate - counters.unknownExpired,
      lateExecutionSendToResultMs: {
        minMs: sortedLate[0] ?? 0,
        medianMs: percentile(sortedLate, 0.5),
        p95Ms: percentile(sortedLate, 0.95),
        maxMs: sortedLate.at(-1) ?? 0,
      },
    },
    lateOrExpiredOrUnknownShare: counters.sent === 0 ? 0 : notOnTime / counters.sent,
    network: isLocal
      ? "one machine: the load test, the service and its bots, the query filter, the rollup and the Solana validator all on loopback. Not a network number."
      : `remote rollup at ${rollupRpcUrl}, measured from ${hostname()}`,
    machine: machine(),
    generatedAtMs: Date.now(),
  };

  const json = JSON.stringify(report, null, 2);
  console.log(json);
  console.log(`\nWrote ${await writeReport(`${options.label}.json`, json)}`);
  process.exit(0);
}
