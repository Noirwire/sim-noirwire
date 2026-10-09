import type { Clock } from "../engine/clock.js";
import { divScale, roundUpToTick } from "../engine/money.js";
import type { MarketId, MarketKind, Venue } from "../engine/types.js";
import { makerTraderKey } from "./bot-traders.js";

export interface HouseMakerOptions {
  market: MarketId;
  kind: MarketKind;
  baseToken: string;
  quoteToken: string;
  levels: number;
  spreadBps: number;
  levelStepBps: number;
  baseSizePerLevel: bigint;
  requoteThresholdBps: number;
  requoteIntervalMs: number;
  positionLimitNotional: bigint;
  maxSkewBps: number;
  lotSize: bigint;
  startingQuoteBalance: bigint;
  startingBaseBalance: bigint;
  clock: Clock;
}

/**
 * Keeps a ladder of limit orders on both sides of the mark price, shifting
 * away from its own accumulated inventory and skipping whichever side would
 * grow past its hard position limit. Requotes (cancel everything, then
 * place a fresh ladder) only when the price has moved past the threshold or
 * the requote interval has elapsed, so it does not churn the book every tick.
 */
export class HouseMaker {
  private readonly trader: string;
  private lastQuotedPrice: bigint | null = null;
  private lastQuotedAtMs = -Infinity;
  private startingBaseBalance = 0n;

  constructor(private readonly options: HouseMakerOptions) {
    this.trader = makerTraderKey(options.market);
  }

  traderKey(): string {
    return this.trader;
  }

  async ensureOpen(venue: Venue): Promise<void> {
    await venue.openTrader(this.trader);
    await venue.deposit(this.trader, this.options.quoteToken, this.options.startingQuoteBalance);
    if (this.options.kind === "spot") {
      await venue.deposit(this.trader, this.options.baseToken, this.options.startingBaseBalance);
      this.startingBaseBalance = this.options.startingBaseBalance;
    }
  }

  async tick(venue: Venue): Promise<void> {
    const markets = await venue.markets();
    const market = markets.find((m) => m.id === this.options.market);
    if (!market || market.markPrice === null) return;
    const mark = market.markPrice;

    const now = this.options.clock.nowMs();
    const movedEnoughBps =
      this.lastQuotedPrice === null
        ? Infinity
        : (Number(mark - this.lastQuotedPrice) / Number(this.lastQuotedPrice)) * 10_000;
    const dueForTimer = now - this.lastQuotedAtMs >= this.options.requoteIntervalMs;
    if (Math.abs(movedEnoughBps) < this.options.requoteThresholdBps && !dueForTimer) return;

    await venue.cancelAll(this.trader, this.options.market);

    const state = await venue.traderState(this.trader);
    const position =
      this.options.kind === "perp"
        ? (state.positions[this.options.market]?.size ?? 0n)
        : (state.balances[this.options.baseToken]?.balance ?? 0n) - this.startingBaseBalance;
    const positionLimit = divScale(this.options.positionLimitNotional, mark);
    const rawSkewFraction = positionLimit > 0n ? Number(position) / Number(positionLimit) : 0;
    const skewFraction = Math.max(-1, Math.min(1, rawSkewFraction));
    const skewBps = skewFraction * this.options.maxSkewBps;
    const center = mark - (mark * BigInt(Math.round(skewBps * 1_000))) / 10_000_000n;

    const quoteAllowed = {
      buy: position < positionLimit,
      sell: position > -positionLimit,
    };

    for (let level = 0; level < this.options.levels; level += 1) {
      const offsetBps = this.options.spreadBps + level * this.options.levelStepBps;
      const size = this.options.baseSizePerLevel * BigInt(level + 1);
      const roundedSize = size - (size % this.options.lotSize);
      if (roundedSize <= 0n) continue;

      if (quoteAllowed.buy) {
        const price = roundUpToTick(
          center - (center * BigInt(offsetBps)) / 10_000n,
          market.tickSize,
        );
        if (price > 0n) {
          await venue.placeOrder(this.trader, {
            market: this.options.market,
            side: "buy",
            type: "postOnly",
            price,
            size: roundedSize,
          });
        }
      }
      if (quoteAllowed.sell) {
        const price = roundUpToTick(
          center + (center * BigInt(offsetBps)) / 10_000n,
          market.tickSize,
        );
        await venue.placeOrder(this.trader, {
          market: this.options.market,
          side: "sell",
          type: "postOnly",
          price,
          size: roundedSize,
        });
      }
    }

    this.lastQuotedPrice = mark;
    this.lastQuotedAtMs = now;
  }
}
