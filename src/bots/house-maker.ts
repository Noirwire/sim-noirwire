import type { Clock } from "../engine/clock.js";
import {
  BPS_PER_WHOLE,
  absBigInt,
  bpsOf,
  divScale,
  minBigInt,
  roundDownToStep,
  roundUpToStep,
} from "../engine/money.js";
import type {
  MarketId,
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

/** `size` where a side that already reaches `reach` has room for a whole level under the cap, else nothing. */
const fitUnderCap = (positionCap: bigint | undefined, reach: bigint, size: bigint): bigint =>
  positionCap === undefined || positionCap - reach >= size ? size : 0n;

/**
 * The quotes for one requote, nearest level first, bid before ask. Every level
 * holds `baseSizePerLevel`. The centre shifts away from the inventory by up to
 * `maxSkewBps` at the position limit, and the side that would grow the
 * inventory past the limit is left out. Where the venue caps a side's position
 * and open orders together, each side's levels stop at the last whole one
 * that fits under that cap.
 */
export const ladderOrders = (shape: LadderShape, ladder: Ladder): NewOrder[] => {
  const { mark, tickSize, position, positionLimit, positionCap } = ladder;
  const inventoryShare = positionLimit > 0n ? Number(position) / Number(positionLimit) : 0;
  const skewBps = Math.max(-1, Math.min(1, inventoryShare)) * shape.maxSkewBps;
  const center =
    mark -
    (mark * BigInt(Math.round(skewBps * SKEW_PRECISION))) /
      (BPS_PER_WHOLE * BigInt(SKEW_PRECISION));
  const quote = (side: NewOrder["side"], price: bigint, size: bigint): NewOrder => ({
    market: shape.market,
    side,
    type: "postOnly",
    // A price off the tick moves away from the market, so the spread is never narrower than asked.
    price: side === "buy" ? roundDownToStep(price, tickSize) : roundUpToStep(price, tickSize),
    size,
  });

  const orders: NewOrder[] = [];
  let bidReach = position > 0n ? position : 0n;
  let askReach = position < 0n ? -position : 0n;
  for (let level = 0; level < shape.levels; level += 1) {
    const offset = bpsOf(center, shape.spreadBps + level * shape.levelStepBps);
    const size = roundDownToStep(shape.baseSizePerLevel, shape.lotSize);
    if (size <= 0n) continue;
    const bidSize = fitUnderCap(positionCap, bidReach, size);
    const bid = quote("buy", center - offset, bidSize);
    if (bidSize > 0n && position < positionLimit && bid.price !== undefined && bid.price > 0n) {
      orders.push(bid);
      bidReach += bidSize;
    }
    const askSize = fitUnderCap(positionCap, askReach, size);
    if (askSize > 0n && position > -positionLimit) {
      orders.push(quote("sell", center + offset, askSize));
      askReach += askSize;
    }
  }
  return orders;
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
 * price, widens and pulls as the rules say, stops growing past its loss
 * limits, and stops for good on an error it does not understand.
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
    this.standing = false;
    await venue.cancelAll(this.trader, this.options.market);
  }

  private dueForRequote(next: Quoting, nowMs: number): boolean {
    const last = this.lastQuoted;
    if (last === null) return true;
    if (nowMs - this.lastQuotedAtMs >= this.options.requoteIntervalMs) return true;
    const { requoteThresholdBps } = this.options;
    if (next.reduceOnly !== last.reduceOnly) return true;
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
   * With the risk rules, a failure while sending orders that it does not
   * understand stops the maker (see `stopAfter`) and is thrown on.
   */
  async tick(venue: Venue): Promise<void> {
    const epoch = this.epoch;
    const market = (await venue.markets()).find((entry) => entry.id === this.options.market);
    if (!market || market.markPrice === null) return;
    const mark = market.markPrice;
    const { safety } = this.options;
    const plan = safety ? await safety.assess(mark, await this.equity(venue)) : aroundMark(mark);
    if (plan.action !== "quote") {
      this.lastQuoted = null;
      if (this.standing) await this.withdraw(venue);
      return;
    }
    if (market.quotesRefusedBecause !== undefined) {
      this.lastQuoted = null;
      throw new QuotesHeld(this.options.market, market.quotesRefusedBecause);
    }
    const now = this.options.clock.nowMs();
    if (!this.dueForRequote(plan, now)) return;

    await venue.cancelAll(this.trader, this.options.market);
    this.standing = false;
    const position = this.inventory(await venue.traderState(this.trader));
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
      },
    );
    const orders = plan.reduceOnly ? onlyReducing(ladder, position, this.options.lotSize) : ladder;
    this.standing = true;
    try {
      for (const order of orders) {
        if (epoch !== this.epoch) return;
        await venue.placeOrder(this.trader, { ...order, expiresInSeconds: this.expiresInSeconds });
      }
    } catch (error) {
      await this.stopAfter(venue, error).catch(() => {});
      throw error;
    }

    this.lastQuoted = plan;
    this.lastQuotedAtMs = now;
  }

  /** What the risk rules measure the maker's loss by: the seat's equity at the venue's mark. */
  private async equity(venue: Venue): Promise<bigint> {
    return (await venue.traderState(this.trader)).equity;
  }

  /**
   * An order failed for a reason that is not the venue being away. With the
   * risk rules the maker does not guess: it stops for good, takes its quotes
   * off if it can (they expire anyway), and an operator resumes it. A cancel
   * that fails is not treated this way, since it only removes risk: the tick
   * that follows tries it again.
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
