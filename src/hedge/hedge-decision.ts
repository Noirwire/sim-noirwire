import {
  absBigInt,
  bpsOf,
  divScale,
  maxBigInt,
  minBigInt,
  mulDivScale,
  roundDownToStep,
  roundUpToStep,
} from "../engine/money.js";
import type { Reference } from "../prices/reference-price.js";
import type { HedgeMarketRules } from "./hedge-venue.js";

export interface HedgeInput {
  /** The maker's signed SOL position. */
  makerPosition: bigint;
  /** The hedge account's signed SOL position. */
  hedgePosition: bigint;
  /** The hedge account's margin in dollars. */
  equity: bigint;
  /** The most the hedge position may be, as a multiple of that margin. */
  maxLeverage: number;
  /** Unhedged exposure below this, in dollars, is left alone. */
  triggerNotional: bigint;
  rules: HedgeMarketRules;
  reference: Reference;
  /** How far through the reference price the order may fill. */
  priceBandBps: number;
  /** False while the maker is stopped or reducing: the hedge may then only shrink. */
  mayGrow: boolean;
}

export type HedgeHold =
  "no trusted price" | "hedged" | "below the trigger" | "below the venue minimum" | "margin cap";

export type HedgeDecision =
  | { action: "none"; reason: HedgeHold; detail?: string }
  | {
      action: "order";
      side: "buy" | "sell";
      size: bigint;
      limitPrice: bigint;
      reduceOnly: boolean;
    };

const hold = (reason: HedgeHold, detail?: string): HedgeDecision => ({
  action: "none",
  reason,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * What to send to the hedge venue: nothing, or one order that works the
 * unhedged exposure (the maker's position plus the hedge position) toward
 * zero. The size is cut to the venue's increment and to what the margin
 * allows the hedge position to grow to, and an order under the venue's
 * minimum notional is not sent, so small differences add up until one is
 * worth sending. Nothing is sent without a trusted price.
 */
export const decideHedge = (input: HedgeInput): HedgeDecision => {
  const { makerPosition, hedgePosition, rules, reference } = input;
  if (!reference.ok) return hold("no trusted price", reference.reason);
  const price = reference.price;
  const unhedged = makerPosition + hedgePosition;
  if (unhedged === 0n) return hold("hedged");

  const trigger = maxBigInt(input.triggerNotional, rules.minOrderNotional);
  if (mulDivScale(absBigInt(unhedged), price) < trigger) return hold("below the trigger");

  const room = input.mayGrow ? growthRoom(input, price) : 0n;
  // The hedge position that would cancel the maker's, held inside what the margin allows. A
  // position already past that allowance may only shrink, never grow.
  const lowest = minBigInt(-room, hedgePosition);
  const highest = maxBigInt(room, hedgePosition);
  const reachable = maxBigInt(lowest, minBigInt(highest, -makerPosition));
  const delta = reachable - hedgePosition;
  const size = roundDownToStep(absBigInt(delta), rules.sizeIncrement);
  if (size <= 0n) return hold(delta === 0n ? "margin cap" : "below the venue minimum");
  if (mulDivScale(size, price) < rules.minOrderNotional) return hold("below the venue minimum");

  const side = delta > 0n ? "buy" : "sell";
  const band = bpsOf(price, input.priceBandBps);
  const limitPrice =
    side === "buy"
      ? roundDownToStep(price + band, rules.priceIncrement)
      : roundUpToStep(price - band, rules.priceIncrement);
  if (limitPrice <= 0n) return hold("no trusted price", "the price band leaves no valid limit");
  const reduceOnly =
    (hedgePosition > 0n && side === "sell" && size <= hedgePosition) ||
    (hedgePosition < 0n && side === "buy" && size <= -hedgePosition);
  return { action: "order", side, size, limitPrice, reduceOnly };
};

/** The most SOL the hedge position may reach, either way, at the account's margin and leverage cap. */
const growthRoom = (input: HedgeInput, price: bigint): bigint =>
  input.equity > 0n ? divScale(input.equity * BigInt(input.maxLeverage), price) : 0n;
