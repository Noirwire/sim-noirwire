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
  botOrdersOutcomeUnknown: UnknownOutcomes;
}

/**
 * Bot orders whose outcome could not be told in time, and what became of
 * each once the venue's clock had passed its expiry. None of them is counted
 * in `bot.orders` until it has settled as executed.
 */
export interface UnknownOutcomes {
  total: number;
  settledExecutedLate: number;
  settledExpired: number;
  stillUnknown: number;
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
  private readonly latencyMs: number[] = [];
  private readonly unknown: UnknownOutcomes = {
    total: 0,
    settledExecutedLate: 0,
    settledExpired: 0,
    stillUnknown: 0,
  };

  constructor(
    private readonly latencyWindowSize = 500,
    private readonly latencyMeasuredFrom = "http:request",
  ) {}

  recordOrder(trader: TraderKey): void {
    (isBotTrader(trader) ? this.botCounters : this.userCounters).orders += 1;
    this.recordTrader(trader);
  }

  recordTrader(trader: TraderKey): void {
    (isBotTrader(trader) ? this.botTraders : this.userTraders).add(trader);
  }

  /**
   * For a venue where a user's order is private and only a public total is
   * known: the user count is that total less the bots' own orders.
   */
  setUserOrders(count: number): void {
    this.userCounters.orders = Math.max(0, count);
  }

  recordBotOrderUnknown(): void {
    this.unknown.total += 1;
    this.unknown.stillUnknown += 1;
  }

  recordBotOrderSettled(executedLate: boolean): void {
    this.unknown.stillUnknown -= 1;
    if (executedLate) this.unknown.settledExecutedLate += 1;
    else this.unknown.settledExpired += 1;
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

  recordLatency(sampleMs: number): void {
    this.latencyMs.push(sampleMs);
    if (this.latencyMs.length > this.latencyWindowSize) this.latencyMs.shift();
  }

  snapshot(nowMs: number): PublicStats {
    const sorted = [...this.latencyMs].sort((a, b) => a - b);
    return {
      user: { ...this.userCounters },
      bot: { ...this.botCounters },
      botOrdersOutcomeUnknown: { ...this.unknown },
      tradersTotal: this.userTraders.size + this.botTraders.size,
      latency: {
        medianMs: percentile(sorted, 0.5),
        p99Ms: percentile(sorted, 0.99),
        sampleSize: sorted.length,
        measuredFrom: this.latencyMeasuredFrom,
      },
      updatedAtMs: nowMs,
    };
  }
}
