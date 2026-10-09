import { isBotTrader } from "../bots/bot-traders.js";
import { mulDivScale } from "../engine/money.js";
import type { Fill, LatencyStats, TraderKey } from "../engine/types.js";

export type FillOrigin = "user" | "bot";

export interface ActivityCounters {
  orders: number;
  fills: number;
  volume: bigint;
}

export interface PublicStats {
  user: ActivityCounters;
  bot: ActivityCounters;
  tradersTotal: number;
  latency: LatencyStats;
  updatedAtMs: number;
}

const emptyCounters = (): ActivityCounters => ({ orders: 0, fills: 0, volume: 0n });

const percentile = (sortedMs: number[], p: number): number => {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index]!;
};

/**
 * Keeps bot and user activity in separate counters, per the rule that the
 * two are never merged into one number. A fill carries no trader identity,
 * so a fill is classified by its caller at the moment it is produced (see
 * `withBotTracking` and the dev trading route), never guessed afterwards.
 */
export class StatsTracker {
  private readonly userTraders = new Set<TraderKey>();
  private readonly botTraders = new Set<TraderKey>();
  private readonly userCounters = emptyCounters();
  private readonly botCounters = emptyCounters();
  private readonly httpLatencyMs: number[] = [];

  constructor(private readonly latencyWindowSize = 500) {}

  recordOrder(trader: TraderKey): void {
    const bot = isBotTrader(trader);
    (bot ? this.botCounters : this.userCounters).orders += 1;
    (bot ? this.botTraders : this.userTraders).add(trader);
  }

  /** Every trader key that has ever placed an order, for the liquidation scan. */
  allTraderKeys(): TraderKey[] {
    return [...this.userTraders, ...this.botTraders];
  }

  recordFill(fill: Fill, origin: FillOrigin): void {
    const notional = mulDivScale(fill.price, fill.size);
    const bucket = origin === "bot" ? this.botCounters : this.userCounters;
    bucket.fills += 1;
    bucket.volume += notional;
  }

  recordHttpLatency(sampleMs: number): void {
    this.httpLatencyMs.push(sampleMs);
    if (this.httpLatencyMs.length > this.latencyWindowSize) this.httpLatencyMs.shift();
  }

  snapshot(nowMs: number): PublicStats {
    const sorted = [...this.httpLatencyMs].sort((a, b) => a - b);
    return {
      user: { ...this.userCounters },
      bot: { ...this.botCounters },
      tradersTotal: this.userTraders.size + this.botTraders.size,
      latency: {
        medianMs: percentile(sorted, 0.5),
        p99Ms: percentile(sorted, 0.99),
        sampleSize: sorted.length,
        measuredFrom: "http:request",
      },
      updatedAtMs: nowMs,
    };
  }
}
