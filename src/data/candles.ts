import { fromDecimalString, mulDivScale, toDecimalString } from "../engine/money.js";
import type { Fill, MarketId } from "../engine/types.js";

export type CandleInterval = "1m" | "5m" | "15m" | "1h";

export interface Candle {
  startMs: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  volume: bigint;
}

/** A market's candles of one interval as the snapshot file holds them. */
export interface CandleSnapshotEntry {
  market: MarketId;
  interval: CandleInterval;
  candles: {
    startMs: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }[];
}

const MINUTE_MS = 60_000;

const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": MINUTE_MS,
  "5m": 5 * MINUTE_MS,
  "15m": 15 * MINUTE_MS,
  "1h": 60 * MINUTE_MS,
};

const INTERVALS = Object.keys(INTERVAL_MS) as CandleInterval[];

const MAX_CANDLES_PER_SERIES = 1_000;

/** One market's candles of one interval, by bucket start, in the order the buckets were opened. */
type Series = Map<number, Candle>;

const sortedByStart = (series: Series): Candle[] =>
  [...series.values()].sort((a, b) => a.startMs - b.startMs);

/** Aggregates fills into OHLCV candles per market and interval, by each fill's own timestamp. */
export class CandleAggregator {
  private readonly series = new Map<string, Series>();

  private seriesFor(market: MarketId, interval: CandleInterval): Series {
    const key = `${market}:${interval}`;
    let series = this.series.get(key);
    if (!series) {
      series = new Map();
      this.series.set(key, series);
    }
    return series;
  }

  record(fill: Fill): void {
    const notional = mulDivScale(fill.price, fill.size);
    for (const interval of INTERVALS) {
      const bucketMs = INTERVAL_MS[interval];
      const startMs = Math.floor(fill.timestampMs / bucketMs) * bucketMs;
      this.recordInto(this.seriesFor(fill.market, interval), startMs, fill.price, notional);
    }
  }

  private recordInto(series: Series, startMs: number, price: bigint, notional: bigint): void {
    const candle = series.get(startMs);
    if (candle) {
      candle.high = price > candle.high ? price : candle.high;
      candle.low = price < candle.low ? price : candle.low;
      candle.close = price;
      candle.volume += notional;
      return;
    }
    series.set(startMs, {
      startMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: notional,
    });
    if (series.size > MAX_CANDLES_PER_SERIES) {
      const [firstOpened] = series.keys();
      series.delete(firstOpened);
    }
  }

  /** The latest `limit` candles, oldest first. */
  candles(market: MarketId, interval: CandleInterval, limit: number): Candle[] {
    const series = this.series.get(`${market}:${interval}`);
    if (!series) return [];
    const candles = sortedByStart(series);
    return candles.slice(Math.max(0, candles.length - limit));
  }

  exportSnapshot(): CandleSnapshotEntry[] {
    return [...this.series].map(([key, series]) => {
      const [market, interval] = key.split(":") as [MarketId, CandleInterval];
      return {
        market,
        interval,
        candles: sortedByStart(series).map((candle) => ({
          startMs: candle.startMs,
          open: toDecimalString(candle.open),
          high: toDecimalString(candle.high),
          low: toDecimalString(candle.low),
          close: toDecimalString(candle.close),
          volume: toDecimalString(candle.volume),
        })),
      };
    });
  }

  loadSnapshot(entries: CandleSnapshotEntry[]): void {
    for (const entry of entries) {
      const series = this.seriesFor(entry.market, entry.interval);
      for (const candle of entry.candles) {
        series.set(candle.startMs, {
          startMs: candle.startMs,
          open: fromDecimalString(candle.open),
          high: fromDecimalString(candle.high),
          low: fromDecimalString(candle.low),
          close: fromDecimalString(candle.close),
          volume: fromDecimalString(candle.volume),
        });
      }
    }
  }
}
