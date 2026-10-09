import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { SeededRandom } from "../src/bots/rng.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { SCALE } from "../src/engine/money.js";
import type { Side } from "../src/engine/types.js";

const MARKET = "NSOL-NUSD";
const REPORT_DIR = "loadtest-reports";

const dollars = (amount: number): bigint => BigInt(Math.round(amount * Number(SCALE)));

interface LatencySample {
  ms: number;
}

const parseArgIntoNumber = (flag: string, fallback: number): number => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return fallback;
  const parsed = Number(process.argv[index + 1]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const percentile = (sortedMs: number[], p: number): number => {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index]!;
};

const traderKey = (i: number): string => `load-trader-${i}`;

async function runOneTrader(
  venue: MemoryVenue,
  random: SeededRandom,
  trader: string,
  deadlineMs: number,
  now: () => number,
  samples: LatencySample[],
  counters: { sent: number; accepted: number; fills: number },
): Promise<void> {
  await venue.openTrader(trader);
  await venue.deposit(trader, "nUSD", dollars(1_000_000));
  await venue.deposit(trader, "SOL", dollars(10_000));

  while (now() < deadlineMs) {
    const side: Side = random.nextBool() ? "buy" : "sell";
    const size = 1_000n * BigInt(random.nextInt(1, 10));
    const price = dollars(100 + random.nextInt(-2, 2));

    const startedAt = performance.now();
    const result = await venue.placeOrder(trader, {
      market: MARKET,
      side,
      type: "limit",
      price,
      size,
    });
    samples.push({ ms: performance.now() - startedAt });

    counters.sent += 1;
    if (result.status !== "rejected") counters.accepted += 1;
    if (result.filledSize > 0n) counters.fills += 1;
  }
}

async function main(): Promise<void> {
  const traderCount = parseArgIntoNumber("--traders", 20);
  const durationSeconds = parseArgIntoNumber("--seconds", 10);

  const venue = new MemoryVenue();
  const random = new SeededRandom(1337);
  const samples: LatencySample[] = [];
  const counters = { sent: 0, accepted: 0, fills: 0 };
  let fillsSeen = 0;
  venue.onFill(() => {
    fillsSeen += 1;
  });

  await venue.publishPrice(MARKET, dollars(100), Date.now());

  const startedAt = Date.now();
  const deadlineMs = startedAt + durationSeconds * 1_000;
  const now = () => Date.now();

  await Promise.all(
    Array.from({ length: traderCount }, (_, i) =>
      runOneTrader(venue, random, traderKey(i), deadlineMs, now, samples, counters),
    ),
  );

  const elapsedSeconds = (Date.now() - startedAt) / 1_000;
  const sortedMs = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ordersPerSecond = counters.sent / elapsedSeconds;

  const machine = {
    platform: platform(),
    release: release(),
    hostname: hostname(),
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? "unknown",
    totalMemoryGiB: Math.round(totalmem() / 1024 / 1024 / 1024),
    nodeVersion: process.version,
  };

  const report = {
    venueKind: "MemoryVenue",
    measuredAgainst: "MemoryVenue (in-process, no HTTP boundary)",
    traderCount,
    durationSeconds: elapsedSeconds,
    ordersSent: counters.sent,
    ordersAccepted: counters.accepted,
    fillsTotal: fillsSeen,
    ordersPerSecond,
    timeToAckMs: {
      medianMs: percentile(sortedMs, 0.5),
      p95Ms: percentile(sortedMs, 0.95),
      p99Ms: percentile(sortedMs, 0.99),
    },
    machine,
    generatedAtMs: Date.now(),
  };

  console.log(JSON.stringify(report, null, 2));

  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, "latest.json");
  const markdownPath = join(REPORT_DIR, "latest.md");
  await writeFile(jsonPath, JSON.stringify(report, null, 2));
  await writeFile(markdownPath, toMarkdown(report));
  console.log(`\nWrote ${jsonPath} and ${markdownPath}`);
}

function toMarkdown(report: {
  venueKind: string;
  measuredAgainst: string;
  traderCount: number;
  durationSeconds: number;
  ordersSent: number;
  ordersAccepted: number;
  fillsTotal: number;
  ordersPerSecond: number;
  timeToAckMs: { medianMs: number; p95Ms: number; p99Ms: number };
  machine: Record<string, unknown>;
  generatedAtMs: number;
}): string {
  return `# sim-noirwire load test report

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
}

void main();
