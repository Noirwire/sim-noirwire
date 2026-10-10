/**
 * The load test. Against the in-memory venue by default: concurrent traders
 * placing limit orders in-process, with no HTTP boundary. `--venue rollup`
 * sends real orders to the program instead (see loadtest-rollup.ts).
 *
 *   make loadtest LOADTEST_TRADERS=20 LOADTEST_SECONDS=10
 */
import { SeededRandom } from "../src/bots/rng.js";
import { percentile } from "../src/data/percentile.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { SCALE } from "../src/engine/money.js";
import type { TraderKey } from "../src/engine/types.js";
import { flag, machine, writeReport } from "./report.js";

const MARKET = "NSOL-NUSD";
const MARK = 100;
const LOT = 1_000n;
const RANDOM_SEED = 1337;

const dollars = (amount: number): bigint => BigInt(Math.round(amount * Number(SCALE)));

interface Run {
  venue: MemoryVenue;
  random: SeededRandom;
  deadlineMs: number;
  ackMs: number[];
  sent: number;
  accepted: number;
}

const tradeUntilDeadline = async (run: Run, trader: TraderKey): Promise<void> => {
  const { venue, random } = run;
  await venue.openTrader(trader);
  await venue.deposit(trader, "nUSD", dollars(1_000_000));
  await venue.deposit(trader, "SOL", dollars(10_000));

  while (Date.now() < run.deadlineMs) {
    const side = random.nextBool() ? "buy" : "sell";
    const size = LOT * BigInt(random.nextInt(1, 10));
    const price = dollars(MARK + random.nextInt(-2, 2));
    const startedAt = performance.now();
    const result = await venue.placeOrder(trader, {
      market: MARKET,
      side,
      type: "limit",
      price,
      size,
    });
    run.ackMs.push(performance.now() - startedAt);
    run.sent += 1;
    if (result.status !== "rejected") run.accepted += 1;
  }
};

const main = async (): Promise<void> => {
  const traderCount = Number(flag("--traders", "20"));
  const seconds = Number(flag("--seconds", "10"));
  const venue = new MemoryVenue();
  let fillsTotal = 0;
  venue.onFill(() => {
    fillsTotal += 1;
  });
  await venue.publishPrice(MARKET, dollars(MARK), Date.now());

  const startedAt = Date.now();
  const run: Run = {
    venue,
    random: new SeededRandom(RANDOM_SEED),
    deadlineMs: startedAt + seconds * 1_000,
    ackMs: [],
    sent: 0,
    accepted: 0,
  };
  await Promise.all(
    Array.from({ length: traderCount }, (_, i) => tradeUntilDeadline(run, `load-trader-${i}`)),
  );
  const durationSeconds = (Date.now() - startedAt) / 1_000;
  const sorted = run.ackMs.sort((a, b) => a - b);

  const report = {
    venueKind: "MemoryVenue",
    measuredAgainst: "MemoryVenue (in-process, no HTTP boundary)",
    traderCount,
    durationSeconds,
    ordersSent: run.sent,
    ordersAccepted: run.accepted,
    fillsTotal,
    ordersPerSecond: run.sent / durationSeconds,
    timeToAckMs: {
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      p99Ms: percentile(sorted, 0.99),
    },
    machine: machine(),
    generatedAtMs: Date.now(),
  };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  const jsonPath = await writeReport("latest.json", json);
  const markdownPath = await writeReport("latest.md", toMarkdown(report));
  console.log(`\nWrote ${jsonPath} and ${markdownPath}`);
};

const toMarkdown = (report: {
  measuredAgainst: string;
  venueKind: string;
  traderCount: number;
  durationSeconds: number;
  ordersSent: number;
  ordersAccepted: number;
  fillsTotal: number;
  ordersPerSecond: number;
  timeToAckMs: { medianMs: number; p95Ms: number; p99Ms: number };
  machine: unknown;
  generatedAtMs: number;
}): string => `# sim-noirwire load test report

Measured against: **${report.measuredAgainst}**

Generated: ${new Date(report.generatedAtMs).toISOString()}

| Metric | Value |
| --- | --- |
| Venue kind | ${report.venueKind} |
| Concurrent traders | ${report.traderCount} |
| Duration | ${report.durationSeconds.toFixed(2)}s |
| Orders sent | ${report.ordersSent} |
| Orders accepted | ${report.ordersAccepted} |
| Fills (venue-wide) | ${report.fillsTotal} |
| Orders per second sustained | ${report.ordersPerSecond.toFixed(1)} |
| Time to ack (median) | ${report.timeToAckMs.medianMs.toFixed(3)} ms |
| Time to ack (p95) | ${report.timeToAckMs.p95Ms.toFixed(3)} ms |
| Time to ack (p99) | ${report.timeToAckMs.p99Ms.toFixed(3)} ms |

## Machine

\`\`\`json
${JSON.stringify(report.machine, null, 2)}
\`\`\`
`;

if (flag("--venue", "memory") === "rollup") {
  void import("./loadtest-rollup.js").then((rollup) => rollup.main());
} else {
  void main();
}
