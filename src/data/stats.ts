import { isBotTrader } from "../bots/bot-traders.js";
import { mulDivScale } from "../engine/money.js";
import type { Fill, TraderKey } from "../engine/types.js";
import { percentile } from "./percentile.js";

export type FillOrigin = "user" | "bot";

interface ActivityCounters {
  orders: number;
  fills: number;
  volume: bigint;
}

export interface LatencyStats {
  medianMs: number;
  p99Ms: number;
  sampleSize: number;
  measuredFrom: string;
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
interface UnknownOutcomes {
  total: number;
  settledExecutedLate: number;
  settledExpired: number;
  stillUnknown: number;
}

const emptyCounters = (): ActivityCounters => ({ orders: 0, fills: 0, volume: 0n });

const DEFAULT_LATENCY_WINDOW = 500;

/**
 * Bot and user activity in separate counters: the two are never merged into
 * one number. A fill names no trader, so whoever records one says whose it
 * was at the moment it is produced; it is never guessed afterwards.
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
    private readonly latencyWindowSize = DEFAULT_LATENCY_WINDOW,
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

  /** Every trader that has placed an order or been funded, for the liquidation scan. */
  allTraderKeys(): TraderKey[] {
    return [...this.userTraders, ...this.botTraders];
  }

  recordFill(fill: Fill, origin: FillOrigin): void {
    const counters = origin === "bot" ? this.botCounters : this.userCounters;
    counters.fills += 1;
    counters.volume += mulDivScale(fill.price, fill.size);
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
