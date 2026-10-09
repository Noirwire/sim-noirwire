import { toDecimalString } from "../engine/money.js";

export const money = (value: bigint): string => toDecimalString(value);

export const moneyOrNull = (value: bigint | null): string | null =>
  value === null ? null : toDecimalString(value);

export const tagString = (tag: bigint): string => tag.toString();
