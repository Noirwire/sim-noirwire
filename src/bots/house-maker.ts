import type { Clock } from "../engine/clock.js";
import {
  BPS_PER_WHOLE,
  absBigInt,
  bpsOf,
  divScale,
  maxBigInt,
  minBigInt,
  roundDownToStep,
  roundUpToStep,
} from "../engine/money.js";
import type {
  MarketId,
  MarketInfo,
  MarketKind,
  NewOrder,
  TraderKey,
  TraderState,
  Venue,
} from "../engine/types.js";
import { ORDER_EXPIRY_TOO_NEAR } from "../engine/venue-orders.js";
import { VenueNotReady } from "../engine/venue-not-ready.js";
import { firstLine } from "../logging/first-line.js";
import { withinDeadline } from "../scheduling/deadline.js";
import { makerTraderKey } from "./bot-traders.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import type { MakerSafety, Plan } from "./maker-safety.js";
import { type MakerLedger, StatePersistenceError, type UnresolvedHold } from "./maker-state.js";

export interface HouseMakerOptions {
  market: MarketId;
  kind: MarketKind;
  baseToken: string;
  quoteToken: string;
  levels: number;
  spreadBps: number;
  levelStepBps: number;
  baseSizePerLevel: bigint;
  requoteThresholdBps: number;
  requoteIntervalMs: number;
  positionLimitNotional: bigint;
  maxSkewBps: number;
  lotSize: bigint;
  startingQuoteBalance: bigint;
  startingBaseBalance: bigint;
  clock: Clock;
  /** The risk rules. Without them the maker quotes around the venue's mark and never stops by itself. */
  safety?: MakerSafety;
  /** What the maker keeps across a restart. Without it, it remembers nothing. */
  ledger?: MakerLedger;
  /** Called after each requote that sent every order. It must not throw or wait: a heartbeat to an outside monitor. */
  afterRequote?: () => void;
  /** How long a cancel may take before it counts as unconfirmed. */
  cancelDeadlineMs?: number;
}

/** A cancel the venue has not answered in this long is unconfirmed: the quotes may still stand. */
export const CANCEL_DEADLINE_MS = 15_000;

/** The skew is applied in thousandths of a basis point, so a small inventory still moves the centre. */
const SKEW_PRECISION = 1_000;

export interface Ladder {
  /** The price the ladder is centred on: the venue's mark, or the reference price where the maker has one. */
  mark: bigint;
  tickSize: bigint;
  /** Signed inventory in base units: positive when long. */
  position: bigint;
  positionLimit: bigint;
  /**
   * The venue's own cap, where it has one: the position on a side, the open
   * orders there and a new order together may not pass it.
   */
  positionCap?: bigint;
  /**
   * The least any quote may sit away from `mark`, skew included. Without it a
   * strong skew can carry the reducing side through the price it centres on.
   */
  minEdgeBps?: number;
}

type LadderShape = Pick<
  HouseMakerOptions,
  "market" | "levels" | "spreadBps" | "levelStepBps" | "baseSizePerLevel" | "maxSkewBps" | "lotSize"
>;

/** The venue would refuse the maker's quotes: it keeps the ones resting and sends nothing. */
export class QuotesHeld extends Error {
  constructor(market: MarketId, reason: string) {
    super(`${market} quotes held, nothing sent: ${reason}`);
    this.name = "QuotesHeld";
  }
}

/** The venue answered an order with a refusal the maker does not recognise as routine. */
export class OrderRefused extends Error {
  constructor(market: MarketId, reason: string | undefined) {
    super(`${market} order refused by the venue: ${reason || "no reason given"}`);
    this.name = "OrderRefused";
  }
}

/**
 * How long an order of unknown outcome that has no expiry of its own is held for by a maker that has
 * no ledger to record an operator's review in. With a ledger such an order holds the maker until the
 * operator has looked.
 */
export const UNKNOWN_ORDER_QUARANTINE_MS = 60_000;

/** The unknown orders a hold remembers by name. */
const HELD_ORDER_IDS = 5;

/** When a hold lasts to once another order joins it: the later expiry, and never bounded if either is not. */
const mergedExpiry = (hold: UnresolvedHold | null, untilMs: number | null): number | null => {
  if (hold === null) return untilMs;
  if (hold.untilMs === null || untilMs === null) return null;
  return Math.max(hold.untilMs, untilMs);
};

/**
 * When an order sent with the absolute expiry `expiresAtMs` can no longer fill, by the host's clock. The
 * chain takes whole seconds and expires an order only once its time is past that second, so the order
 * is live to the end of it, and the host clock may be ahead of the chain's by the skew allowance.
 */
export const holdLapsesAtMs = (expiresAtMs: number): number =>
  (Math.floor(expiresAtMs / 1_000) + 1) * 1_000 + MAKER_LIMITS.chainClockSkewMs;

/** An order may have been executed although the venue never said so: the maker sends nothing until it has looked. */
export class OrderOutcomeUnknown extends Error {
  constructor(market: MarketId, reason: string | undefined) {
    super(`${market} order outcome unknown: ${reason || "no reason given"}`);
    this.name = "OrderOutcomeUnknown";
  }
}

/** A post-only order that would have taken from the book: the one refusal a quoting maker expects now and then. */
const ROUTINE_REFUSAL = /would (match|cross)/;

/** A reduce-only order that found nothing to reduce: a user filled the position first, which is no problem. */
const NOTHING_TO_REDUCE = /no position to reduce|ReduceOnlyWouldIncrease/;

const isRoutineRefusal = (order: NewOrder, reason: string | undefined): boolean =>
  ROUTINE_REFUSAL.test(reason ?? "") ||
  (order.reduceOnly === true && NOTHING_TO_REDUCE.test(reason ?? ""));

/** `size` where a side that already reaches `reach` has room for a whole level under the cap, else nothing. */
const fitUnderCap = (positionCap: bigint | undefined, reach: bigint, size: bigint): bigint =>
  positionCap === undefined || positionCap - reach >= size ? size : 0n;

/**
 * The quotes for one requote, nearest level first, bid before ask. Every level
 * holds `baseSizePerLevel`. The centre shifts away from the inventory by up to
 * `maxSkewBps` at the position limit. The position and a side's resting
 * levels together never pass the limit: a level that would is cut down to what
 * is left, and later levels are left out. Where the venue caps a side's
 * position and open orders together, each side's levels stop at the last whole
 * one that fits under that cap.
 */
export const ladderOrders = (shape: LadderShape, ladder: Ladder): NewOrder[] => {
  const { mark, tickSize, position, positionLimit, positionCap, minEdgeBps } = ladder;
  const boundedPosition =
    positionLimit > 0n ? maxBigInt(-positionLimit, minBigInt(position, positionLimit)) : 0n;
  const skewMilliBps =
    positionLimit > 0n
      ? (boundedPosition * BigInt(Math.round(shape.maxSkewBps * SKEW_PRECISION))) / positionLimit
      : 0n;
  const center = mark - (mark * skewMilliBps) / (BPS_PER_WHOLE * BigInt(SKEW_PRECISION));
  // Rounded up, so the edge is never a unit short of what was asked.
  const minEdge =
    minEdgeBps === undefined
      ? null
      : (mark * BigInt(minEdgeBps) + BPS_PER_WHOLE - 1n) / BPS_PER_WHOLE;
  const withEdge = (side: NewOrder["side"], price: bigint): bigint => {
    if (minEdge === null) return price;
    return side === "buy" ? minBigInt(price, mark - minEdge) : maxBigInt(price, mark + minEdge);
  };
  const quote = (side: NewOrder["side"], price: bigint, size: bigint): NewOrder => {
    const edged = withEdge(side, price);
    return {
      market: shape.market,
      side,
      type: "postOnly",
      // A price off the tick moves away from the market, so the spread is never narrower than asked.
      price: side === "buy" ? roundDownToStep(edged, tickSize) : roundUpToStep(edged, tickSize),
      size,
    };
  };

  const orders: NewOrder[] = [];
  let bidReach = position > 0n ? position : 0n;
  let askReach = position < 0n ? -position : 0n;
  // How much more each side may grow the position before it reaches the limit, resting orders counted.
  let bidRoom = positionLimit - position;
  let askRoom = positionLimit + position;
  for (let level = 0; level < shape.levels; level += 1) {
    const offset = bpsOf(center, shape.spreadBps + level * shape.levelStepBps);
    const size = roundDownToStep(shape.baseSizePerLevel, shape.lotSize);
    if (size <= 0n) continue;
    const bidSize = minBigInt(
      fitUnderCap(positionCap, bidReach, size),
      roundDownToStep(maxBigInt(bidRoom, 0n), shape.lotSize),
    );
    const bid = quote("buy", center - offset, bidSize);
    if (bidSize > 0n && bid.price !== undefined && bid.price > 0n) {
      orders.push(bid);
      bidReach += bidSize;
      bidRoom -= bidSize;
    }
    const askSize = minBigInt(
      fitUnderCap(positionCap, askReach, size),
      roundDownToStep(maxBigInt(askRoom, 0n), shape.lotSize),
    );
    if (askSize > 0n) {
      orders.push(quote("sell", center + offset, askSize));
      askReach += askSize;
      askRoom -= askSize;
    }
  }
  return orders;
};

/**
 * The one order that works `position` down to flat: reduce-only, for the whole
 * position, at a price `giveBps` through `centre` and no further. It crosses
 * whatever rests inside that price and waits for the rest, so the maker pays
 * at most `giveBps` to get out and never chases a price beyond it.
 */
export const flattenOrders = (
  shape: Pick<LadderShape, "market" | "lotSize">,
  flat: { centre: bigint; tickSize: bigint; position: bigint; giveBps: number },
): NewOrder[] => {
  const { centre, tickSize, position, giveBps } = flat;
  const size = roundDownToStep(absBigInt(position), shape.lotSize);
  if (size <= 0n) return [];
  const give = bpsOf(centre, giveBps);
  const selling = position > 0n;
  const price = selling
    ? roundUpToStep(centre - give, tickSize)
    : roundDownToStep(centre + give, tickSize);
  if (price <= 0n) return [];
  return [
    {
      market: shape.market,
      side: selling ? "sell" : "buy",
      type: "limit",
      price,
      size,
      reduceOnly: true,
    },
  ];
};

/**
 * The orders that shrink `position` and no others: the side opposite to it,
 * nearest level first, together never more than the position itself, so
 * filling them all brings the maker to flat and not past it.
 */
export const onlyReducing = (orders: NewOrder[], position: bigint, lotSize: bigint): NewOrder[] => {
  const side: NewOrder["side"] | null = position > 0n ? "sell" : position < 0n ? "buy" : null;
  let room = roundDownToStep(absBigInt(position), lotSize);
  const kept: NewOrder[] = [];
  for (const order of orders) {
    if (order.side !== side || room <= 0n) continue;
    const size = minBigInt(order.size, room);
    kept.push({ ...order, size });
    room -= size;
  }
  return kept;
};

type Quoting = Extract<Plan, { action: "quote" }>;

/** With no risk rules the maker quotes around the venue's mark, as it always has. */
const aroundMark = (mark: bigint): Quoting => ({
  action: "quote",
  centre: mark,
  extraSpreadBps: 0,
  reduceOnly: false,
});

/**
 * Keeps a ladder of post-only orders on both sides of a price. It requotes
 * (cancel everything, then place a fresh ladder) only when that price has moved
 * past the threshold or the requote interval has passed, so it does not churn
 * the book on every tick. Every quote expires on the venue by itself a little
 * after the requote interval, so a maker that dies leaves nothing standing.
 * While the venue would refuse its quotes it holds them instead, and requotes
 * on its first tick after the venue takes them again.
 *
 * With `safety` it follows the risk rules: it quotes around the reference
 * price, widens and pulls as the rules say, flattens its position past its
 * loss limits, and falls back to the soft stop on an error it does not
 * understand.
 */
export class HouseMaker {
  readonly trader: TraderKey;
  private lastQuoted: Quoting | null = null;
  private lastQuotedAtMs = -Infinity;
  private baseHeldAtStart = 0n;
  /** Whether quotes may be standing on the venue. */
  private standing = true;
  /** Whether the operator has been told that a cancel is unconfirmed. */
  private cancelAlerted = false;
  /** Counts every withdrawal, so a tick that was running through one stops placing orders. */
  private epoch = 0;
  /**
   * An order's outcome is unknown: no quote goes out until a cancel and a read of the seat have both
   * worked and the unknown order can no longer be dispatched (`hold.untilMs`), or, where that is not
   * bounded, an operator has looked. It is kept in the ledger, so a restart is held just the same.
   */
  private hold: UnresolvedHold | null;
  private readonly expiresInSeconds: number;

  constructor(private readonly options: HouseMakerOptions) {
    this.trader = makerTraderKey(options.market);
    this.expiresInSeconds =
      Math.ceil(options.requoteIntervalMs / 1_000) + MAKER_LIMITS.expiryMarginSeconds;
    this.hold = options.ledger?.state.hold ?? null;
  }

  /** Since when an order of unknown outcome has held the maker, or null while it is free to quote. */
  get quarantinedSinceMs(): number | null {
    return this.hold?.sinceMs ?? null;
  }

  /** Whether the venue has not confirmed a cancel in time, so the quotes may still stand. */
  get cancelUnconfirmed(): boolean {
    return this.cancelAlerted || this.cancelsOverdue > 0;
  }

  /** Cancels the venue was asked for and has not answered, though the maker stopped waiting. */
  private cancelsInFlight = 0;
  /** Cancels that passed their deadline and have not settled: a later cancel's success does not clear these. */
  private cancelsOverdue = 0;

  private async cancelQuotes(venue: Venue): Promise<void> {
    const call = venue.cancelAll(this.trader, this.options.market);
    this.cancelsInFlight += 1;
    let settledAlready = false;
    let overdue = false;
    const settled = (): void => {
      settledAlready = true;
      this.cancelsInFlight -= 1;
      if (overdue) this.cancelsOverdue -= 1;
    };
    call.then(settled, settled);
    try {
      await withinDeadline(call, this.options.cancelDeadlineMs ?? CANCEL_DEADLINE_MS, "the cancel");
    } catch (error) {
      if (!settledAlready) {
        overdue = true;
        this.cancelsOverdue += 1;
      }
      throw error;
    }
  }

  async ensureOpen(venue: Venue): Promise<void> {
    const { kind, baseToken, quoteToken, startingQuoteBalance, startingBaseBalance, ledger } =
      this.options;
    await venue.openTrader(this.trader);
    await venue.deposit(this.trader, quoteToken, startingQuoteBalance);
    if (kind !== "spot") return;
    await venue.deposit(this.trader, baseToken, startingBaseBalance);
    const kept = ledger?.state.spotBaseAtStart ?? null;
    if (kept === null) await ledger?.update({ spotBaseAtStart: startingBaseBalance });
    this.baseHeldAtStart = kept ?? startingBaseBalance;
  }

  /** Takes every quote off the venue, and keeps the tick that may be running from placing more. */
  async withdraw(venue: Venue): Promise<void> {
    this.epoch += 1;
    this.lastQuoted = null;
    await this.cancelQuotes(venue);
    // Only once the venue has taken them off: a cancel that failed or never answered is tried again on the next tick.
    this.standing = false;
  }

  /** The operator is told once that a cancel is unconfirmed, until one is confirmed. */
  private alertCancelUnconfirmed(error: unknown): void {
    if (this.cancelAlerted) return;
    this.cancelAlerted = true;
    this.options.safety?.alert(
      `its quotes may still be live: the cancel was not confirmed (${firstLine(error)}). It places nothing and tries again on every tick.`,
    );
  }

  /** `withdraw`, telling the operator once if the venue did not confirm the cancel. The error is thrown on. */
  private async withdrawOrAlert(venue: Venue): Promise<void> {
    try {
      await this.withdraw(venue);
      this.cancelAlerted = false;
    } catch (error) {
      this.alertCancelUnconfirmed(error);
      throw error;
    }
  }

  private dueForRequote(next: Quoting, nowMs: number): boolean {
    const last = this.lastQuoted;
    if (last === null) return true;
    if (nowMs - this.lastQuotedAtMs >= this.options.requoteIntervalMs) return true;
    const { requoteThresholdBps } = this.options;
    if (next.reduceOnly !== last.reduceOnly) return true;
    if (Boolean(next.flatten) !== Boolean(last.flatten)) return true;
    if (Math.abs(next.extraSpreadBps - last.extraSpreadBps) >= requoteThresholdBps) return true;
    const moved = absBigInt(next.centre - last.centre) * BPS_PER_WHOLE;
    return !(moved < BigInt(Math.round(requoteThresholdBps)) * last.centre);
  }

  /** A perpetual's position, or on spot how much base it holds beyond what it started with. */
  private inventory(state: TraderState): bigint {
    const { kind, market, baseToken } = this.options;
    return kind === "perp"
      ? (state.positions[market]?.size ?? 0n)
      : (state.balances[baseToken]?.balance ?? 0n) - this.baseHeldAtStart;
  }

  /**
   * Throws `QuotesHeld`, having sent nothing, while the venue says it would
   * refuse the quotes: cancelling and sending a ladder it refuses would only
   * empty the book. Its next tick after the venue takes quotes again requotes.
   * The exception is a market that is only reduce-only: the venue still takes
   * orders flagged reduce-only there, so the maker cancels what it has and
   * quotes the side that shrinks its position, flagged, which is the side
   * users need to close theirs.
   * With the risk rules, a failure while sending orders that it does not
   * understand makes the maker fall back (see `stopAfter`) and is thrown on. So
   * does an order the venue answers with a refusal, unless it is a post-only
   * order that would have crossed, or a reduce-only order with nothing left to
   * reduce: that leaves a gap in the ladder, so the maker sends no heartbeat
   * and sends the whole ladder again on its next tick. The heartbeat is sent
   * only after a requote of both sides: never while a loss limit, the kill
   * switch or the venue has the maker reducing only.
   */
  async tick(venue: Venue): Promise<void> {
    if (this.options.ledger?.state.mode === "stopped" && this.standing) {
      this.lastQuoted = null;
      await this.withdrawOrAlert(venue);
    }
    const epoch = this.epoch;
    const market = (await venue.markets()).find((entry) => entry.id === this.options.market);
    if (!market || market.markPrice === null) return;
    const mark = market.markPrice;
    const { safety } = this.options;
    // The risk rules and the operator's control run every tick, held or not.
    let plan: Plan;
    try {
      plan = safety ? await this.assess(safety, venue, mark) : aroundMark(mark);
    } catch (error) {
      // The mode could not be saved, so the ledger holds the hard stop in memory: take the quotes off now.
      if (error instanceof StatePersistenceError) {
        await this.withdrawOrAlert(venue).catch(() => {});
        this.alertUnrecorded(error);
      }
      throw error;
    }
    let held = false;
    let heldProblem: unknown;
    // A hold the ledger keeps is the maker's hold, however it came to be saved: nothing ordinary goes out under it.
    // A hold the ledger keeps is the maker's hold, however it came to be saved: nothing ordinary goes out under it.
    this.hold ??= this.options.ledger?.state.hold ?? null;
    if (this.hold !== null) {
      try {
        held = !(await this.reconcile(venue));
      } catch (error) {
        held = true;
        heldProblem = error;
      }
    }
    if (plan.action !== "quote") {
      this.lastQuoted = null;
      if (this.standing) await this.withdrawOrAlert(venue);
      if (heldProblem !== undefined) throw heldProblem;
      return;
    }
    // A held maker places only what the risk rules dictate to shrink its position, never a new ladder.
    if (held && !plan.reduceOnly && !plan.flatten) {
      this.lastQuoted = null;
      if (heldProblem !== undefined) throw heldProblem;
      return;
    }
    const refused = market.quotesRefusedBecause;
    const venueReducesOnly = refused !== undefined && market.takesReduceOnlyOrders === true;
    if (refused !== undefined && !venueReducesOnly) {
      this.lastQuoted = null;
      throw new QuotesHeld(this.options.market, refused);
    }
    const next: Quoting = venueReducesOnly ? { ...plan, reduceOnly: true } : plan;
    const now = this.options.clock.nowMs();
    if (!this.dueForRequote(next, now)) return;

    try {
      // A cancel still out would remove the ladder placed below when it lands, so nothing is placed until it ends.
      if (this.cancelsInFlight > 0) {
        throw new Error(
          "an earlier cancel did not answer and is still out, so a new ladder could be cancelled by it",
        );
      }
      await this.cancelQuotes(venue);
    } catch (error) {
      // Unconfirmed: the quotes may stand, nothing new goes out, and the next tick tries the cancel again.
      this.lastQuoted = null;
      this.standing = true;
      this.alertCancelUnconfirmed(error);
      throw error;
    }
    this.cancelAlerted = false;
    this.standing = false;
    const position = this.inventory(await venue.traderState(this.trader));
    const orders = this.ordersFor(next, market, position);
    const flagged = next.reduceOnly || next.flatten === true;
    this.standing = true;
    // Fixed once, here: the hold on disk and every order sent carry this same absolute expiry.
    const expiresAtMs = this.options.clock.nowMs() + this.expiresInSeconds * 1_000;
    const dispatching = orders.length > 0 && (await this.recordDispatch(flagged, expiresAtMs));
    // A risk-reducing send under a hold extends that hold, and the orders it places are added to it.
    const heldSend = orders.length > 0 && !dispatching && flagged && this.hold !== null;
    const sentIds: string[] = [];
    let leftOut = 0;
    let unknownReason: string | undefined;
    let sawUnknown = false;
    let cutShort = false;
    let tooLate = false;
    try {
      for (const order of orders) {
        if (epoch !== this.epoch) {
          cutShort = true;
          break;
        }
        const sent: NewOrder = {
          ...order,
          ...(flagged ? { reduceOnly: true } : {}),
          expiresInSeconds: this.expiresInSeconds,
          expiresAtMs,
        };
        const placed = await venue.placeOrder(this.trader, sent);
        if (placed.outcomeUnknown) {
          await this.holdForUnknown(sent, placed.orderId);
          sawUnknown = true;
          unknownReason = placed.reason;
          break;
        }
        if (placed.status !== "rejected") sentIds.push(placed.orderId);
        if (placed.status === "rejected" && placed.reason === ORDER_EXPIRY_TOO_NEAR) {
          tooLate = true;
          break;
        }
        if (!safety || placed.status !== "rejected") continue;
        if (!isRoutineRefusal(sent, placed.reason)) {
          throw new OrderRefused(this.options.market, placed.reason);
        }
        leftOut += 1;
      }
    } catch (error) {
      // The record of the ladder in flight stays on disk: a failed order may still have been sent.
      // The running maker holds it too, as it would for an order of unknown outcome.
      if (dispatching) this.hold = this.options.ledger?.state.hold ?? this.hold;
      if (heldSend) await this.noteSentOrders(sentIds);
      await this.stopAfter(venue, error).catch(() => {});
      throw error;
    }
    if (heldSend) await this.noteSentOrders(sentIds);
    if (tooLate && !sawUnknown) {
      await this.abandonLadder(venue, dispatching);
      return;
    }
    if (dispatching && this.hold === null) await this.clearDispatch(venue);
    if (cutShort) return;
    if (sawUnknown) {
      this.lastQuoted = null;
      await this.withdraw(venue).catch(() => {});
      throw new OrderOutcomeUnknown(this.options.market, unknownReason);
    }

    // A ladder with an order missing is not a requote: the next tick sends it again, and no heartbeat says all is well.
    if (leftOut > 0) {
      this.lastQuoted = null;
      return;
    }
    this.lastQuoted = next;
    this.lastQuotedAtMs = now;
    safety?.requoteSucceeded();
    if (!next.reduceOnly) this.options.afterRequote?.();
  }

  /**
   * Holds the maker until `order`, which may have been dispatched, can no longer rest or fill: its own
   * absolute expiry for a resting order. A reduce-only or non-resting order has no such bound, so
   * it holds the maker until an operator has looked (`reconcile`); without a ledger to record that
   * in, `UNKNOWN_ORDER_QUARANTINE_MS` from now. The hold is written to the ledger before this
   * returns; if that write fails the ledger stops the maker and the hold stays in memory.
   */
  private async holdForUnknown(order: NewOrder, orderId: string): Promise<void> {
    const now = this.options.clock.nowMs();
    const { ledger } = this.options;
    const resting = order.type === "limit" || order.type === "postOnly";
    const bounded = resting && !order.reduceOnly && order.expiresInSeconds !== undefined;
    const lastsMs = ledger ? null : UNKNOWN_ORDER_QUARANTINE_MS;
    const until = bounded
      ? holdLapsesAtMs(order.expiresAtMs ?? now + (order.expiresInSeconds ?? 0) * 1_000)
      : lastsMs === null
        ? null
        : now + lastsMs;
    const before = this.hold;
    const hold: UnresolvedHold = {
      orderIds: [...(before?.orderIds ?? []), orderId].slice(-HELD_ORDER_IDS),
      sinceMs: before?.sinceMs ?? now,
      lastAtMs: now,
      untilMs: mergedExpiry(before, until),
      seatClearAtMs: null,
    };
    this.hold = hold;
    await this.saveHold(hold);
  }

  /**
   * Writes the ladder about to go out to the ledger as a hold, before any order is sent, so a crash
   * or a failed write at any later point leaves a restart held. Nothing is sent if this write fails.
   * Returns whether a record was written (not when the maker is held already, or has no ledger).
   * A risk-reducing ladder sent while held extends the hold in the ledger instead, and sends nothing
   * if that write fails: it can never be bounded, since a reduce-only order has no expiry.
   */
  private async recordDispatch(flagged: boolean, expiresAtMs: number): Promise<boolean> {
    const { ledger, clock } = this.options;
    if (!ledger) return false;
    const now = clock.nowMs();
    const held = this.hold ?? ledger.state.hold;
    if (held !== null) {
      if (!flagged) return false;
      const extended: UnresolvedHold = {
        ...held,
        lastAtMs: now,
        untilMs: mergedExpiry(held, null),
        seatClearAtMs: null,
      };
      try {
        await ledger.update({ hold: extended });
      } catch (error) {
        if (error instanceof StatePersistenceError) this.alertUnrecorded(error);
        throw error;
      }
      this.hold = extended;
      return false;
    }
    try {
      await ledger.update({
        hold: {
          orderIds: [],
          sinceMs: now,
          lastAtMs: now,
          untilMs: flagged ? null : holdLapsesAtMs(expiresAtMs),
          seatClearAtMs: null,
        },
      });
    } catch (error) {
      if (error instanceof StatePersistenceError) this.alertUnrecorded(error);
      throw error;
    }
    return true;
  }

  /** Adds the orders a risk-reducing send placed under a hold to that hold. */
  private async noteSentOrders(orderIds: string[]): Promise<void> {
    const held = this.hold;
    if (held === null || orderIds.length === 0) return;
    const hold: UnresolvedHold = {
      ...held,
      orderIds: [...held.orderIds, ...orderIds].slice(-HELD_ORDER_IDS),
    };
    this.hold = hold;
    await this.saveHold(hold);
  }

  /**
   * A ladder whose orders went out too late for their shared expiry: the rest is not sent, what it
   * already placed is cancelled, and the maker is not stopped, since no venue failed. Its record ends
   * only when no order of it can still be out; the next tick quotes again with a fresh expiry.
   */
  private async abandonLadder(venue: Venue, dispatching: boolean): Promise<void> {
    this.lastQuoted = null;
    try {
      await this.cancelQuotes(venue);
    } catch (error) {
      this.standing = true;
      this.alertCancelUnconfirmed(error);
      if (dispatching) this.hold = this.options.ledger?.state.hold ?? this.hold;
      throw error;
    }
    this.cancelAlerted = false;
    this.standing = false;
    if (!dispatching) return;
    if ((venue.unsettledPlaces?.(this.trader) ?? 0) === 0) await this.clearDispatch(venue);
    else this.hold = this.options.ledger?.state.hold ?? this.hold;
  }

  /**
   * Ends the record of the ladder just sent. If that cannot be written the ledger has stopped the
   * maker, so the ladder is taken off at once and the failure is thrown: this is no good requote.
   */
  private async clearDispatch(venue: Venue): Promise<void> {
    try {
      await this.options.ledger?.update({ hold: null });
    } catch (error) {
      this.lastQuoted = null;
      if (error instanceof StatePersistenceError) this.alertUnrecorded(error);
      await this.withdrawOrAlert(venue).catch(() => {});
      throw error;
    }
  }

  private alertUnrecorded(error: StatePersistenceError): void {
    if (error.durableEvidence) return;
    this.options.safety?.alert(
      "its state could not be saved and neither could the recovery marker, so nothing on disk says " +
        "it must not quote. It stays stopped in memory and quotes nothing. Fix the disk before it is restarted.",
    );
  }

  /** Keeps `hold` in the ledger. A write that fails has stopped the maker there, and is told to the operator. */
  private async saveHold(hold: UnresolvedHold | null): Promise<void> {
    try {
      await this.options.ledger?.update({ hold });
    } catch (error) {
      if (!(error instanceof StatePersistenceError)) throw error;
      this.options.safety?.alert(
        `an unresolved order could not be written to disk (${firstLine(error)}). It stays held in memory, ` +
          "and a restart would not know of it: do not restart it until the disk is fixed.",
      );
    }
  }

  /**
   * Takes the quotes off and reads the seat. The hold ends only when the seat shows no order and
   * the unknown order can no longer be dispatched, since a cancel and an empty seat do not stop a send
   * that has not arrived yet: that is its absolute expiry, or, where it has none, an operator's
   * resume after the last unknown order. A failed or unanswered cancel or read keeps it, and is thrown.
   */
  private async reconcile(venue: Venue): Promise<boolean> {
    const held = this.hold;
    if (held === null) return true;
    try {
      await this.cancelQuotes(venue);
    } catch (error) {
      this.standing = true;
      this.alertCancelUnconfirmed(error);
      throw error;
    }
    this.standing = false;
    const seat = await venue.traderState(this.trader);
    const now = this.options.clock.nowMs();
    if (seat.openOrders.some((open) => open.market === this.options.market)) {
      if (held.seatClearAtMs !== null) {
        await this.saveHold((this.hold = { ...held, seatClearAtMs: null }));
      }
      throw new OrderOutcomeUnknown(this.options.market, "orders still show after a cancel");
    }
    if (held.seatClearAtMs === null) {
      await this.saveHold((this.hold = { ...held, seatClearAtMs: now }));
    }
    // A call the venue gave up waiting for can still land its order, so nothing releases the hold meanwhile.
    if ((venue.unsettledPlaces?.(this.trader) ?? 0) > 0) return false;
    if (held.untilMs === null) {
      const state = this.options.ledger?.state;
      const reviewed = state?.mode === "run" && state.lastCommandAtMs > held.lastAtMs;
      if (!reviewed) return false;
    } else if (now < held.untilMs) {
      return false;
    }
    await this.options.ledger?.update({ hold: null });
    this.hold = null;
    return true;
  }

  /** The seat's equity and position are what the risk rules judge the maker by. */
  private async assess(safety: MakerSafety, venue: Venue, mark: bigint): Promise<Plan> {
    const seat = await venue.traderState(this.trader);
    return safety.assess(mark, seat.equity, this.inventory(seat));
  }

  /** The orders `plan` asks for: the one that flattens the position, the side that shrinks it, or both sides. */
  private ordersFor(plan: Quoting, market: MarketInfo, position: bigint): NewOrder[] {
    const { safety, lotSize } = this.options;
    if (plan.flatten) {
      return flattenOrders(this.options, {
        centre: plan.centre,
        tickSize: market.tickSize,
        position,
        giveBps: MAKER_LIMITS.flattenGiveBps,
      });
    }
    const spreadBps = Math.ceil(
      Math.max(this.options.spreadBps, safety ? MAKER_LIMITS.minHalfSpreadBps : 0) +
        plan.extraSpreadBps,
    );
    const ladder = ladderOrders(
      { ...this.options, spreadBps },
      {
        mark: plan.centre,
        tickSize: market.tickSize,
        position,
        positionLimit: divScale(this.options.positionLimitNotional, plan.centre),
        positionCap: market.positionCap,
        minEdgeBps: safety ? MAKER_LIMITS.minHalfSpreadBps : undefined,
      },
    );
    return plan.reduceOnly ? onlyReducing(ladder, position, lotSize) : ladder;
  }

  /**
   * An order failed for a reason that is not the venue being away. With the
   * risk rules the maker does not guess: it falls back to the soft stop, or
   * stops altogether if it was flattening already or has met such errors
   * repeatedly at the soft stop (see `MakerRisk.stopFor`), takes its quotes
   * off if it can, and an operator resumes it. A cancel that fails is not treated this way, since it only
   * removes risk: the tick that follows tries it again.
   */
  private async stopAfter(venue: Venue, error: unknown): Promise<void> {
    const { safety } = this.options;
    if (!safety || error instanceof VenueNotReady) return;
    try {
      await safety.stopFor(firstLine(error));
    } finally {
      this.lastQuoted = null;
      await this.withdraw(venue).catch(() => {});
    }
  }
}
