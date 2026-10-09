import { describe, expect, it } from "vitest";
import { CandleAggregator } from "../src/data/candles.js";
import type { Fill } from "../src/engine/types.js";

const makeFill = (timestampMs: number, price: bigint, sequence: number): Fill => ({
  market: "NSOL-NUSD",
  price,
  size: 1_000_000n,
  takerSide: "buy",
  takerTag: 1n,
  makerTag: 2n,
  timestampMs,
  sequence,
});

describe("CandleAggregator", () => {
  it("buckets a fill into the 1m interval it falls in, by start time, not arrival order", () => {
    const candles = new CandleAggregator();
    const oneMinuteMs = 60_000;

    candles.record(makeFill(oneMinuteMs * 10, 100_000000n, 1));
    candles.record(makeFill(oneMinuteMs * 10 + 59_999, 110_000000n, 2));
    candles.record(makeFill(oneMinuteMs * 11, 120_000000n, 3));

    const result = candles.candles("NSOL-NUSD", "1m", 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.startMs).toBe(oneMinuteMs * 10);
    expect(result[0]!.open).toBe(100_000000n);
    expect(result[0]!.close).toBe(110_000000n);
    expect(result[0]!.high).toBe(110_000000n);
    expect(result[1]!.startMs).toBe(oneMinuteMs * 11);
    expect(result[1]!.open).toBe(120_000000n);
  });

  it("a fill exactly on a 5m boundary opens a new bucket rather than extending the previous one", () => {
    const candles = new CandleAggregator();
    const fiveMinutesMs = 5 * 60_000;

    candles.record(makeFill(fiveMinutesMs * 3 - 1, 100_000000n, 1));
    candles.record(makeFill(fiveMinutesMs * 3, 200_000000n, 2));

    const result = candles.candles("NSOL-NUSD", "5m", 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.startMs).toBe(fiveMinutesMs * 2);
    expect(result[1]!.startMs).toBe(fiveMinutesMs * 3);
    expect(result[1]!.open).toBe(200_000000n);
  });

  it("tracks high and low correctly within one bucket regardless of arrival order", () => {
    const candles = new CandleAggregator();
    candles.record(makeFill(0, 100_000000n, 1));
    candles.record(makeFill(10_000, 90_000000n, 2));
    candles.record(makeFill(20_000, 105_000000n, 3));
    candles.record(makeFill(30_000, 95_000000n, 4));

    const [candle] = candles.candles("NSOL-NUSD", "1m", 1);
    expect(candle!.high).toBe(105_000000n);
    expect(candle!.low).toBe(90_000000n);
    expect(candle!.close).toBe(95_000000n);
    expect(candle!.open).toBe(100_000000n);
  });

  it("round-trips through a snapshot export and load", () => {
    const candles = new CandleAggregator();
    candles.record(makeFill(0, 100_000000n, 1));
    candles.record(makeFill(60_000, 101_500000n, 2));

    const snapshot = candles.exportSnapshot();
    const restored = new CandleAggregator();
    restored.loadSnapshot(snapshot);

    const original = candles.candles("NSOL-NUSD", "1h", 10);
    const roundTripped = restored.candles("NSOL-NUSD", "1h", 10);
    expect(roundTripped).toEqual(original);
  });
});
