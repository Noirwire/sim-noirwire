import { DAY_MS, DayVolume, PriceHistory, percentChange } from "../engine/day-window.js";
import { type MarketConfig, maxLeverageAt } from "../engine/markets.js";
import type { Fill, MarketInfo } from "../engine/types.js";
import type { ChainExchange, ChainFill, ChainMarket, ChainPrice } from "./chain-types.js";
import { type MarketUnits, marketUnits, toSimPrice, toSimSize } from "./units.js";

const MS_PER_SECOND = 1_000;

const tagOf = (receipt: Uint8Array): bigint => Buffer.from(receipt).readBigUInt64BE(0);

/** One market as the chain shows it. Its mark is the chain's own: this service never sets it. */
export class RollupMarket {
  readonly units: MarketUnits;
  /** The last fill sequence read from the tape. */
  tapeCursor = 0;
  private chainPrice: ChainPrice | null = null;
  private readonly volume = new DayVolume();
  private readonly priceHistory = new PriceHistory(DAY_MS);

  constructor(
    readonly config: MarketConfig,
    /** As last read: its status and oracle health change while it is followed. */
    public chain: ChainMarket,
    baseDecimals: number,
  ) {
    this.units = marketUnits(chain.baseLot, baseDecimals);
  }

  /** Takes a fresh reading of the market account. Its lot never changes, so neither do the units. */
  acceptMarket(reading: ChainMarket): void {
    if (reading.marketId === this.chain.marketId) this.chain = reading;
  }

  /** The chain's mark in the program's units, or 0 while the feed has none. */
  get mark(): bigint {
    return this.chainPrice?.price ?? 0n;
  }

  get publishTimeSeconds(): number {
    return this.chainPrice?.publishTimeSeconds ?? 0;
  }

  /**
   * Takes a reading of the price feed. Returns the price to announce when it
   * is news: a changed, non-zero price.
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
    if (!changed || reading.price === 0n) return null;
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

  /** Whether the chain holds a mark the program still calls fresh. */
  priceIsFresh(nowMs: number): boolean {
    const maxAgeMs = this.chain.maxPriceAgeSeconds * MS_PER_SECOND;
    return this.mark > 0n && nowMs - this.publishTimeSeconds * MS_PER_SECOND < maxAgeMs;
  }

  /**
   * Why the program would refuse a resting order that adds exposure here now,
   * by the checks it makes before any seat's own: or null while it takes one.
   * `exchange` is null until the exchange has been read.
   */
  quotesRefusedBecause(nowMs: number, exchange: ChainExchange | null): string | null {
    return this.refusal(nowMs, exchange, false);
  }

  /**
   * Whether the market is reduce-only and nothing else stands in the way of a
   * reduce-only order: not paused, its mark fresh and in line with the oracle.
   */
  takesReduceOnlyOrders(nowMs: number, exchange: ChainExchange | null): boolean {
    return this.chain.status === "reduceOnly" && this.refusal(nowMs, exchange, true) === null;
  }

  private refusal(
    nowMs: number,
    exchange: ChainExchange | null,
    allowReduceOnly: boolean,
  ): string | null {
    const { chain } = this;
    if (exchange?.paused) return "the exchange is paused (ExchangePaused, 6030)";
    if (chain.status === "paused") return "the market is paused (MarketPaused, 6031)";
    if (chain.status === "reduceOnly" && !allowReduceOnly) {
      return "the market takes reduce-only orders alone (MarketReduceOnly, 6032)";
    }
    if (chain.oracleHealth === "dislocated") {
      return "its mark is dislocated from the oracle (OracleDislocated, 6077)";
    }
    if (this.mark === 0n) return "its price feed holds no mark yet";
    if (!this.priceIsFresh(nowMs)) {
      const ageSeconds = Math.floor(nowMs / MS_PER_SECOND) - this.publishTimeSeconds;
      return (
        `its mark is ${ageSeconds} s old and the market takes one up to ` +
        `${chain.maxPriceAgeSeconds} s old (StalePrice, 6038): is the price crank running?`
      );
    }
    const guardUntil = exchange?.quoteGuardOkUntilSeconds ?? null;
    if (chain.kind === "perp" && guardUntil !== null && nowMs > guardUntil * MS_PER_SECOND) {
      return (
        `the USDC guard tripped at ${new Date(guardUntil * MS_PER_SECOND).toISOString()} ` +
        "(QuoteGuardTripped, 6081): is the USDC price synced?"
      );
    }
    return null;
  }

  info(nowMs: number, openInterestLots: bigint | null, exchange: ChainExchange | null): MarketInfo {
    const { config, chain, units } = this;
    const isPerp = chain.kind === "perp";
    const markPrice = this.mark > 0n ? toSimPrice(units, this.mark) : null;
    const refused = this.quotesRefusedBecause(nowMs, exchange);
    return {
      id: config.id,
      kind: config.kind,
      base: config.base,
      quote: config.quote,
      tickSize: toSimPrice(units, chain.tick),
      lotSize: toSimSize(units, 1n),
      maxLeverage: isPerp ? maxLeverageAt(chain.initialMarginBps) : 0,
      markPrice,
      markPriceUpdatedAtMs: markPrice ? this.publishTimeSeconds * MS_PER_SECOND : null,
      change24h: markPrice
        ? percentChange(this.priceHistory.firstSince(nowMs - DAY_MS), markPrice)
        : null,
      volume24h: this.volume.total(nowMs),
      openInterest: isPerp && openInterestLots !== null ? toSimSize(units, openInterestLots) : null,
      ...(refused === null ? {} : { quotesRefusedBecause: refused }),
      ...(this.takesReduceOnlyOrders(nowMs, exchange) ? { takesReduceOnlyOrders: true } : {}),
      ...(isPerp ? { positionCap: toSimSize(units, chain.positionCap) } : {}),
    };
  }
}
