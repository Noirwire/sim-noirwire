import type { Clock } from "../engine/clock.js";
import { bpsOf, roundDownToTick, roundUpToTick } from "../engine/money.js";
import type { MarketId, Venue } from "../engine/types.js";
import { takerTraderKey } from "./bot-traders.js";
import type { SeededRandom } from "./rng.js";

export interface NoiseTakerOptions {
  market: MarketId;
  baseToken: string;
  traderCount: number;
  minSize: bigint;
  maxSize: bigint;
  lotSize: bigint;
  minIntervalMs: number;
  maxIntervalMs: number;
  worstPriceSlippageBps: number;
  startingBalanceQuote: bigint;
  startingBalanceBase: bigint;
  clock: Clock;
  random: SeededRandom;
}

/**
 * A small pool of bot traders that send occasional, randomly sized market
 * orders so the tape keeps moving between house-maker requotes. Every
 * decision (which trader, which side, how big, how long to wait next) comes
 * from the injected seeded random generator, so a test run is reproducible.
 */
export class NoiseTaker {
  private nextDueAtMs = -Infinity;
  private readonly traders: string[];
  private readonly opened = new Set<string>();

  constructor(private readonly options: NoiseTakerOptions) {
    this.traders = Array.from({ length: options.traderCount }, (_, i) => takerTraderKey(i));
  }

  async tick(venue: Venue): Promise<void> {
    const now = this.options.clock.nowMs();
    if (now < this.nextDueAtMs) return;

    const trader = this.options.random.pick(this.traders);
    if (!this.opened.has(trader)) {
      await venue.openTrader(trader);
      await venue.deposit(trader, "nUSD", this.options.startingBalanceQuote);
      await venue.deposit(trader, this.options.baseToken, this.options.startingBalanceBase);
      this.opened.add(trader);
    }

    const markets = await venue.markets();
    const market = markets.find((m) => m.id === this.options.market);
    if (market?.markPrice) {
      const side = this.options.random.nextBool() ? "buy" : "sell";
      const span = this.options.maxSize - this.options.minSize;
      const raw =
        this.options.minSize +
        BigInt(this.options.random.nextInt(0, Number(span / this.options.lotSize))) *
          this.options.lotSize;
      const size = raw < this.options.lotSize ? this.options.lotSize : raw;
      const slippage = bpsOf(market.markPrice, this.options.worstPriceSlippageBps);
      const rawWorstPrice =
        side === "buy"
          ? market.markPrice + slippage
          : market.markPrice > slippage
            ? market.markPrice - slippage
            : market.tickSize;
      const worstPrice =
        side === "buy"
          ? roundUpToTick(rawWorstPrice, market.tickSize)
          : roundDownToTick(rawWorstPrice, market.tickSize);

      await venue.placeOrder(trader, {
        market: this.options.market,
        side,
        type: "market",
        price: worstPrice,
        size,
      });
    }

    const waitMs = this.options.random.nextInt(
      this.options.minIntervalMs,
      this.options.maxIntervalMs,
    );
    this.nextDueAtMs = now + waitMs;
  }
}
