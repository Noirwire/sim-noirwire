import { Account, type Position } from "./accounts.js";
import { type Clock, systemClock } from "./clock.js";
import { DAY_MS, DayVolume, PriceHistory, percentChange } from "./day-window.js";
import { MARKETS, type MarketConfig, marketById, maxLeverageAt } from "./markets.js";
import { SCALE, absBigInt, bpsOf, divScale, minBigInt, mulDivScale, signOf } from "./money.js";
import { OrderBook, type RestingOrder } from "./order-book.js";
import { randomTag } from "./tag.js";
import type {
  Fill,
  MarketId,
  MarketInfo,
  NewOrder,
  OrderStatus,
  OrderView,
  PlaceResult,
  Side,
  TraderKey,
  TraderState,
  Venue,
} from "./types.js";
import { rejectedOrder } from "./venue-orders.js";

export const HOUSE_FEES: TraderKey = "house:fees";
export const HOUSE_INSURANCE: TraderKey = "house:insurance";
const COLLATERAL_TOKEN = "nUSD";
const PRICE_HISTORY_RETENTION_MS = DAY_MS + 60 * 60 * 1000;
const DEFAULT_INSURANCE_SEED = 10_000_000n * SCALE;
const DEFAULT_MAX_FUNDING_RATE_BPS_PER_UPDATE = 75;

interface SpotLock {
  trader: TraderKey;
  token: string;
  amount: bigint;
}

interface MarketRuntime {
  config: MarketConfig;
  book: OrderBook;
  markPrice: bigint | null;
  markPriceUpdatedAtMs: number | null;
  fundingIndex: bigint;
  openInterest: bigint;
  volume: DayVolume;
  priceHistory: PriceHistory;
  spotLocks: Map<string, SpotLock>;
}

export interface MemoryVenueOptions {
  clock?: Clock;
  insuranceSeedBalance?: bigint;
  maxFundingRateBpsPerUpdate?: number;
}

/** An order that passed the shape checks, on its way through one market. */
interface Incoming {
  orderId: string;
  tag: bigint;
  trader: TraderKey;
  account: Account;
  runtime: MarketRuntime;
  side: Side;
  type: NewOrder["type"];
  /** The limit price, or a market order's worst price. */
  bound: bigint;
  requestedSize: bigint;
  /** The requested size, or less once a reduce-only order is cut down to its position. */
  size: bigint;
  reduceOnly: boolean;
}

/** The order's price once its size and price fit the market, or why they do not. */
const checkedPrice = (config: MarketConfig, order: NewOrder): { bound: bigint } | string => {
  if (order.size <= 0n) return "size must be positive";
  if (order.size % config.lotSize !== 0n) return "size must be a multiple of the lot size";
  if (order.price === undefined) {
    return order.type === "market"
      ? "market order requires a worst price"
      : `${order.type} order requires a price`;
  }
  if (order.price <= 0n) return "price must be positive";
  if (order.price % config.tickSize !== 0n) return "price must be a multiple of the tick size";
  return { bound: order.price };
};

/**
 * What a spot order holds back while it can still fill: the quote it may pay
 * with the taker fee on top, or the base it sells.
 */
const spotReservation = (
  config: MarketConfig,
  side: Side,
  price: bigint,
  size: bigint,
): { token: string; amount: bigint } => {
  if (side === "sell") return { token: config.base, amount: size };
  const principal = mulDivScale(price, size);
  return { token: config.quote, amount: principal + bpsOf(principal, config.takerFeeBps) };
};

const longSize = (position: Position): bigint => (position.size > 0n ? position.size : 0n);

const unrealizedPnl = (position: Position, markPrice: bigint): bigint =>
  mulDivScale(position.size, markPrice - position.entryPrice);

const pendingFunding = (position: Position, fundingIndex: bigint): bigint =>
  mulDivScale(position.size, fundingIndex - position.fundingIndexSnapshot);

const statusOf = (size: bigint, filled: bigint, resting: bigint): OrderStatus => {
  if (resting > 0n) return filled > 0n ? "partiallyFilled" : "open";
  if (filled === size) return "filled";
  return filled > 0n ? "partiallyFilled" : "cancelled";
};

/**
 * An in-process matching engine with the program's rules: price-time
 * priority, spot with balances locked per order, perpetuals with cross
 * margin, a taker fee, funding and liquidation. Realised profit, funding and
 * liquidation shortfalls settle against the insurance account, so every
 * token's total across all accounts stays what was deposited.
 */
export class MemoryVenue implements Venue {
  private readonly clock: Clock;
  private readonly accounts = new Map<TraderKey, Account>();
  private readonly runtimes = new Map<MarketId, MarketRuntime>();
  private readonly listeners = new Set<(fill: Fill) => void>();
  private readonly maxFundingRateBpsPerUpdate: number;
  private ordersPlaced = 0;
  private fillSequence = 0;

  constructor(options: MemoryVenueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxFundingRateBpsPerUpdate =
      options.maxFundingRateBpsPerUpdate ?? DEFAULT_MAX_FUNDING_RATE_BPS_PER_UPDATE;

    for (const config of MARKETS) {
      this.runtimes.set(config.id, {
        config,
        book: new OrderBook(),
        markPrice: null,
        markPriceUpdatedAtMs: null,
        fundingIndex: 0n,
        openInterest: 0n,
        volume: new DayVolume(),
        priceHistory: new PriceHistory(PRICE_HISTORY_RETENTION_MS),
        spotLocks: new Map(),
      });
    }

    this.account(HOUSE_FEES);
    this.account(HOUSE_INSURANCE).credit(
      COLLATERAL_TOKEN,
      options.insuranceSeedBalance ?? DEFAULT_INSURANCE_SEED,
    );
  }

  private account(trader: TraderKey): Account {
    let account = this.accounts.get(trader);
    if (!account) {
      account = new Account();
      this.accounts.set(trader, account);
    }
    return account;
  }

  private runtime(market: MarketId): MarketRuntime {
    const runtime = this.runtimes.get(market);
    if (!runtime) throw new Error(`unknown market ${market}`);
    return runtime;
  }

  private priceIsStale(runtime: MarketRuntime, updatedAtMs: number): boolean {
    return this.clock.nowMs() - updatedAtMs > runtime.config.maxStalePriceMs;
  }

  async markets(): Promise<MarketInfo[]> {
    const now = this.clock.nowMs();
    return MARKETS.map((config) => {
      const { markPrice, markPriceUpdatedAtMs, priceHistory, volume, openInterest } = this.runtime(
        config.id,
      );
      const dayAgoPrice = priceHistory.firstSince(now - DAY_MS) ?? priceHistory.latest();
      return {
        id: config.id,
        kind: config.kind,
        base: config.base,
        quote: config.quote,
        tickSize: config.tickSize,
        lotSize: config.lotSize,
        maxLeverage: maxLeverageAt(config.initialMarginBps),
        markPrice,
        markPriceUpdatedAtMs,
        change24h: markPrice === null ? null : percentChange(dayAgoPrice, markPrice),
        volume24h: volume.total(now),
        openInterest: config.kind === "perp" ? openInterest : null,
      };
    });
  }

  async publishPrice(market: MarketId, price: bigint, publishedAtMs: number): Promise<void> {
    const runtime = this.runtime(market);
    runtime.markPrice = price;
    runtime.markPriceUpdatedAtMs = publishedAtMs;
    runtime.priceHistory.add(publishedAtMs, price);
  }

  async openTrader(trader: TraderKey): Promise<void> {
    this.account(trader);
  }

  async deposit(trader: TraderKey, token: string, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new Error("deposit amount must be positive");
    this.account(trader).credit(token, amount);
  }

  onFill(listener: (fill: Fill) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult> {
    const orderId = `ord-${this.ordersPlaced++}`;
    const tag = randomTag();
    const reject = (reason: string) => rejectedOrder(orderId, tag, order, reason);

    const config = marketById(order.market);
    if (!config) return reject("unknown market");
    const account = this.accounts.get(trader);
    if (!account) return reject("trader not open");
    const checked = checkedPrice(config, order);
    if (typeof checked === "string") return reject(checked);

    const incoming: Incoming = {
      orderId,
      tag,
      trader,
      account,
      runtime: this.runtime(config.id),
      side: order.side,
      type: order.type,
      bound: checked.bound,
      requestedSize: order.size,
      size: order.size,
      reduceOnly: config.kind === "perp" && Boolean(order.reduceOnly),
    };
    const refusal =
      config.kind === "perp" ? this.perpRefusal(incoming) : this.reserveForSpot(incoming);
    if (refusal) return reject(refusal);
    return this.execute(incoming);
  }

  /** Matches what crosses, rests what may rest, and gives back what a spot order reserved in vain. */
  private execute(incoming: Incoming): PlaceResult {
    const { orderId, tag, trader, runtime, side, type, bound, size } = incoming;
    const isSpot = runtime.config.kind === "spot";

    if (type === "postOnly") {
      const check = runtime.book.checkPostOnly(side, trader, bound);
      if (check.wouldCross) {
        if (isSpot) this.releaseSpotReservation(incoming, size);
        return {
          orderId,
          tag,
          status: "rejected",
          filledSize: 0n,
          remainingSize: incoming.requestedSize,
          reason: "would cross the book",
        };
      }
      runtime.book.remove(check.selfCancels);
      if (isSpot)
        for (const cancelled of check.selfCancels) this.releaseSpotLock(runtime, cancelled);
      this.rest(incoming, size);
      return { orderId, tag, status: "open", filledSize: 0n, remainingSize: size };
    }

    const outcome = runtime.book.match(side, trader, bound, size);
    if (isSpot)
      for (const cancelled of outcome.selfCancels) this.releaseSpotLock(runtime, cancelled);

    let filled = 0n;
    for (const match of outcome.fills) {
      if (isSpot) this.settleSpotFill(incoming, match.resting, match.size);
      else this.settlePerpFill(incoming, match.resting, match.size);
      this.emitFill(incoming, match.resting, match.size);
      filled += match.size;
    }

    const resting = type === "limit" ? outcome.remaining : 0n;
    if (resting > 0n) this.rest(incoming, resting);
    else if (isSpot && outcome.remaining > 0n) {
      this.releaseSpotReservation(incoming, outcome.remaining);
    }

    return {
      orderId,
      tag,
      status: statusOf(size, filled, resting),
      filledSize: filled,
      remainingSize: size - filled,
      reason: undefined,
    };
  }

  private rest(incoming: Incoming, remaining: bigint): void {
    const { orderId, tag, trader, runtime, side, type, bound, size, reduceOnly } = incoming;
    runtime.book.insert({
      orderId,
      tag,
      trader,
      side,
      type: type === "postOnly" ? "postOnly" : "limit",
      price: bound,
      size,
      remaining,
      reduceOnly,
    });
    if (runtime.config.kind === "spot") {
      runtime.spotLocks.set(orderId, {
        trader,
        ...spotReservation(runtime.config, side, bound, remaining),
      });
    }
  }

  private emitFill(incoming: Incoming, resting: RestingOrder, size: bigint): void {
    const { runtime } = incoming;
    const now = this.clock.nowMs();
    this.fillSequence += 1;
    runtime.volume.add(now, mulDivScale(resting.price, size));
    const fill: Fill = {
      market: runtime.config.id,
      price: resting.price,
      size,
      takerSide: incoming.side,
      takerTag: incoming.tag,
      makerTag: resting.tag,
      timestampMs: now,
      sequence: this.fillSequence,
    };
    for (const listener of this.listeners) listener(fill);
  }

  /** Locks what the order may spend. Returns why not, when the balance does not cover it. */
  private reserveForSpot({ account, runtime, side, bound, size }: Incoming): string | null {
    const { token, amount } = spotReservation(runtime.config, side, bound, size);
    if (account.freeBalance(token) < amount) return "insufficient balance";
    account.lock(token, amount);
    return null;
  }

  private releaseSpotReservation({ account, runtime, side, bound }: Incoming, size: bigint): void {
    const { token, amount } = spotReservation(runtime.config, side, bound, size);
    account.unlock(token, amount);
  }

  private releaseSpotLock(runtime: MarketRuntime, order: RestingOrder): void {
    const lock = runtime.spotLocks.get(order.orderId);
    if (!lock) return;
    this.account(lock.trader).unlock(lock.token, lock.amount);
    runtime.spotLocks.delete(order.orderId);
  }

  /**
   * A fill happens at the resting order's price. Only the taker pays the
   * fee: a taker who reserved at a worse price gets the difference back, and
   * a resting buyer gets back the fee part of its reservation.
   */
  private settleSpotFill(incoming: Incoming, resting: RestingOrder, size: bigint): void {
    const { config, spotLocks } = incoming.runtime;
    const taker = incoming.account;
    const maker = this.account(resting.trader);
    const notional = mulDivScale(resting.price, size);
    const fee = bpsOf(notional, config.takerFeeBps);
    const takerHeld = spotReservation(config, incoming.side, incoming.bound, size);
    const makerHeld = spotReservation(config, resting.side, resting.price, size);

    taker.consumeLocked(takerHeld.token, takerHeld.amount);
    if (incoming.side === "buy") {
      const reservedTooMuch = takerHeld.amount - notional - fee;
      if (reservedTooMuch > 0n) taker.credit(config.quote, reservedTooMuch);
      taker.credit(config.base, size);
      this.account(HOUSE_FEES).credit(config.quote, fee);
      maker.consumeLocked(makerHeld.token, makerHeld.amount);
      maker.credit(config.quote, notional);
    } else {
      taker.credit(config.quote, notional - fee);
      this.account(HOUSE_FEES).credit(config.quote, fee);
      maker.consumeLocked(makerHeld.token, makerHeld.amount);
      maker.credit(config.quote, makerHeld.amount - notional);
      maker.credit(config.base, size);
    }

    const lock = spotLocks.get(resting.orderId);
    if (!lock) return;
    lock.amount -= makerHeld.amount;
    if (resting.remaining === 0n) spotLocks.delete(resting.orderId);
  }

  private settlePendingFunding(account: Account, runtime: MarketRuntime): Position {
    const position = account.positionIn(runtime.config.id, runtime.fundingIndex);
    if (position.size !== 0n && runtime.fundingIndex !== position.fundingIndexSnapshot) {
      const payment = pendingFunding(position, runtime.fundingIndex);
      account.credit(COLLATERAL_TOKEN, payment);
      this.account(HOUSE_INSURANCE).debit(COLLATERAL_TOKEN, payment);
    }
    position.fundingIndexSnapshot = runtime.fundingIndex;
    return position;
  }

  private equityOf(account: Account): bigint {
    let equity = account.freeBalance(COLLATERAL_TOKEN);
    for (const [marketId, position] of account.positions) {
      const runtime = this.runtimes.get(marketId);
      if (!runtime || runtime.markPrice === null) continue;
      equity += unrealizedPnl(position, runtime.markPrice);
      equity += pendingFunding(position, runtime.fundingIndex);
    }
    return equity;
  }

  /** The margin every position needs at `bps`, with `whatIf` in place of one market's position. */
  private marginRequirement(
    account: Account,
    bps: number,
    whatIf?: { market: MarketId; size: bigint },
  ): bigint {
    const sizes = new Map<MarketId, bigint>();
    for (const [marketId, position] of account.positions) sizes.set(marketId, position.size);
    if (whatIf) sizes.set(whatIf.market, whatIf.size);

    let total = 0n;
    for (const [marketId, size] of sizes) {
      const markPrice = this.runtimes.get(marketId)?.markPrice ?? null;
      if (markPrice === null) continue;
      total += bpsOf(mulDivScale(absBigInt(size), markPrice), bps);
    }
    return total;
  }

  /**
   * Why a perpetual order is refused, or null. A reduce-only order is cut
   * down to the position it reduces. Growing exposure needs a fresh price and
   * initial margin on the resulting position.
   */
  private perpRefusal(incoming: Incoming): string | null {
    const { account, runtime, side, bound } = incoming;
    const { config } = runtime;
    if (runtime.markPrice === null || runtime.markPriceUpdatedAtMs === null) {
      return "no price available";
    }
    const position = account.positionIn(config.id, runtime.fundingIndex);

    if (incoming.reduceOnly) {
      const reduces = side === "sell" ? position.size > 0n : position.size < 0n;
      const reducible = minBigInt(incoming.size, absBigInt(position.size));
      incoming.size = reducible - (reducible % config.lotSize);
      if (!reduces || incoming.size === 0n) return "reduce-only: no position to reduce";
    }

    const resultingSize = position.size + (side === "buy" ? incoming.size : -incoming.size);
    const worstCaseFee = bpsOf(mulDivScale(bound, incoming.size), config.takerFeeBps);
    // Invariant: the taker fee comes out of free balance whichever way the
    // trade moves exposure, so even a pure reduction must be able to pay it.
    if (account.freeBalance(COLLATERAL_TOKEN) < worstCaseFee) return "insufficient margin";

    if (absBigInt(resultingSize) <= absBigInt(position.size)) return null;
    if (this.priceIsStale(runtime, runtime.markPriceUpdatedAtMs)) return "stale price";
    const requiredMargin = this.marginRequirement(account, config.initialMarginBps, {
      market: config.id,
      size: resultingSize,
    });
    return this.equityOf(account) < requiredMargin + worstCaseFee ? "insufficient margin" : null;
  }

  private settlePerpFill(incoming: Incoming, resting: RestingOrder, size: bigint): void {
    const { runtime } = incoming;
    const takerDelta = incoming.side === "buy" ? size : -size;
    this.changePosition(incoming.account, runtime, takerDelta, resting.price);
    this.changePosition(this.account(resting.trader), runtime, -takerDelta, resting.price);

    const fee = bpsOf(mulDivScale(resting.price, size), runtime.config.takerFeeBps);
    incoming.account.debit(COLLATERAL_TOKEN, fee);
    this.account(HOUSE_FEES).credit(COLLATERAL_TOKEN, fee);
  }

  /**
   * Adding to a position averages its entry price. Reducing one realises
   * profit or loss on the part closed, against the insurance account; going
   * through zero opens the remainder at the fill price.
   */
  private changePosition(
    account: Account,
    runtime: MarketRuntime,
    signedDelta: bigint,
    fillPrice: bigint,
  ): void {
    const position = this.settlePendingFunding(account, runtime);
    const oldSize = position.size;
    const oldLong = longSize(position);
    const newSize = oldSize + signedDelta;

    if (oldSize === 0n || signOf(oldSize) === signOf(signedDelta)) {
      const oldNotional = mulDivScale(absBigInt(oldSize), position.entryPrice);
      const addedNotional = mulDivScale(absBigInt(signedDelta), fillPrice);
      position.entryPrice =
        newSize === 0n ? 0n : divScale(oldNotional + addedNotional, absBigInt(newSize));
    } else {
      const closing = minBigInt(absBigInt(signedDelta), absBigInt(oldSize)) * signOf(oldSize);
      const realized = mulDivScale(closing, fillPrice - position.entryPrice);
      account.credit(COLLATERAL_TOKEN, realized);
      this.account(HOUSE_INSURANCE).debit(COLLATERAL_TOKEN, realized);
      if (absBigInt(signedDelta) > absBigInt(oldSize)) position.entryPrice = fillPrice;
      else if (newSize === 0n) position.entryPrice = 0n;
    }
    position.size = newSize;
    runtime.openInterest += longSize(position) - oldLong;
  }

  /** Moves the funding index by the book's premium over the mark, capped per update. */
  async updateFunding(market: MarketId): Promise<void> {
    const runtime = this.runtime(market);
    const mid = runtime.book.mid();
    if (runtime.markPrice === null || mid === null) return;
    const premium = divScale(mid - runtime.markPrice, runtime.markPrice);
    const cap = bpsOf(SCALE, this.maxFundingRateBpsPerUpdate);
    const rate = premium > cap ? cap : premium < -cap ? -cap : premium;
    runtime.fundingIndex += mulDivScale(runtime.markPrice, rate);
  }

  /**
   * Closes an account that is under maintenance margin, at the mark less a
   * penalty that favours the liquidator, who takes the position over. What
   * the account cannot cover comes from the insurance account.
   */
  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const runtime = this.runtime(market);
    const { config, markPrice, markPriceUpdatedAtMs } = runtime;
    if (markPrice === null || markPriceUpdatedAtMs === null) return false;
    if (this.priceIsStale(runtime, markPriceUpdatedAtMs)) return false;
    const liquidatorAccount = this.accounts.get(liquidator);
    const targetAccount = this.accounts.get(target);
    if (!liquidatorAccount || !targetAccount) return false;

    const position = this.settlePendingFunding(targetAccount, runtime);
    if (position.size === 0n) return false;
    const maintenance = this.marginRequirement(targetAccount, config.maintenanceMarginBps);
    if (this.equityOf(targetAccount) >= maintenance) return false;

    const penalty = bpsOf(markPrice, config.liquidationPenaltyBps);
    const executionPrice = position.size > 0n ? markPrice - penalty : markPrice + penalty;
    const liquidatedSize = position.size;
    const realized = mulDivScale(liquidatedSize, executionPrice - position.entryPrice);
    targetAccount.credit(COLLATERAL_TOKEN, realized);
    this.account(HOUSE_INSURANCE).debit(COLLATERAL_TOKEN, realized);
    runtime.openInterest -= longSize(position);
    position.size = 0n;
    position.entryPrice = 0n;

    const shortfall = -targetAccount.freeBalance(COLLATERAL_TOKEN);
    if (shortfall > 0n) {
      this.account(HOUSE_INSURANCE).debit(COLLATERAL_TOKEN, shortfall);
      targetAccount.credit(COLLATERAL_TOKEN, shortfall);
    }

    this.changePosition(liquidatorAccount, runtime, liquidatedSize, executionPrice);
    return true;
  }

  async cancelAll(trader: TraderKey, market: MarketId): Promise<number> {
    const runtime = this.runtime(market);
    const cancelled = runtime.book.cancelAllForTrader(trader);
    for (const order of cancelled) this.releaseSpotLock(runtime, order);
    return cancelled.length;
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const account = this.account(trader);
    const balances: TraderState["balances"] = {};
    for (const [token, entry] of account.balances) {
      balances[token] = { balance: entry.balance, locked: entry.locked };
    }

    const positions: TraderState["positions"] = {};
    for (const [marketId, position] of account.positions) {
      if (position.size !== 0n) {
        positions[marketId] = { size: position.size, entryPrice: position.entryPrice };
      }
    }

    const openOrders: OrderView[] = MARKETS.flatMap((config) =>
      this.runtime(config.id)
        .book.openOrdersForTrader(trader)
        .map((resting) => ({
          orderId: resting.orderId,
          tag: resting.tag,
          market: config.id,
          side: resting.side,
          type: resting.type,
          price: resting.price,
          size: resting.size,
          remainingSize: resting.remaining,
          reduceOnly: resting.reduceOnly,
        })),
    );

    return { trader, balances, positions, openOrders, equity: this.equityOf(account) };
  }
}
