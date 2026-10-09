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

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
};

const MAX_CANDLES_PER_SERIES = 1_000;

interface Series {
  byBucketStart: Map<number, Candle>;
  order: number[];
}

/** Aggregates fills into OHLCV candles per market and interval from a plain timestamp, never a wall clock read. */
export class CandleAggregator {
  private readonly series = new Map<string, Series>();

  record(fill: Fill): void {
    const notional = mulDivScale(fill.price, fill.size);
    for (const interval of Object.keys(INTERVAL_MS) as CandleInterval[]) {
      this.recordInto(fill.market, interval, fill.timestampMs, fill.price, notional);
    }
  }

  private seriesFor(market: MarketId, interval: CandleInterval): Series {
    const key = `${market}:${interval}`;
    let series = this.series.get(key);
    if (!series) {
      series = { byBucketStart: new Map(), order: [] };
      this.series.set(key, series);
    }
    return series;
  }

  private recordInto(
    market: MarketId,
    interval: CandleInterval,
    timestampMs: number,
    price: bigint,
    notional: bigint,
  ): void {
    const bucketMs = INTERVAL_MS[interval];
    const startMs = Math.floor(timestampMs / bucketMs) * bucketMs;
    const series = this.seriesFor(market, interval);
    const existing = series.byBucketStart.get(startMs);
    if (existing) {
      existing.high = price > existing.high ? price : existing.high;
      existing.low = price < existing.low ? price : existing.low;
      existing.close = price;
      existing.volume += notional;
      return;
    }
    series.byBucketStart.set(startMs, {
      startMs,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: notional,
    });
    series.order.push(startMs);
    if (series.order.length > MAX_CANDLES_PER_SERIES) {
      const oldest = series.order.shift();
      if (oldest !== undefined) series.byBucketStart.delete(oldest);
    }
  }

  candles(market: MarketId, interval: CandleInterval, limit: number): Candle[] {
    const series = this.series.get(`${market}:${interval}`);
    if (!series) return [];
    const starts = [...series.order].sort((a, b) => a - b);
    return starts.slice(Math.max(0, starts.length - limit)).map((start) => series.byBucketStart.get(start)!);
  }

  exportSnapshot(): CandleSnapshotEntry[] {
    const entries: CandleSnapshotEntry[] = [];
    for (const [key, series] of this.series) {
      const [market, interval] = key.split(":") as [MarketId, CandleInterval];
      entries.push({
        market,
        interval,
        candles: [...series.order]
          .sort((a, b) => a - b)
          .map((start) => series.byBucketStart.get(start)!)
          .map((candle) => ({
            startMs: candle.startMs,
            open: toDecimalString(candle.open),
            high: toDecimalString(candle.high),
            low: toDecimalString(candle.low),
            close: toDecimalString(candle.close),
            volume: toDecimalString(candle.volume),
          })),
      });
    }
    return entries;
  }

  loadSnapshot(entries: CandleSnapshotEntry[]): void {
    for (const entry of entries) {
      const series = this.seriesFor(entry.market, entry.interval);
      for (const candle of entry.candles) {
        series.byBucketStart.set(candle.startMs, {
          startMs: candle.startMs,
          open: fromDecimalString(candle.open),
          high: fromDecimalString(candle.high),
          low: fromDecimalString(candle.low),
          close: fromDecimalString(candle.close),
          volume: fromDecimalString(candle.volume),
        });
        series.order.push(candle.startMs);
      }
    }
  }
}

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
