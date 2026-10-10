import type { Clock } from "../engine/clock.js";
import { BPS_PER_WHOLE, bpsOf, divScale, roundDownToStep, roundUpToStep } from "../engine/money.js";
import type { MarketId, MarketKind, NewOrder, TraderKey, Venue } from "../engine/types.js";
import { makerTraderKey } from "./bot-traders.js";

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
}

/** The skew is applied in thousandths of a basis point, so a small inventory still moves the centre. */
const SKEW_PRECISION = 1_000;

export interface Ladder {
  mark: bigint;
  tickSize: bigint;
  /** Signed inventory in base units: positive when long. */
  position: bigint;
  positionLimit: bigint;
}

type LadderShape = Pick<
  HouseMakerOptions,
  "market" | "levels" | "spreadBps" | "levelStepBps" | "baseSizePerLevel" | "maxSkewBps" | "lotSize"
>;

/**
 * The quotes for one requote, nearest level first, bid before ask. The
 * centre shifts away from the inventory by up to `maxSkewBps` at the position
 * limit, and the side that would grow the inventory past the limit is left out.
 */
export const ladderOrders = (shape: LadderShape, ladder: Ladder): NewOrder[] => {
  const { mark, tickSize, position, positionLimit } = ladder;
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
    price: roundUpToStep(price, tickSize),
    size,
  });

  const orders: NewOrder[] = [];
  for (let level = 0; level < shape.levels; level += 1) {
    const offset = bpsOf(center, shape.spreadBps + level * shape.levelStepBps);
    const size = roundDownToStep(shape.baseSizePerLevel * BigInt(level + 1), shape.lotSize);
    if (size <= 0n) continue;
    const bid = quote("buy", center - offset, size);
    if (position < positionLimit && bid.price !== undefined && bid.price > 0n) orders.push(bid);
    if (position > -positionLimit) orders.push(quote("sell", center + offset, size));
  }
  return orders;
};

/**
 * Keeps a ladder of post-only orders on both sides of the mark. It requotes
 * (cancel everything, then place a fresh ladder) only when the mark has moved
 * past the threshold or the requote interval has passed, so it does not churn
 * the book on every tick.
 */
export class HouseMaker {
  readonly trader: TraderKey;
  private lastQuotedPrice: bigint | null = null;
  private lastQuotedAtMs = -Infinity;
  private baseHeldAtStart = 0n;

  constructor(private readonly options: HouseMakerOptions) {
    this.trader = makerTraderKey(options.market);
  }

  async ensureOpen(venue: Venue): Promise<void> {
    const { kind, baseToken, quoteToken, startingQuoteBalance, startingBaseBalance } = this.options;
    await venue.openTrader(this.trader);
    await venue.deposit(this.trader, quoteToken, startingQuoteBalance);
    if (kind !== "spot") return;
    await venue.deposit(this.trader, baseToken, startingBaseBalance);
    this.baseHeldAtStart = startingBaseBalance;
  }

  private dueForRequote(mark: bigint, nowMs: number): boolean {
    if (this.lastQuotedPrice === null) return true;
    if (nowMs - this.lastQuotedAtMs >= this.options.requoteIntervalMs) return true;
    const movedBps =
      (Number(mark - this.lastQuotedPrice) / Number(this.lastQuotedPrice)) * Number(BPS_PER_WHOLE);
    return !(Math.abs(movedBps) < this.options.requoteThresholdBps);
  }

  /** A perpetual's position, or on spot how much base it holds beyond what it started with. */
  private async inventory(venue: Venue): Promise<bigint> {
    const { kind, market, baseToken } = this.options;
    const state = await venue.traderState(this.trader);
    return kind === "perp"
      ? (state.positions[market]?.size ?? 0n)
      : (state.balances[baseToken]?.balance ?? 0n) - this.baseHeldAtStart;
  }

  async tick(venue: Venue): Promise<void> {
    const market = (await venue.markets()).find((entry) => entry.id === this.options.market);
    if (!market || market.markPrice === null) return;
    const mark = market.markPrice;
    const now = this.options.clock.nowMs();
    if (!this.dueForRequote(mark, now)) return;

    await venue.cancelAll(this.trader, this.options.market);
    const orders = ladderOrders(this.options, {
      mark,
      tickSize: market.tickSize,
      position: await this.inventory(venue),
      positionLimit: divScale(this.options.positionLimitNotional, mark),
    });
    for (const order of orders) await venue.placeOrder(this.trader, order);

    this.lastQuotedPrice = mark;
    this.lastQuotedAtMs = now;
  }
}
