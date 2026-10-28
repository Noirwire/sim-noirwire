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
  OrderView,
  Side,
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

/** Ladders kept failing because an order provably never ran: the cause is not passing, so the maker stops. */
export class UnrunOrdersRepeated extends Error {
  constructor(inARow: number, lastReason: string) {
    super(
      `${inARow} ladders in a row were dropped because an order never ran, the last: ${lastReason}`,
    );
    this.name = "UnrunOrdersRepeated";
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
 * whatever rests inside that price, and the program drops what it did not fill,
 * so the maker pays at most `giveBps` to get out and never chases a price
 * beyond it.
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

/** What the old orders may add up to on each side while the new ladder stands beside them. */
export interface OverlapRoom {
  /** In base units, per side. */
  buy: bigint;
  sell: bigint;
  /** How many old orders each side may keep. */
  orders: number;
}

/** The old orders of a requote that keeps some of them standing until the new ladder is up. */
export interface Overlap {
  /** Cancelled before the new ladder is placed: it would cross them, or they do not fit beside it. */
  before: OrderView[];
  /** Left standing while the new ladder is placed: the best priced ones that fit. */
  after: OrderView[];
}

const byPriceCmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a post-only order of `orders` would match `old`, which the program refuses without placing it. */
const crossedBy = (old: OrderView & { price: bigint }, orders: NewOrder[]): boolean =>
  orders.some(
    (order) =>
      order.side !== old.side &&
      order.price !== undefined &&
      (old.side === "sell" ? order.price >= old.price : order.price <= old.price),
  );

const isPriced = (old: OrderView): old is OrderView & { price: bigint } => old.price !== null;

/**
 * Splits the maker's `standing` orders for a requote that places `orders` before it cancels the old
 * ones. On each side the old orders nearest the market that the new ladder would not cross and that
 * fit in `room` stand through the swap, so the book is never bare. The rest go first.
 */
export const splitStanding = (
  standing: OrderView[],
  orders: NewOrder[],
  room: OverlapRoom,
): Overlap => {
  const keepOn = (side: Side): OrderView[] => {
    const candidates = standing
      .filter(isPriced)
      .filter((old) => old.side === side && !crossedBy(old, orders))
      .sort((a, b) => byPriceCmp(a.price, b.price) * (side === "buy" ? -1 : 1));
    const kept: OrderView[] = [];
    let size = 0n;
    for (const old of candidates) {
      if (kept.length >= room.orders || size + old.remainingSize > room[side]) continue;
      kept.push(old);
      size += old.remainingSize;
    }
    return kept;
  };
  const after = [...keepOn("buy"), ...keepOn("sell")];
  return { before: standing.filter((old) => !after.includes(old)), after };
};

/** The total size of `orders` on each side. */
const sizesBySide = (orders: { side: Side; size: bigint }[]): { buy: bigint; sell: bigint } => {
  const total = (side: Side): bigint =>
    orders.filter((order) => order.side === side).reduce((sum, order) => sum + order.size, 0n);
  return { buy: total("buy"), sell: total("sell") };
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
 * only when that price has moved past the threshold or the requote interval
 * has passed, so it does not churn the book on every tick. A requote on a
 * perpetual places the new ladder before it cancels the old orders, one by
 * one, so the book is not bare meanwhile: the old orders the new ladder would
 * cross, or that would not fit beside it under the position limit, the
 * venue's position cap and the seat's margin, go first, and the best priced
 * of the rest stand until the new ladder is up. Wherever that cannot be done
 * (a venue that cancels only everything, a market that is not a perpetual, an
 * order of unknown outcome, a cancel not confirmed) it cancels everything and
 * then places a fresh ladder. Every quote expires on the venue by itself a little
 * after the requote interval, so a maker that dies leaves nothing standing.
 * While the venue would refuse its quotes it holds them instead, and requotes
 * on its first tick after the venue takes them again.
 *
 * With `safety` it follows the risk rules: it quotes around the reference
 * price, widens and pulls as the rules say, flattens its position past its
 * loss limits, and falls back to the soft stop on an error it does not
 * understand. A plan that only reduces pulls the quotes and leaves the book
 * empty: only a flatten trades the position down.
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
  /** Ladders in a row dropped because an order never ran; a ladder that went out in full ends the run. */
  private unrunLadders = 0;
  /** Counts every withdrawal, so a tick that was running through one stops placing orders. */
  private epoch = 0;
  /**
   * An order's outcome is unknown: no quote goes out until a cancel and a read of the seat have both
   * worked and the unknown order can no longer be dispatched (`hold.untilMs`), or, where that is not
   * bounded, an operator has looked. It is kept in the ledger, so a restart is held just the same.
   */
  private hold: UnresolvedHold | null;
  private readonly expiresInSeconds: number;
  /** What the last ladder placed on each side, and the position it was cut for. Null while it did not quote both sides. */
  private placed: { buy: bigint; sell: bigint; position: bigint } | null = null;
  private lastSideReadAtMs = -Infinity;
  /** A seat read found the ladder consumed, so the next tick requotes. */
  private consumed = false;
  /** Since when a side the ladder placed orders on has had none resting, per side. Null outside normal quoting. */
  private emptySince: { buy: number | null; sell: number | null } | null = null;

  constructor(private readonly options: HouseMakerOptions) {
    this.trader = makerTraderKey(options.market);
    this.expiresInSeconds =
      Math.ceil(options.requoteIntervalMs / 1_000) + MAKER_LIMITS.expiryMarginSeconds;
    this.silence = { sinceMs: options.clock.nowMs(), because: "it has not quoted yet" };
    this.hold = options.ledger?.state.hold ?? null;
    this.unrunLadders = options.ledger?.state.unrunLadders ?? 0;
  }

  /** Since when no ladder has rested, and why, or null while the maker quotes. It starts out as not quoting. */
  private silence: { sinceMs: number; because: string } | null;

  private quoting(because: string | null): void {
    if (because === null) this.silence = null;
    else this.silence = { sinceMs: this.silence?.sinceMs ?? this.options.clock.nowMs(), because };
  }

  /** When the newest ladder verified resting stops standing: its orders expire on the venue by themselves. */
  private restingUntilMs: number | null = null;

  /**
   * Since when the book has had none of this maker's quotes, and why, or null while it quotes. A
   * ladder that rested and was not replaced is silence from its expiry on, whatever the ticks
   * since have found.
   */
  get notQuoting(): { sinceMs: number; because: string } | null {
    if (this.silence) return this.silence;
    if (this.restingUntilMs !== null && this.options.clock.nowMs() > this.restingUntilMs) {
      return { sinceMs: this.restingUntilMs, because: "its last quotes expired" };
    }
    return null;
  }

  /**
   * The side that has had no resting level the longest while the maker quotes normally, or null. A side
   * the ladder left empty on purpose (no room under the position limit or the venue's cap) is not one.
   */
  get emptySide(): { side: "bids" | "asks"; sinceMs: number } | null {
    const empty = this.emptySince;
    if (empty === null) return null;
    const sides = [
      { side: "bids" as const, sinceMs: empty.buy },
      { side: "asks" as const, sinceMs: empty.sell },
    ].flatMap((entry) =>
      entry.sinceMs === null ? [] : [{ side: entry.side, sinceMs: entry.sinceMs }],
    );
    return sides.sort((a, b) => a.sinceMs - b.sinceMs)[0] ?? null;
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
    this.emptySince = null;
    await this.cancelQuotes(venue);
    // Only once the venue has taken them off: a cancel that failed or never answered is tried again on the next tick.
    this.standing = false;
  }

  /**
   * Takes what stands off the venue before anything new is placed. Unconfirmed, the quotes may stand,
   * nothing new goes out, the operator is told once, and the next tick tries the cancel again.
   */
  private async cancelStanding(venue: Venue): Promise<void> {
    try {
      // A cancel still out would remove the ladder placed after it when it lands, so nothing is placed until it ends.
      if (this.cancelsInFlight > 0) {
        throw new Error(
          "an earlier cancel did not answer and is still out, so a new ladder could be cancelled by it",
        );
      }
      await this.cancelQuotes(venue);
    } catch (error) {
      this.lastQuoted = null;
      this.standing = true;
      this.alertCancelUnconfirmed(error);
      throw error;
    }
    this.cancelAlerted = false;
    this.standing = false;
  }

  /** The operator is told once that a cancel is unconfirmed, until one is confirmed. */
  private alertCancelUnconfirmed(
    error: unknown,
    next = "It places nothing and tries again on every tick.",
  ): void {
    if (this.cancelAlerted) return;
    this.cancelAlerted = true;
    this.options.safety?.alert(
      `its quotes may still be live: the cancel was not confirmed (${firstLine(error)}). ${next}`,
    );
  }

  /**
   * Whether a requote may keep the old orders standing while the new ladder goes up. Not where a cancel
   * of everything is out or unconfirmed (it would take the new ladder with it when it lands), where an
   * order may be on its way (one this maker does not know of would stand unseen), or under a hold, a
   * flatten or a reduce-only plan.
   */
  private mayOverlap(venue: Venue, plan: Quoting, market: MarketInfo): boolean {
    return (
      venue.cancelOrder !== undefined &&
      this.options.kind === "perp" &&
      market.maxLeverage > 0 &&
      !plan.reduceOnly &&
      plan.flatten !== true &&
      this.hold === null &&
      this.cancelsInFlight === 0 &&
      !this.cancelAlerted &&
      (venue.unsettledPlaces?.(this.trader) ?? 0) === 0 &&
      (this.options.safety?.mayGrow() ?? true)
    );
  }

  /**
   * How much of the old orders may stand beside `orders`: what is left of the maker's position limit,
   * of the venue's position cap and of the margin its equity gives, once the new ladder has taken its
   * part of each, and half the open orders it allows itself for each side. The new ladder was cut to
   * fit the limit and the cap by itself, so nothing here can make it larger than it is.
   */
  private overlapRoom(
    plan: Quoting,
    market: MarketInfo,
    seat: TraderState,
    position: bigint,
    orders: NewOrder[],
  ): OverlapRoom {
    const limit = divScale(this.options.positionLimitNotional, plan.centre);
    const equity = maxBigInt(seat.equity, 0n);
    const affordable = divScale(
      (equity * BigInt(market.maxLeverage) * BigInt(MAKER_LIMITS.overlapMarginShareBps)) /
        BPS_PER_WHOLE,
      market.markPrice ?? plan.centre,
    );
    const cap = market.positionCap;
    const roomOn = (side: Side): bigint => {
      const toward = side === "buy" ? position : -position;
      const reach = maxBigInt(toward, 0n);
      const newTotal = orders
        .filter((order) => order.side === side)
        .reduce((sum, order) => sum + order.size, 0n);
      const bounds = [limit - toward, affordable - toward];
      if (cap !== undefined) bounds.push(cap - reach);
      return maxBigInt(bounds.reduce(minBigInt) - newTotal, 0n);
    };
    return {
      buy: roomOn("buy"),
      sell: roomOn("sell"),
      orders: Math.max(Math.floor((MAKER_LIMITS.overlapMaxOpenOrders - orders.length) / 2), 0),
    };
  }

  /** The new ladder and which old orders stand beside it, or null where the requote must cancel everything first. */
  private async overlapFor(
    venue: Venue,
    plan: Quoting,
    market: MarketInfo,
  ): Promise<(Overlap & { orders: NewOrder[]; position: bigint }) | null> {
    if (!this.mayOverlap(venue, plan, market)) return null;
    const seat = await venue.traderState(this.trader);
    const position = this.inventory(seat);
    const orders = this.ordersFor(plan, market, position);
    if (orders.length === 0) return null;
    const standing = seat.openOrders.filter((open) => open.market === this.options.market);
    const room = this.overlapRoom(plan, market, seat, position, orders);
    return { orders, position, ...splitStanding(standing, orders, room) };
  }

  /**
   * Cancels `olds` one by one by their id. An order the venue no longer has is as good as cancelled. A
   * cancel that fails or is not answered in time leaves the order, so the maker places nothing more
   * and the next tick cancels everything; `next` tells the operator what to expect meanwhile.
   */
  private async cancelOld(
    venue: Venue,
    olds: OrderView[],
    epoch: number,
    next?: string,
  ): Promise<void> {
    try {
      for (const old of olds) {
        if (epoch !== this.epoch) return;
        await withinDeadline(
          venue.cancelOrder!(this.trader, this.options.market, old.orderId),
          this.options.cancelDeadlineMs ?? CANCEL_DEADLINE_MS,
          "the cancel",
        );
      }
    } catch (error) {
      this.lastQuoted = null;
      this.standing = true;
      this.alertCancelUnconfirmed(error, next);
      throw error;
    }
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
    if (last === null || this.consumed) return true;
    if (nowMs - this.lastQuotedAtMs >= this.options.requoteIntervalMs) return true;
    const { requoteThresholdBps } = this.options;
    if (next.reduceOnly !== last.reduceOnly) return true;
    if (Boolean(next.flatten) !== Boolean(last.flatten)) return true;
    if (Math.abs(next.extraSpreadBps - last.extraSpreadBps) >= requoteThresholdBps) return true;
    const moved = absBigInt(next.centre - last.centre) * BPS_PER_WHOLE;
    return !(moved < BigInt(Math.round(requoteThresholdBps)) * last.centre);
  }

  /**
   * Whether a taker has consumed the ladder: a fill moved the position since it was cut, or a side
   * rests with less than half of what the ladder placed there. Reads the seat at most once per
   * `sideReadEveryMs`, and notes the sides that rest nothing. A read that fails is no reason to requote.
   */
  private async sidesConsumed(
    venue: Venue,
    next: Quoting,
    now: number,
    epoch: number,
  ): Promise<boolean> {
    const placed = this.placed;
    if (placed === null || next.reduceOnly || next.flatten === true) return false;
    if (now - this.lastSideReadAtMs < MAKER_LIMITS.sideReadEveryMs) return false;
    this.lastSideReadAtMs = now;
    let seat: TraderState;
    try {
      seat = await venue.traderState(this.trader);
    } catch {
      return false;
    }
    if (epoch !== this.epoch) return false;
    const resting = sizesBySide(
      seat.openOrders
        .filter((open) => open.market === this.options.market)
        .map((open) => ({ side: open.side, size: open.remainingSize })),
    );
    this.noteEmptySides(placed, resting, now);
    const thin = (side: Side): boolean => placed[side] > 0n && resting[side] * 2n < placed[side];
    return thin("buy") || thin("sell") || this.inventory(seat) !== placed.position;
  }

  /** A side that was given orders and has none resting is empty from when that was first seen. */
  private noteEmptySides(
    placed: { buy: bigint; sell: bigint },
    resting: { buy: bigint; sell: bigint },
    now: number,
  ): void {
    const since = (side: Side): number | null =>
      placed[side] > 0n && resting[side] === 0n ? (this.emptySince?.[side] ?? now) : null;
    this.emptySince = { buy: since("buy"), sell: since("sell") };
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
   * A plan that only reduces (the soft stop, a blind hedge) pulls the quotes:
   * it cancels what stands and places nothing, since a resting order cannot be
   * made to shrink a position and could open exposure the other way after a
   * fill. Only a flatten trades the position down, with one crossing limit
   * order flagged reduce-only, which the program enforces when it fills. While
   * an order of unknown outcome holds the maker, only that order goes out.
   * A market that is only reduce-only cancels what stands and then holds
   * (throwing `QuotesHeld`) unless the maker is flattening, since the venue
   * still takes reduce-only orders there and the flattening order is one. A
   * failed cancel is handled as any requote's is, and once nothing stands the
   * later ticks do not cancel again.
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
    try {
      await this.tickOnce(venue);
    } catch (error) {
      this.quoting(`its last tick failed: ${firstLine(error)}`);
      throw error;
    }
  }

  private async tickOnce(venue: Venue): Promise<void> {
    if (this.options.ledger?.state.mode === "stopped" && this.standing) {
      this.lastQuoted = null;
      await this.withdrawOrAlert(venue);
    }
    const epoch = this.epoch;
    const market = (await venue.markets()).find((entry) => entry.id === this.options.market);
    if (!market || market.markPrice === null) {
      this.quoting("the market has no mark price");
      return;
    }
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
      this.quoting(plan.action === "pull" ? plan.reason : "it is stopped");
      this.lastQuoted = null;
      this.emptySince = null;
      if (this.standing) await this.withdrawOrAlert(venue);
      if (heldProblem !== undefined) throw heldProblem;
      return;
    }
    // A held maker places only the order that flattens its position, which the program holds to reduce-only.
    if (held && !plan.flatten) {
      this.quoting("an order of unknown outcome holds it");
      this.lastQuoted = null;
      this.emptySince = null;
      if (heldProblem !== undefined) throw heldProblem;
      return;
    }
    const refused = market.quotesRefusedBecause;
    const venueReducesOnly = refused !== undefined && market.takesReduceOnlyOrders === true;
    // A reduce-only market takes only reduce-only orders, which never rest, so only a flatten can go out there.
    // Anything else pulls what is standing first: old two-sided quotes would still fill there.
    if (refused !== undefined && !(venueReducesOnly && plan.flatten)) {
      this.lastQuoted = null;
      this.emptySince = null;
      if (venueReducesOnly && this.standing) await this.cancelStanding(venue);
      throw new QuotesHeld(this.options.market, refused);
    }
    const next: Quoting = venueReducesOnly ? { ...plan, reduceOnly: true } : plan;
    const now = this.options.clock.nowMs();
    if (!this.dueForRequote(next, now)) {
      // A consumed ladder is requoted on the next tick, so the risk rules first see the seat after the fill.
      if (await this.sidesConsumed(venue, next, now, epoch)) this.consumed = true;
      // The ladder from the last requote still stands, so a read that failed since is not silence.
      if (!next.reduceOnly && this.restingUntilMs !== null && now < this.restingUntilMs) {
        this.quoting(null);
      }
      return;
    }

    // Old orders that stand beside the new ladder until it is up, or none where everything is cancelled first.
    const overlap = await this.overlapFor(venue, next, market);
    let orders: NewOrder[];
    let position: bigint;
    if (overlap === null) {
      await this.cancelStanding(venue);
      position = this.inventory(await venue.traderState(this.trader));
      orders = this.ordersFor(next, market, position);
      // The cancel above ran, so nothing stands: the next tick's plan takes the reduce-only path.
      if (safety && !next.reduceOnly && !safety.mayGrow()) {
        this.lastQuoted = null;
        return;
      }
    } else {
      ({ orders, position } = overlap);
      await this.cancelOld(venue, overlap.before, epoch);
    }
    const kept = overlap?.after ?? [];
    // Only a flatten sends orders under a reduce-only plan, and every one of them is flagged reduce-only.
    const flattening = next.flatten === true;
    this.standing = orders.length > 0 || kept.length > 0;
    // Fixed once, here: the hold on disk and every order sent carry this same absolute expiry.
    const expiresAtMs = this.options.clock.nowMs() + this.expiresInSeconds * 1_000;
    const dispatching = orders.length > 0 && (await this.recordDispatch(flattening, expiresAtMs));
    // A flattening send under a hold extends that hold, and the orders it places are added to it.
    const heldSend = orders.length > 0 && !dispatching && flattening && this.hold !== null;
    const sentIds: string[] = [];
    /** The orders the venue reports as standing: a post-only order it cancelled does not rest. */
    const resting: NewOrder[] = [];
    let leftOut = 0;
    let unknownReason: string | undefined;
    let sawUnknown = false;
    let cutShort = false;
    let tooLate = false;
    let unrunReason: string | undefined;
    try {
      for (const order of orders) {
        if (epoch !== this.epoch) {
          cutShort = true;
          break;
        }
        const sent: NewOrder = {
          ...order,
          ...(flattening ? { reduceOnly: true } : {}),
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
        const stands =
          (placed.status === "open" || placed.status === "partiallyFilled") &&
          placed.remainingSize > 0n;
        if (stands) resting.push({ ...order, size: placed.remainingSize });
        if (placed.status === "rejected" && placed.reason === ORDER_EXPIRY_TOO_NEAR) {
          tooLate = true;
          break;
        }
        if (!safety || placed.status !== "rejected") continue;
        if (placed.didNotRun) {
          unrunReason = placed.reason || "no reason given";
          break;
        }
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
      await this.abandonLadder(venue, dispatching, overlap !== null);
      return;
    }
    if (unrunReason !== undefined && !sawUnknown) {
      await this.abandonLadder(venue, dispatching, overlap !== null);
      this.unrunLadders += 1;
      safety?.ladderAbandoned(unrunReason, this.unrunLadders);
      if (this.unrunLadders >= MAKER_LIMITS.unrunLaddersBeforeStop) {
        const repeated = new UnrunOrdersRepeated(this.unrunLadders, unrunReason);
        this.unrunLadders = 0;
        await this.options.ledger?.update({ unrunLadders: 0 }).catch(() => {});
        await this.stopAfter(venue, repeated).catch(() => {});
        throw repeated;
      }
      await this.options.ledger?.update({ unrunLadders: this.unrunLadders });
      return;
    }
    if (dispatching && this.hold === null) await this.clearDispatch(venue);
    if (cutShort) return;
    if (sawUnknown) {
      this.lastQuoted = null;
      await this.withdraw(venue).catch(() => {});
      throw new OrderOutcomeUnknown(this.options.market, unknownReason);
    }
    // An old order goes only once every order that replaces it on its side stands; otherwise it stays until the next requote.
    const replaced = (side: Side): boolean =>
      resting.filter((order) => order.side === side).length ===
      orders.filter((order) => order.side === side).length;
    await this.cancelOld(
      venue,
      kept.filter((old) => replaced(old.side)),
      epoch,
      "The replaced quotes expire by themselves, and it cancels everything on the next tick.",
    );

    if (resting.length > 0 && this.unrunLadders > 0) {
      this.unrunLadders = 0;
      await this.options.ledger?.update({ unrunLadders: 0 });
    }
    const planned = sizesBySide(orders);
    const normal = !next.reduceOnly && !flattening;
    if (normal) {
      const standingNow = sizesBySide([
        ...resting,
        ...kept
          .filter((old) => !replaced(old.side))
          .map((old) => ({ side: old.side, size: old.remainingSize })),
      ]);
      this.noteEmptySides(planned, standingNow, now);
    } else {
      this.emptySince = null;
    }
    // A ladder with an order missing is not a requote: the next tick sends it again, and no heartbeat says all is well.
    if (leftOut > 0) {
      this.lastQuoted = null;
      return;
    }
    this.lastQuoted = next;
    this.lastQuotedAtMs = now;
    this.lastSideReadAtMs = now;
    this.consumed = false;
    this.placed = normal ? { ...planned, position } : null;
    this.quoting(
      resting.length > 0 || (!next.reduceOnly && kept.length > 0)
        ? null
        : next.reduceOnly
          ? "it is only reducing its position"
          : "it has no room to quote",
    );
    if (resting.length > 0) this.restingUntilMs = expiresAtMs;
    if (orders.length > 0) {
      if (this.unrunLadders > 0) {
        this.unrunLadders = 0;
        await this.options.ledger?.update({ unrunLadders: 0 });
      }
      safety?.requoteSucceeded();
    }
    if (resting.length > 0 && !next.reduceOnly) safety?.ladderResting(resting);
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
   * `flattening` is whether the orders go out reduce-only: only the flattening order does. Such a send
   * while held extends the hold in the ledger instead, and sends nothing if that write fails: it can
   * never be bounded, since a reduce-only order has no expiry. A ladder expires like any quote.
   */
  private async recordDispatch(flattening: boolean, expiresAtMs: number): Promise<boolean> {
    const { ledger, clock } = this.options;
    if (!ledger) return false;
    const now = clock.nowMs();
    const held = this.hold ?? ledger.state.hold;
    if (held !== null) {
      if (!flattening) return false;
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
          untilMs: flattening ? null : holdLapsesAtMs(expiresAtMs),
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
   * Where the old orders were left standing (`overlapped`) nothing is cancelled: they and what the
   * ladder placed stand until that next tick replaces them all.
   */
  private async abandonLadder(
    venue: Venue,
    dispatching: boolean,
    overlapped: boolean,
  ): Promise<void> {
    this.lastQuoted = null;
    if (!overlapped) {
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
    }
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

  /**
   * The orders `plan` asks for: the one that flattens the position, none while the plan only reduces
   * (a resting order cannot be made to shrink a position, so the quotes are pulled), or both sides.
   */
  private ordersFor(plan: Quoting, market: MarketInfo, position: bigint): NewOrder[] {
    const { safety } = this.options;
    if (plan.flatten) {
      return flattenOrders(this.options, {
        centre: plan.centre,
        tickSize: market.tickSize,
        position,
        giveBps: MAKER_LIMITS.flattenGiveBps,
      });
    }
    if (plan.reduceOnly) return [];
    const spreadBps = Math.ceil(
      Math.max(this.options.spreadBps, safety ? MAKER_LIMITS.minHalfSpreadBps : 0) +
        plan.extraSpreadBps,
    );
    return ladderOrders(
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
