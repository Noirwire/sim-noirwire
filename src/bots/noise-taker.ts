import type { Clock } from "../engine/clock.js";
import { bpsOf, roundDownToStep, roundUpToStep } from "../engine/money.js";
import type { MarketId, MarketInfo, NewOrder, TraderKey, Venue } from "../engine/types.js";
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
  startingQuoteBalance: bigint;
  startingBaseBalance: bigint;
  clock: Clock;
  random: SeededRandom;
}

/**
 * A small pool of bot traders that send occasional, randomly sized market
 * orders so the tape keeps moving between the house maker's requotes. Every
 * decision (which trader, which side, how big, how long to wait) comes from
 * the injected seeded random generator, so a run is reproducible.
 */
export class NoiseTaker {
  private nextDueAtMs = -Infinity;
  private readonly traders: TraderKey[];
  private readonly opened = new Set<TraderKey>();

  constructor(private readonly options: NoiseTakerOptions) {
    this.traders = Array.from({ length: options.traderCount }, (_, i) => takerTraderKey(i));
  }

  private async ensureOpen(venue: Venue, trader: TraderKey): Promise<void> {
    if (this.opened.has(trader)) return;
    await venue.openTrader(trader);
    await venue.deposit(trader, "nUSD", this.options.startingQuoteBalance);
    await venue.deposit(trader, this.options.baseToken, this.options.startingBaseBalance);
    this.opened.add(trader);
  }

  /** A market order of random side and size, with a worst price a slippage away from the mark. */
  private randomOrder(mark: bigint, tickSize: bigint): NewOrder {
    const { market, minSize, maxSize, lotSize, worstPriceSlippageBps, random } = this.options;
    const side = random.nextBool() ? "buy" : "sell";
    const lotsAboveMin = random.nextInt(0, Number((maxSize - minSize) / lotSize));
    const size = minSize + BigInt(lotsAboveMin) * lotSize;
    const slippage = bpsOf(mark, worstPriceSlippageBps);
    const worstPrice =
      side === "buy"
        ? roundUpToStep(mark + slippage, tickSize)
        : roundDownToStep(mark > slippage ? mark - slippage : tickSize, tickSize);
    return {
      market,
      side,
      type: "market",
      price: worstPrice,
      size: size < lotSize ? lotSize : size,
    };
  }

  async tick(venue: Venue): Promise<void> {
    const { market, minIntervalMs, maxIntervalMs, clock, random } = this.options;
    const now = clock.nowMs();
    if (now < this.nextDueAtMs) return;

    const trader = random.pick(this.traders);
    await this.ensureOpen(venue, trader);

    const info: MarketInfo | undefined = (await venue.markets()).find((m) => m.id === market);
    if (info?.markPrice)
      await venue.placeOrder(trader, this.randomOrder(info.markPrice, info.tickSize));

    this.nextDueAtMs = now + random.nextInt(minIntervalMs, maxIntervalMs);
  }
}
