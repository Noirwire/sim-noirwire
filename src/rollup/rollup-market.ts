import { DAY_MS, DayVolume, PriceHistory, percentChange } from "../engine/day-window.js";
import { type MarketConfig, maxLeverageAt } from "../engine/markets.js";
import type { Fill, MarketInfo } from "../engine/types.js";
import type { ChainFill, ChainMarket, ChainPrice } from "./chain-types.js";
import { type PriceStep, nextPublishPrice, withinOneStep } from "./price-walk.js";
import {
  type MarketUnits,
  marketUnits,
  roundDownToChainPrice,
  toSimPrice,
  toSimSize,
} from "./units.js";

const MS_PER_SECOND = 1_000;

const tagOf = (receipt: Uint8Array): bigint => Buffer.from(receipt).readBigUInt64BE(0);

/** One market as the chain shows it, and where this service wants its price to be. */
export class RollupMarket {
  readonly units: MarketUnits;
  /** The last fill sequence read from the tape. */
  tapeCursor = 0;
  private chainPrice: ChainPrice | null = null;
  private target: bigint | null = null;
  private warmedUp = false;
  private readonly volume = new DayVolume();
  private readonly priceHistory = new PriceHistory(DAY_MS);

  constructor(
    readonly config: MarketConfig,
    readonly chain: ChainMarket,
    baseDecimals: number,
  ) {
    this.units = marketUnits(chain.baseLot, baseDecimals);
  }

  /** The chain's mark in the program's units, or 0 while the feed has none. */
  get mark(): bigint {
    return this.chainPrice?.price ?? 0n;
  }

  get publishTimeSeconds(): number {
    return this.chainPrice?.publishTimeSeconds ?? 0;
  }

  /**
   * True until the chain's price has first come within one allowed step of
   * the real one. A deployment starts at its set-up price and is walked to
   * the real price under the move limit; nothing on that walk is a market
   * move, so nothing of it is charted, counted or traded on by the bots.
   */
  get warmingUp(): boolean {
    return !this.warmedUp;
  }

  private step(): PriceStep | null {
    if (this.target === null || this.chainPrice === null) return null;
    return {
      current: this.chainPrice.price,
      target: roundDownToChainPrice(this.units, this.target, this.chain.tick),
      maxMoveBps: this.chain.maxMoveBps,
      tick: this.chain.tick,
    };
  }

  private noteWarmUp(): void {
    const step = this.step();
    if (!this.warmedUp && step) this.warmedUp = withinOneStep(step);
  }

  /** Where the mark should be, as this service prices it. */
  setTarget(price: bigint): void {
    this.target = price;
    this.noteWarmUp();
  }

  /** The price to publish next on the way to the target, or null when there is nothing to publish. */
  nextPublishPrice(): bigint | null {
    const step = this.step();
    const price = step ? nextPublishPrice(step) : 0n;
    return price === 0n ? null : price;
  }

  /**
   * Takes a reading of the price feed. Returns the price to announce when it
   * is news: a changed price on a market that has warmed up.
   */
  acceptPrice(reading: ChainPrice): { price: bigint; atMs: number } | null {
    const before = this.chainPrice;
    // A plain read and a notification race: the older picture can arrive last.
    if (before && reading.publishTimeSeconds < before.publishTimeSeconds) return null;
    const changed =
      !before ||
      before.price !== reading.price ||
      before.publishTimeSeconds !== reading.publishTimeSeconds;
    this.chainPrice = reading;
    this.noteWarmUp();
    if (!changed || reading.price === 0n || !this.warmedUp) return null;
    const point = {
      price: toSimPrice(this.units, reading.price),
      atMs: reading.publishTimeSeconds * MS_PER_SECOND,
    };
    this.priceHistory.add(point.atMs, point.price);
    return point;
  }

  /** Takes a fill read from the tape, in sequence order. */
  acceptFill(chainFill: ChainFill): Fill {
    const sequence = Number(chainFill.sequence);
    this.tapeCursor = Math.max(this.tapeCursor, sequence);
    const timestampMs = chainFill.timeSeconds * MS_PER_SECOND;
    this.volume.add(timestampMs, chainFill.price * chainFill.size);
    return {
      market: this.config.id,
      price: toSimPrice(this.units, chainFill.price),
      size: toSimSize(this.units, chainFill.size),
      takerSide: chainFill.takerSide,
      takerTag: tagOf(chainFill.takerReceipt),
      makerTag: tagOf(chainFill.makerReceipt),
      timestampMs,
      sequence,
    };
  }

  /** Whether the chain holds a price that this process published within the program's age limit. */
  priceIsFresh(nowMs: number, lastPublishedAtMs: number): boolean {
    const maxAgeMs = this.chain.maxPriceAgeSeconds * MS_PER_SECOND;
    return (
      this.warmedUp &&
      this.mark > 0n &&
      nowMs - lastPublishedAtMs < maxAgeMs &&
      nowMs - this.publishTimeSeconds * MS_PER_SECOND < maxAgeMs
    );
  }

  info(nowMs: number, openInterestLots: bigint | null): MarketInfo {
    const { config, chain, units } = this;
    const isPerp = chain.kind === "perp";
    const markPrice = this.mark > 0n ? toSimPrice(units, this.mark) : null;
    return {
      id: config.id,
      kind: config.kind,
      base: config.base,
      quote: config.quote,
      tickSize: toSimPrice(units, chain.tick),
      lotSize: toSimSize(units, 1n),
      maxLeverage: isPerp ? maxLeverageAt(chain.initialMarginBps) : 0,
      markPrice,
      warmingUp: this.warmingUp,
      markPriceUpdatedAtMs: markPrice ? this.publishTimeSeconds * MS_PER_SECOND : null,
      change24h: markPrice
        ? percentChange(this.priceHistory.firstSince(nowMs - DAY_MS), markPrice)
        : null,
      volume24h: this.volume.total(nowMs),
      openInterest: isPerp && openInterestLots !== null ? toSimSize(units, openInterestLots) : null,
    };
  }
}
