import type { Candle } from "../data/candles.js";
import { toDecimalString } from "../engine/money.js";
import type { Fill } from "../engine/types.js";

/** Every price, size and balance leaves as a plain decimal string, never a float or a raw bigint. */
export const money = (value: bigint): string => toDecimalString(value);

export const moneyOrNull = (value: bigint | null): string | null =>
  value === null ? null : toDecimalString(value);

export const tagString = (tag: bigint): string => tag.toString();

export const serializeFill = (fill: Fill) => ({
  market: fill.market,
  price: money(fill.price),
  size: money(fill.size),
  takerSide: fill.takerSide,
  takerTag: tagString(fill.takerTag),
  makerTag: tagString(fill.makerTag),
  timestampMs: fill.timestampMs,
  sequence: fill.sequence,
});

export const serializeCandle = (candle: Candle) => ({
  startMs: candle.startMs,
  open: money(candle.open),
  high: money(candle.high),
  low: money(candle.low),
  close: money(candle.close),
  volume: money(candle.volume),
});
