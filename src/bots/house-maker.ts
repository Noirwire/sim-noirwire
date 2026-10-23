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
import { VenueNotReady } from "../engine/venue-not-ready.js";
import { firstLine } from "../logging/first-line.js";
import { makerTraderKey } from "./bot-traders.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import type { MakerSafety, Plan } from "./maker-safety.js";
import type { MakerLedger } from "./maker-state.js";

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
}

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
  const inventoryShare = positionLimit > 0n ? Number(position) / Number(positionLimit) : 0;
  const skewBps = Math.max(-1, Math.min(1, inventoryShare)) * shape.maxSkewBps;
  const center =
    mark -
    (mark * BigInt(Math.round(skewBps * SKEW_PRECISION))) /
      (BPS_PER_WHOLE * BigInt(SKEW_PRECISION));
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
  /** Counts every withdrawal, so a tick that was running through one stops placing orders. */
  private epoch = 0;
  private readonly expiresInSeconds: number;

  constructor(private readonly options: HouseMakerOptions) {
    this.trader = makerTraderKey(options.market);
    this.expiresInSeconds =
      Math.ceil(options.requoteIntervalMs / 1_000) + MAKER_LIMITS.expiryMarginSeconds;
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
    await venue.cancelAll(this.trader, this.options.market);
    // Only once the venue has taken them off: a cancel that failed is tried again on the next tick.
    this.standing = false;
  }

  private dueForRequote(next: Quoting, nowMs: number): boolean {
    const last = this.lastQuoted;
    if (last === null) return true;
    if (nowMs - this.lastQuotedAtMs >= this.options.requoteIntervalMs) return true;
    const { requoteThresholdBps } = this.options;
    if (next.reduceOnly !== last.reduceOnly) return true;
    if (Boolean(next.flatten) !== Boolean(last.flatten)) return true;
    if (Math.abs(next.extraSpreadBps - last.extraSpreadBps) >= requoteThresholdBps) return true;
    const movedBps =
      (Number(next.centre - last.centre) / Number(last.centre)) * Number(BPS_PER_WHOLE);
    return !(Math.abs(movedBps) < requoteThresholdBps);
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
    const epoch = this.epoch;
    const market = (await venue.markets()).find((entry) => entry.id === this.options.market);
    if (!market || market.markPrice === null) return;
    const mark = market.markPrice;
    const { safety } = this.options;
    const plan = safety ? await this.assess(safety, venue, mark) : aroundMark(mark);
    if (plan.action !== "quote") {
      this.lastQuoted = null;
      if (this.standing) await this.withdraw(venue);
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

    await venue.cancelAll(this.trader, this.options.market);
    this.standing = false;
    const position = this.inventory(await venue.traderState(this.trader));
    const orders = this.ordersFor(next, market, position);
    const flagged = venueReducesOnly || next.flatten === true;
    this.standing = true;
    let leftOut = 0;
    try {
      for (const order of orders) {
        if (epoch !== this.epoch) return;
        const sent: NewOrder = {
          ...order,
          ...(flagged ? { reduceOnly: true } : {}),
          expiresInSeconds: this.expiresInSeconds,
        };
        const placed = await venue.placeOrder(this.trader, sent);
        if (!safety || placed.status !== "rejected") continue;
        if (!isRoutineRefusal(sent, placed.reason)) {
          throw new OrderRefused(this.options.market, placed.reason);
        }
        leftOut += 1;
      }
    } catch (error) {
      await this.stopAfter(venue, error).catch(() => {});
      throw error;
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
