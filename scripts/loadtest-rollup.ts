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
} from "../src/rollup/program.js";
import { requireAllowedRpc } from "../src/rollup/rpc-allow-list.js";

const REPORT_DIR = "loadtest-reports";
/**
 * The traders of earlier runs, with their owner keys, in the git-ignored data
 * folder. They are reused, because the program opens only so many new seats a
 * day. They hold test tokens on a test network and nothing else.
 */
const TRADERS_FILE = join("data", "loadtest-traders.json");

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

const readKept = async (programId: string): Promise<KeptTrader[]> => {
  try {
    const kept = JSON.parse(await readFile(TRADERS_FILE, "utf8")) as KeptTrader[];
    return kept.filter((entry) => entry.programId === programId);
  } catch {
    return [];
  }
};

const keep = async (programId: string, traders: LoadTrader[]): Promise<void> => {
  const kept: KeptTrader[] = traders.map(({ owner, trader }) => ({
    programId,
    owner: Array.from(owner.secretKey),
    checkpoint: trader.checkpoint,
  }));
  await mkdir(dirname(TRADERS_FILE), { recursive: true });
  await writeFile(TRADERS_FILE, JSON.stringify(kept), { mode: 0o600 });
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

export async function main(): Promise<void> {
  const traderCount = Number(flag("--traders", "20"));
  const seconds = Number(flag("--seconds", "10"));
  const lateMs = Number(flag("--late-ms", "1000"));
  const simUrl = flag("--sim-url", "http://127.0.0.1:4100");
  const rollupRpcUrl = flag("--rollup-rpc", "http://127.0.0.1:6699");
  const rollupWsUrl = flag("--rollup-ws", "ws://127.0.0.1:6700");
  const symbol = flag("--market", "NSOL-PERP");
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
    traders.push(await openThroughTheService(simUrl, program, rollupRpcUrl));
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
  };
  const random = new SeededRandom(1337);
  const fillsBefore = (await program.stats(chain)).fills;
  const startedAt = Date.now();
  const deadline = startedAt + seconds * 1_000;

  const runTrader = async (trader: ProgramTrader): Promise<void> => {
    while (Date.now() < deadline) {
      const mark = (await program.price(chain, market.id)).price;
      const side = random.nextBool() ? "buy" : "sell";
      const reach = (mark / 100n / tick) * tick;
      const price = side === "buy" ? mark + reach : mark - reach;
      const size = minNotional / price + BigInt(random.nextInt(5, 25));
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
      } catch {
        counters.failed += 1;
      }
    }
  };
  await Promise.all(traders.map(({ trader }) => runTrader(trader)));
  await keep(deployment.programId, traders);

  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const fillsOnChain = Number((await program.stats(chain)).fills - fillsBefore);
  const sorted = [...counters.latenciesMs].sort((a, b) => a - b);
  const isLocal = /127\.0\.0\.1|localhost/.test(rollupRpcUrl);
  const report = {
    venueKind: "RollupVenue",
    measuredAgainst: `the order book program on ${deployment.network}, through the query filter at ${rollupRpcUrl}`,
    client: CLIENT_RELEASE,
    market: symbol,
    traderCount,
    tradersReused: reused,
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
    },
    lateThresholdMs: lateMs,
    ordersLate: counters.late,
    lateOrExpiredShare:
      counters.sent === 0 ? 0 : (counters.late + counters.expired) / counters.sent,
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
  await writeFile(join(REPORT_DIR, "latest-rollup.json"), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${join(REPORT_DIR, "latest-rollup.json")}`);
  process.exit(0);
}
