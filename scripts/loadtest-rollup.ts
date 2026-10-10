/**
 * The load test against the real program. K traders, each opened and funded
 * through a running service's two fund routes exactly as a user is, each
 * sending real orders for T seconds. Every order is its own transaction: a
 * fresh one-time key, a fresh secret and a fresh client order id.
 *
 *   make loadtest VENUE=rollup LOADTEST_TRADERS=20 LOADTEST_SECONDS=60
 *
 * It reads DEPLOYMENT_PATH or DEPLOYMENT_JSON for the program and its markets,
 * and refuses any rollup endpoint that is not this machine unless that
 * endpoint is passed with --allow-rpc.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Keypair, Transaction } from "@solana/web3.js";
import { SeededRandom } from "../src/bots/rng.js";
import {
  CLIENT_RELEASE,
  type KeyCheckpoint,
  Program,
  type ProgramTrader,
  firstOrderKeys,
  publicConnection,
  sendDepositAndConfirm,
  signedInConnection,
} from "../src/rollup/program.js";
import { requireAllowedRpc } from "../src/rollup/rpc-allow-list.js";

const REPORT_DIR = "loadtest-reports";
/**
 * The traders of earlier runs, with their owner keys, in the git-ignored data
 * folder. They are reused, because the program opens only so many new seats a
 * day. They hold test tokens on a test network and nothing else.
 */
const TRADERS_FILE = join("data", "loadtest-traders.json");
const GRANT_NUSD = 5_000n;
/** The service re-reads the tape every five seconds at the latest. */
const TAPE_CATCH_UP_MS = 6_000;

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1]!;
};

const flags = (name: string): string[] =>
  process.argv.flatMap((value, at) => (value === name ? [process.argv[at + 1] ?? ""] : []));

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

interface Counters {
  sent: number;
  confirmed: number;
  expired: number;
  invalid: number;
  refusedByProgram: number;
  failed: number;
  filled: number;
  late: number;
  latenciesMs: number[];
  unknown: number;
  unknownExecutedLate: number;
  unknownExpired: number;
  lateExecutionsMs: number[];
}

interface LoadTrader {
  owner: Keypair;
  trader: ProgramTrader;
}

interface KeptTrader {
  programId: string;
  owner: number[];
  checkpoint: KeyCheckpoint;
}

const readAllKept = async (): Promise<KeptTrader[]> => {
  try {
    return JSON.parse(await readFile(TRADERS_FILE, "utf8")) as KeptTrader[];
  } catch {
    return [];
  }
};

const readKept = async (programId: string): Promise<KeptTrader[]> =>
  (await readAllKept()).filter((entry) => entry.programId === programId);

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
  const others = (await readAllKept()).filter(
    (entry) => !current.some((trader) => sameOwner(trader.owner, entry.owner)),
  );
  await mkdir(dirname(TRADERS_FILE), { recursive: true });
  await writeFile(TRADERS_FILE, JSON.stringify([...current, ...others]), { mode: 0o600 });
};

const openThroughTheService = async (
  simUrl: string,
  program: Program,
  rollupRpcUrl: string,
): Promise<LoadTrader> => {
  const owner = Keypair.generate();
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
  const address = owner.publicKey.toBase58();
  const prepared = await post("/v1/fund/prepare", {
    owner: address,
    orderKeys: firstOrderKeys(owner).map((key) => key.toBase58()),
  });
  const transaction = Transaction.from(Buffer.from(prepared.transaction!, "base64"));
  transaction.partialSign(owner);
  await post("/v1/fund/submit", {
    owner: address,
    transaction: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
  });
  return { owner, trader: await program.newTrader(rollupRpcUrl, owner) };
};

/**
 * `--open keys`: the same open-and-fund transaction the service's fund routes
 * build, signed here with the gate and faucet keys (GATE_SECRET_KEY_FILE,
 * FAUCET_SECRET_KEY_FILE), for when a running service must not be disturbed.
 */
const openWithTheKeys = async (
  program: Program,
  rollupRpcUrl: string,
  rawDeployment: string,
): Promise<LoadTrader> => {
  const keyAt = async (name: string): Promise<Keypair> => {
    const path = process.env[name];
    if (!path) throw new Error(`--open keys needs ${name}.`);
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
  };
  const gate = await keyAt("GATE_SECRET_KEY_FILE");
  const faucet = await keyAt("FAUCET_SECRET_KEY_FILE");
  const { tokens } = JSON.parse(rawDeployment) as {
    tokens: { symbol: string; mint: string; decimals: number }[];
  };
  const collateral = tokens.find((token) => token.symbol === "nUSD");
  if (!collateral) throw new Error("The deployment has no nUSD token.");
  const owner = Keypair.generate();
  const connection = await signedInConnection(rollupRpcUrl, faucet);
  const transaction = await program.openAndFundTransaction(connection, {
    gate: gate.publicKey,
    faucet: faucet.publicKey,
    owner: owner.publicKey,
    orderKeys: firstOrderKeys(owner),
    mint: collateral.mint,
    amount: GRANT_NUSD * 10n ** BigInt(collateral.decimals),
  });
  transaction.sign(gate, owner, faucet);
  await sendDepositAndConfirm(connection, transaction);
  return { owner, trader: await program.newTrader(rollupRpcUrl, owner) };
};

export async function main(): Promise<void> {
  const traderCount = Number(flag("--traders", "20"));
  const seconds = Number(flag("--seconds", "10"));
  if (!Number.isInteger(traderCount) || traderCount < 1 || !(seconds > 0)) {
    throw new Error(
      "--traders must be a whole number of at least 1 and --seconds a positive number.",
    );
  }
  const lateMs = Number(flag("--late-ms", "1000"));
  const simUrl = flag("--sim-url", "http://127.0.0.1:4100");
  const rollupRpcUrl = flag("--rollup-rpc", "http://127.0.0.1:6699");
  const rollupWsUrl = flag("--rollup-ws", "ws://127.0.0.1:6700");
  const symbol = flag("--market", "NSOL-PERP");
  const inFlight = Math.min(4, Math.max(1, Number(flag("--in-flight", "1"))));
  const openDirectly = flag("--open", "service") === "keys";
  const label = flag("--label", "latest-rollup");
  requireAllowedRpc([rollupRpcUrl, rollupWsUrl], flags("--allow-rpc"));

  const rawDeployment =
    process.env.DEPLOYMENT_JSON ??
    (process.env.DEPLOYMENT_PATH ? await readFile(process.env.DEPLOYMENT_PATH, "utf8") : null);
  if (!rawDeployment) throw new Error("Set DEPLOYMENT_PATH or DEPLOYMENT_JSON.");
  const deployment = JSON.parse(rawDeployment) as {
    network: string;
    programId: string;
    markets: { id: number; symbol: string; kind: string }[];
  };
  const market = deployment.markets.find((entry) => entry.symbol === symbol);
  if (!market) throw new Error(`The deployment has no market ${symbol}.`);
  const perpMarkets = deployment.markets.filter((m) => m.kind === "perp").map((m) => m.id);

  const program = new Program(deployment.programId);
  const chain = publicConnection(rollupRpcUrl, rollupWsUrl);
  const { tick, minNotional } = await program.market(chain, market.id);

  const traders: LoadTrader[] = [];
  for (const kept of (await readKept(deployment.programId)).slice(0, traderCount)) {
    const owner = Keypair.fromSecretKey(Uint8Array.from(kept.owner));
    const trader = await program.ownTrader(rollupRpcUrl, owner, kept.checkpoint);
    if (trader) traders.push({ owner, trader });
  }
  const reused = traders.length;
  console.log(
    `Reusing ${reused} traders from ${TRADERS_FILE}; opening ${traderCount - reused} through ${simUrl} ...`,
  );
  while (traders.length < traderCount) {
    traders.push(
      openDirectly
        ? await openWithTheKeys(program, rollupRpcUrl, rawDeployment)
        : await openThroughTheService(simUrl, program, rollupRpcUrl),
    );
    await keep(deployment.programId, traders);
  }

  const counters: Counters = {
    sent: 0,
    confirmed: 0,
    expired: 0,
    invalid: 0,
    refusedByProgram: 0,
    failed: 0,
    filled: 0,
    late: 0,
    latenciesMs: [],
    unknown: 0,
    unknownExecutedLate: 0,
    unknownExpired: 0,
    lateExecutionsMs: [],
  };
  const settling: Promise<void>[] = [];
  const random = new SeededRandom(1337);
  const fillsBefore = (await program.stats(chain)).fills;
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1_000;

  // The mark is read once a second for everyone, not once per order: the
  // run measures orders, and a read per order would be half its traffic.
  let mark = (await program.price(chain, market.id)).price;
  const markTimer = setInterval(() => {
    void program
      .price(chain, market.id)
      .then((price) => {
        mark = price.price;
      })
      .catch((error: unknown) => noteError(error));
  }, 1_000);

  const health = { samples: 0, ready: 0 };
  const healthTimer = setInterval(() => {
    health.samples += 1;
    void fetch(`${simUrl}/v1/health`, { signal: AbortSignal.timeout(4_000) })
      .then((response) => {
        if (response.status === 200) health.ready += 1;
      })
      .catch(() => undefined);
  }, 5_000);

  const errors = new Map<string, number>();
  const noteError = (error: unknown): void => {
    const text = (error instanceof Error ? error.message : String(error)).split("\n")[0]!;
    const kind = text.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "<id>").slice(0, 160);
    errors.set(kind, (errors.get(kind) ?? 0) + 1);
  };

  const runTrader = async (trader: ProgramTrader): Promise<void> => {
    while (Date.now() < deadline) {
      const side = random.nextBool() ? "buy" : "sell";
      const reach = (mark / 100n / tick) * tick;
      const price = side === "buy" ? mark + reach : mark - reach;
      const size = minNotional / price + BigInt(random.nextInt(1, 3));
      counters.sent += 1;
      try {
        const outcome = await trader.place(
          market.id,
          {
            side,
            type: "ioc",
            price,
            size,
            reduceOnly: false,
            secret: new Uint8Array(randomBytes(16)),
          },
          perpMarkets,
        );
        if (outcome.settled) {
          counters.unknown += 1;
          settling.push(
            outcome.settled.then((settled) => {
              if (settled.status === "expired") {
                counters.unknownExpired += 1;
                return;
              }
              counters.unknownExecutedLate += 1;
              counters.lateExecutionsMs.push(settled.sendToResultMs);
              if (settled.filled > 0n) counters.filled += 1;
            }),
          );
          continue;
        }
        if (outcome.status === "expired") {
          counters.expired += 1;
          continue;
        }
        if (outcome.status === "invalid") {
          counters.invalid += 1;
          continue;
        }
        if (outcome.status === "failed") {
          counters.refusedByProgram += 1;
          continue;
        }
        counters.confirmed += 1;
        counters.latenciesMs.push(outcome.sendToResultMs);
        if (outcome.sendToResultMs > lateMs) counters.late += 1;
        if (outcome.filled > 0n) counters.filled += 1;
      } catch (error) {
        counters.failed += 1;
        noteError(error);
      }
    }
  };
  await Promise.all(
    traders.flatMap(({ trader }) => {
      trader.inFlightLimit = inFlight;
      return Array.from({ length: inFlight }, () => runTrader(trader));
    }),
  );
  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  clearInterval(markTimer);
  clearInterval(healthTimer);
  // An order whose outcome was unknown may still run until the rollup's
  // clock passes its expiry: the report waits until every one has settled.
  await Promise.allSettled(settling);
  await keep(deployment.programId, traders);

  const fillsOnChain = Number((await program.stats(chain)).fills - fillsBefore);
  await new Promise((resolve) => setTimeout(resolve, TAPE_CATCH_UP_MS));
  const chainLastFill = Number((await program.tape(chain, market.id)).lastSequence);
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
    traderCount,
    tradersReused: reused,
    ordersInFlightPerTrader: inFlight,
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
      maxMs: sorted[sorted.length - 1] ?? 0,
    },
    lateThresholdMs: lateMs,
    ordersLate: counters.late,
    lateShare: counters.confirmed === 0 ? 0 : counters.late / counters.confirmed,
    errorsByKind: Object.fromEntries(errors),
    serviceHealth: { samples: health.samples, ready: health.ready },
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
        maxMs: sortedLate[sortedLate.length - 1] ?? 0,
      },
    },
    lateOrExpiredOrUnknownShare: counters.sent === 0 ? 0 : notOnTime / counters.sent,
    network: isLocal
      ? "one machine: the load test, the service and its bots, the query filter, the rollup and the Solana validator all on loopback. Not a network number."
      : `remote rollup at ${rollupRpcUrl}, measured from ${hostname()}`,
    machine: {
      platform: platform(),
      release: release(),
      hostname: hostname(),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      totalMemoryGiB: Math.round(totalmem() / 1024 / 1024 / 1024),
      nodeVersion: process.version,
    },
    generatedAtMs: Date.now(),
  };

  console.log(JSON.stringify(report, null, 2));
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(join(REPORT_DIR, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${join(REPORT_DIR, `${label}.json`)}`);
  process.exit(0);
}
