import { Account, type Position } from "./accounts.js";
import { type Clock, systemClock } from "./clock.js";
import { MARKETS, type MarketConfig, marketById, maxLeverage } from "./markets.js";
import { absBigInt, bpsOf, divScale, mulDivScale, signOf } from "./money.js";
import { OrderBook, type RestingOrder } from "./order-book.js";
import { randomTag } from "./tag.js";
import type {
  Fill,
  LatencyStats,
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
  VenueStats,
} from "./types.js";

export const HOUSE_FEES: TraderKey = "house:fees";
export const HOUSE_INSURANCE: TraderKey = "house:insurance";
const QUOTE_TOKEN = "nUSD";
const VOLUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const PRICE_HISTORY_RETENTION_MS = 25 * 60 * 60 * 1000;
const DEFAULT_INSURANCE_SEED = 10_000_000n * 1_000_000n;
const DEFAULT_MAX_FUNDING_RATE_BPS_PER_UPDATE = 75;
const DEFAULT_LATENCY_WINDOW = 500;

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
  recentFills: { atMs: number; notional: bigint }[];
  priceHistory: { atMs: number; price: bigint }[];
  spotLocks: Map<string, SpotLock>;
}

export interface MemoryVenueOptions {
  clock?: Clock;
  insuranceSeedBalance?: bigint;
  maxFundingRateBpsPerUpdate?: number;
  latencyWindowSize?: number;
}

const percentile = (sortedMs: number[], p: number): number => {
  if (sortedMs.length === 0) return 0;
  const index = Math.min(sortedMs.length - 1, Math.floor(p * sortedMs.length));
  return sortedMs[index]!;
};

export class MemoryVenue implements Venue {
  private readonly clock: Clock;
  private readonly accounts = new Map<TraderKey, Account>();
  private readonly runtimes = new Map<MarketId, MarketRuntime>();
  private readonly listeners = new Set<(fill: Fill) => void>();
  private readonly latencySamplesMs: number[] = [];
  private readonly latencyWindowSize: number;
  private readonly maxFundingRateBpsPerUpdate: number;
  private orderSeq = 0;
  private sequence = 0;
  private ordersTotal = 0;
  private fillsTotal = 0;
  private volumeTotal = 0n;

  constructor(options: MemoryVenueOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.latencyWindowSize = options.latencyWindowSize ?? DEFAULT_LATENCY_WINDOW;
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
        recentFills: [],
        priceHistory: [],
        spotLocks: new Map(),
      });
    }

    this.ensureAccount(HOUSE_FEES);
    this.ensureAccount(HOUSE_INSURANCE).credit(
      QUOTE_TOKEN,
      options.insuranceSeedBalance ?? DEFAULT_INSURANCE_SEED,
    );
  }

  private ensureAccount(trader: TraderKey): Account {
    let account = this.accounts.get(trader);
    if (!account) {
      account = new Account(trader);
      this.accounts.set(trader, account);
    }
    return account;
  }

  private requireRuntime(market: MarketId): MarketRuntime {
    const runtime = this.runtimes.get(market);
    if (!runtime) throw new Error(`unknown market ${market}`);
    return runtime;
  }

  private recordLatency(sampleMs: number): void {
    this.latencySamplesMs.push(sampleMs);
    if (this.latencySamplesMs.length > this.latencyWindowSize) {
      this.latencySamplesMs.shift();
    }
  }

  private recordVolume(runtime: MarketRuntime, notional: bigint, atMs: number): void {
    runtime.recentFills.push({ atMs, notional });
    const cutoff = atMs - VOLUME_WINDOW_MS;
    while (runtime.recentFills.length > 0 && runtime.recentFills[0]!.atMs < cutoff) {
      runtime.recentFills.shift();
    }
    this.volumeTotal += notional;
  }

  private emitFill(fill: Fill): void {
    this.fillsTotal += 1;
    for (const listener of this.listeners) listener(fill);
  }

  async markets(): Promise<MarketInfo[]> {
    const now = this.clock.nowMs();
    return MARKETS.map((config) => {
      const runtime = this.requireRuntime(config.id);
      const volume24h = runtime.recentFills
        .filter((entry) => entry.atMs >= now - VOLUME_WINDOW_MS)
        .reduce((sum, entry) => sum + entry.notional, 0n);
      const change24h = this.change24h(runtime, now);
      return {
        id: config.id,
        kind: config.kind,
        base: config.base,
        quote: config.quote,
        tickSize: config.tickSize,
        lotSize: config.lotSize,
        maxLeverage: maxLeverage(config),
        markPrice: runtime.markPrice,
        markPriceUpdatedAtMs: runtime.markPriceUpdatedAtMs,
        change24h,
        volume24h,
        openInterest: config.kind === "perp" ? runtime.openInterest : null,
      };
    });
  }

  private change24h(runtime: MarketRuntime, now: number): number | null {
    if (runtime.markPrice === null) return null;
    const cutoff = now - VOLUME_WINDOW_MS;
    let reference = runtime.priceHistory[0];
    for (const sample of runtime.priceHistory) {
      if (sample.atMs >= cutoff) {
        reference = sample;
        break;
      }
      reference = sample;
    }
    if (!reference || reference.price === 0n) return null;
    const diff = runtime.markPrice - reference.price;
    return (Number(diff) / Number(reference.price)) * 100;
  }

  async publishPrice(market: MarketId, price: bigint, publishedAtMs: number): Promise<void> {
    const runtime = this.requireRuntime(market);
    runtime.markPrice = price;
    runtime.markPriceUpdatedAtMs = publishedAtMs;
    runtime.priceHistory.push({ atMs: publishedAtMs, price });
    const cutoff = publishedAtMs - PRICE_HISTORY_RETENTION_MS;
    while (runtime.priceHistory.length > 0 && runtime.priceHistory[0]!.atMs < cutoff) {
      runtime.priceHistory.shift();
    }
  }

  async openTrader(trader: TraderKey): Promise<void> {
    this.ensureAccount(trader);
  }

  async deposit(trader: TraderKey, token: string, amount: bigint): Promise<void> {
    if (amount <= 0n) throw new Error("deposit amount must be positive");
    this.ensureAccount(trader).credit(token, amount);
  }

  onFill(listener: (fill: Fill) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stats(): Promise<VenueStats> {
    const sorted = [...this.latencySamplesMs].sort((a, b) => a - b);
    const latency: LatencyStats = {
      medianMs: percentile(sorted, 0.5),
      p99Ms: percentile(sorted, 0.99),
      sampleSize: sorted.length,
      measuredFrom: "engine:placeOrder",
    };
    return {
      ordersTotal: this.ordersTotal,
      fillsTotal: this.fillsTotal,
      volumeTotal: this.volumeTotal,
      tradersTotal: this.accounts.size,
      latency,
      updatedAtMs: this.clock.nowMs(),
    };
  }

  async placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult> {
    const startedAt = performance.now();
    this.ordersTotal += 1;
    const result = this.placeOrderSync(trader, order);
    this.recordLatency(performance.now() - startedAt);
    return result;
  }

  private placeOrderSync(trader: TraderKey, order: NewOrder): PlaceResult {
    const orderId = `ord-${this.orderSeq++}`;
    const tag = randomTag();
    const reject = (reason: string): PlaceResult => ({
      orderId,
      tag,
      status: "rejected",
      filledSize: 0n,
      remainingSize: order.size,
      reason,
    });

    const config = marketById(order.market);
    if (!config) return reject("unknown market");
    if (!this.accounts.has(trader)) return reject("trader not open");

    const shapeError = this.validateShape(config, order);
    if (shapeError) return reject(shapeError);

    return config.kind === "perp"
      ? this.placePerpOrder(trader, config, order, orderId, tag)
      : this.placeSpotOrder(trader, config, order, orderId, tag);
  }

  private validateShape(config: MarketConfig, order: NewOrder): string | null {
    if (order.size <= 0n) return "size must be positive";
    if (order.size % config.lotSize !== 0n) return "size must be a multiple of the lot size";
    if (order.type !== "market" && order.price === undefined) {
      return `${order.type} order requires a price`;
    }
    if (order.type === "market" && order.price === undefined) {
      return "market order requires a worst price";
    }
    if (order.price !== undefined) {
      if (order.price <= 0n) return "price must be positive";
      if (order.price % config.tickSize !== 0n) return "price must be a multiple of the tick size";
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Spot
  // ---------------------------------------------------------------------

  private placeSpotOrder(
    trader: TraderKey,
    config: MarketConfig,
    order: NewOrder,
    orderId: string,
    tag: bigint,
  ): PlaceResult {
    const runtime = this.requireRuntime(config.id);
    const account = this.ensureAccount(trader);
    const bound = order.price!;

    if (order.side === "buy") {
      const principal = mulDivScale(bound, order.size);
      const feeReserve = bpsOf(principal, config.takerFeeBps);
      if (account.freeBalance(config.quote) < principal + feeReserve) {
        return this.rejectResult(orderId, tag, order, "insufficient balance");
      }
      account.lock(config.quote, principal + feeReserve);
    } else {
      if (account.freeBalance(config.base) < order.size) {
        return this.rejectResult(orderId, tag, order, "insufficient balance");
      }
      account.lock(config.base, order.size);
    }

    if (order.type === "postOnly") {
      const check = runtime.book.checkPostOnly(order.side, trader, bound);
      if (check.wouldCross) {
        this.releaseSpotReservation(account, config, order.side, bound, order.size);
        return this.rejectResult(orderId, tag, order, "would cross the book");
      }
      runtime.book.removeSelfCancels(check.selfCancels);
      for (const cancelled of check.selfCancels) this.releaseRestingSpotLock(runtime, cancelled);
      this.insertRestingSpotOrder(runtime, config, trader, order, orderId, tag, bound, order.size);
      return { orderId, tag, status: "open", filledSize: 0n, remainingSize: order.size };
    }

    const outcome = runtime.book.match(order.side, trader, bound, order.size);
    for (const cancelled of outcome.selfCancels) this.releaseRestingSpotLock(runtime, cancelled);

    let filled = 0n;
    for (const match of outcome.fills) {
      this.settleSpotFill(
        runtime,
        config,
        account,
        order.side,
        bound,
        match.resting,
        match.price,
        match.size,
        tag,
      );
      filled += match.size;
    }

    const canRest = order.type === "limit";
    if (canRest && outcome.remaining > 0n) {
      this.insertRestingSpotOrder(
        runtime,
        config,
        trader,
        order,
        orderId,
        tag,
        bound,
        outcome.remaining,
      );
    } else if (outcome.remaining > 0n) {
      this.releaseSpotReservation(account, config, order.side, bound, outcome.remaining);
    }

    return this.resultFor(orderId, tag, order, filled, canRest ? outcome.remaining : 0n);
  }

  private resultFor(
    orderId: string,
    tag: bigint,
    order: NewOrder,
    filled: bigint,
    resting: bigint,
  ): PlaceResult {
    const remainingSize = order.size - filled;
    let status: OrderStatus;
    if (resting > 0n) {
      status = filled > 0n ? "partiallyFilled" : "open";
    } else if (filled === order.size) {
      status = "filled";
    } else if (filled > 0n) {
      status = "partiallyFilled";
    } else {
      status = "cancelled";
    }
    return { orderId, tag, status, filledSize: filled, remainingSize, reason: undefined };
  }

  private rejectResult(orderId: string, tag: bigint, order: NewOrder, reason: string): PlaceResult {
    return { orderId, tag, status: "rejected", filledSize: 0n, remainingSize: order.size, reason };
  }

  private releaseSpotReservation(
    account: Account,
    config: MarketConfig,
    side: Side,
    bound: bigint,
    size: bigint,
  ): void {
    if (side === "buy") {
      const principal = mulDivScale(bound, size);
      const feeReserve = bpsOf(principal, config.takerFeeBps);
      account.unlock(config.quote, principal + feeReserve);
    } else {
      account.unlock(config.base, size);
    }
  }

  private insertRestingSpotOrder(
    runtime: MarketRuntime,
    config: MarketConfig,
    trader: TraderKey,
    order: NewOrder,
    orderId: string,
    tag: bigint,
    price: bigint,
    remaining: bigint,
  ): void {
    const resting: RestingOrder = {
      orderId,
      tag,
      trader,
      side: order.side,
      type: order.type === "postOnly" ? "postOnly" : "limit",
      price,
      size: order.size,
      remaining,
      reduceOnly: false,
      sequence: this.orderSeq,
    };
    runtime.book.insert(resting);
    const token = order.side === "buy" ? config.quote : config.base;
    const amount =
      order.side === "buy"
        ? mulDivScale(price, remaining) + bpsOf(mulDivScale(price, remaining), config.takerFeeBps)
        : remaining;
    runtime.spotLocks.set(orderId, { trader, token, amount });
  }

  private releaseRestingSpotLock(runtime: MarketRuntime, order: RestingOrder): void {
    const lock = runtime.spotLocks.get(order.orderId);
    if (!lock) return;
    const account = this.ensureAccount(lock.trader);
    account.unlock(lock.token, lock.amount);
    runtime.spotLocks.delete(order.orderId);
  }

  private settleSpotFill(
    runtime: MarketRuntime,
    config: MarketConfig,
    takerAccount: Account,
    takerSide: Side,
    takerBound: bigint,
    resting: RestingOrder,
    fillPrice: bigint,
    fillSize: bigint,
    takerTag: bigint,
  ): void {
    const makerAccount = this.ensureAccount(resting.trader);
    const notional = mulDivScale(fillPrice, fillSize);
    const fee = bpsOf(notional, config.takerFeeBps);

    if (takerSide === "buy") {
      const reservedPrincipal = mulDivScale(takerBound, fillSize);
      const reservedFee = bpsOf(reservedPrincipal, config.takerFeeBps);
      takerAccount.consumeLocked(config.quote, reservedPrincipal + reservedFee);
      const refund = reservedPrincipal + reservedFee - notional - fee;
      if (refund > 0n) takerAccount.credit(config.quote, refund);
      takerAccount.credit(config.base, fillSize);
      this.ensureAccount(HOUSE_FEES).credit(config.quote, fee);

      makerAccount.consumeLocked(config.base, fillSize);
      makerAccount.credit(config.quote, notional);
    } else {
      takerAccount.consumeLocked(config.base, fillSize);
      const creditQuote = notional - fee;
      takerAccount.credit(config.quote, creditQuote);
      this.ensureAccount(HOUSE_FEES).credit(config.quote, fee);

      const reservedQuote = mulDivScale(resting.price, fillSize);
      const reservedFee = bpsOf(reservedQuote, config.takerFeeBps);
      makerAccount.consumeLocked(config.quote, reservedQuote + reservedFee);
      makerAccount.credit(config.quote, reservedFee);
      makerAccount.credit(config.base, fillSize);
    }

    const lock = runtime.spotLocks.get(resting.orderId);
    if (lock) {
      if (takerSide === "buy") {
        lock.amount -= fillSize;
      } else {
        const reservedQuote = mulDivScale(resting.price, fillSize);
        lock.amount -= reservedQuote + bpsOf(reservedQuote, config.takerFeeBps);
      }
      if (resting.remaining === 0n) runtime.spotLocks.delete(resting.orderId);
    }

    const now = this.clock.nowMs();
    this.sequence += 1;
    this.recordVolume(runtime, notional, now);
    this.emitFill({
      market: config.id,
      price: fillPrice,
      size: fillSize,
      takerSide,
      takerTag,
      makerTag: resting.tag,
      timestampMs: now,
      sequence: this.sequence,
    });
  }

  // ---------------------------------------------------------------------
  // Perpetuals
  // ---------------------------------------------------------------------

  private settlePendingFunding(account: Account, marketId: MarketId, runtime: MarketRuntime): void {
    const position = account.positionIn(marketId, runtime.fundingIndex);
    if (position.size !== 0n) {
      const deltaIndex = runtime.fundingIndex - position.fundingIndexSnapshot;
      if (deltaIndex !== 0n) {
        const payment = mulDivScale(position.size, deltaIndex);
        account.credit(QUOTE_TOKEN, payment);
        this.ensureAccount(HOUSE_INSURANCE).debit(QUOTE_TOKEN, payment);
      }
    }
    position.fundingIndexSnapshot = runtime.fundingIndex;
  }

  private unrealizedPnl(position: Position, markPrice: bigint): bigint {
    if (position.size === 0n) return 0n;
    return mulDivScale(position.size, markPrice - position.entryPrice);
  }

  private pendingFunding(position: Position, runtime: MarketRuntime): bigint {
    if (position.size === 0n) return 0n;
    return mulDivScale(position.size, runtime.fundingIndex - position.fundingIndexSnapshot);
  }

  private equityOf(account: Account): bigint {
    let equity = account.freeBalance(QUOTE_TOKEN);
    for (const [marketId, position] of account.positions) {
      const runtime = this.runtimes.get(marketId);
      if (!runtime || runtime.markPrice === null || position.size === 0n) continue;
      equity += this.unrealizedPnl(position, runtime.markPrice);
      equity += this.pendingFunding(position, runtime);
    }
    return equity;
  }

  private marginRequirement(
    account: Account,
    bps: number,
    overrideMarket?: MarketId,
    overrideSize?: bigint,
  ): bigint {
    let total = 0n;
    const seen = new Set<MarketId>();
    for (const [marketId, position] of account.positions) {
      const runtime = this.runtimes.get(marketId);
      if (!runtime || runtime.markPrice === null) continue;
      const size = marketId === overrideMarket ? (overrideSize ?? 0n) : position.size;
      seen.add(marketId);
      if (size === 0n) continue;
      const notional = mulDivScale(absBigInt(size), runtime.markPrice);
      total += bpsOf(notional, bps);
    }
    if (overrideMarket && !seen.has(overrideMarket) && overrideSize && overrideSize !== 0n) {
      const runtime = this.runtimes.get(overrideMarket);
      if (runtime && runtime.markPrice !== null) {
        const notional = mulDivScale(absBigInt(overrideSize), runtime.markPrice);
        total += bpsOf(notional, bps);
      }
    }
    return total;
  }

  private placePerpOrder(
    trader: TraderKey,
    config: MarketConfig,
    order: NewOrder,
    orderId: string,
    tag: bigint,
  ): PlaceResult {
    const runtime = this.requireRuntime(config.id);
    const account = this.ensureAccount(trader);
    if (runtime.markPrice === null || runtime.markPriceUpdatedAtMs === null) {
      return this.rejectResult(orderId, tag, order, "no price available");
    }

    const position = account.positionIn(config.id, runtime.fundingIndex);
    let size = order.size;

    if (order.reduceOnly) {
      const reducesDirection =
        (order.side === "sell" && position.size > 0n) ||
        (order.side === "buy" && position.size < 0n);
      if (!reducesDirection) {
        return this.rejectResult(orderId, tag, order, "reduce-only: no position to reduce");
      }
      const maxReduce = absBigInt(position.size);
      const clamped = size < maxReduce ? size : maxReduce;
      size = clamped - (clamped % config.lotSize);
      if (size === 0n) {
        return this.rejectResult(orderId, tag, order, "reduce-only: no position to reduce");
      }
    }

    const bound = order.price!;
    const signedDelta = order.side === "buy" ? size : -size;
    const resultingSize = position.size + signedDelta;
    const exposureIncreasing = absBigInt(resultingSize) > absBigInt(position.size);
    const worstCaseFee = bpsOf(mulDivScale(bound, size), config.takerFeeBps);

    // The taker fee always comes out of free balance, whichever direction the
    // trade moves exposure, so an account right at the edge of its free
    // balance must still be able to afford it.
    if (account.freeBalance(QUOTE_TOKEN) < worstCaseFee) {
      return this.rejectResult(orderId, tag, order, "insufficient margin");
    }

    if (exposureIncreasing) {
      const age = this.clock.nowMs() - runtime.markPriceUpdatedAtMs;
      if (age > config.maxStalePriceMs) {
        return this.rejectResult(orderId, tag, order, "stale price");
      }
      const requiredMargin = this.marginRequirement(
        account,
        config.initialMarginBps,
        config.id,
        resultingSize,
      );
      if (this.equityOf(account) < requiredMargin + worstCaseFee) {
        return this.rejectResult(orderId, tag, order, "insufficient margin");
      }
    }

    if (order.type === "postOnly") {
      const check = runtime.book.checkPostOnly(order.side, trader, bound);
      if (check.wouldCross) {
        return this.rejectResult(orderId, tag, order, "would cross the book");
      }
      runtime.book.removeSelfCancels(check.selfCancels);
      this.insertRestingPerpOrder(runtime, trader, order, orderId, tag, bound, size, size);
      return { orderId, tag, status: "open", filledSize: 0n, remainingSize: size };
    }

    const outcome = runtime.book.match(order.side, trader, bound, size);

    let filled = 0n;
    for (const match of outcome.fills) {
      this.settlePerpFill(
        runtime,
        config,
        account,
        order.side,
        match.resting,
        match.price,
        match.size,
        tag,
      );
      filled += match.size;
    }

    const canRest = order.type === "limit";
    if (canRest && outcome.remaining > 0n) {
      this.insertRestingPerpOrder(
        runtime,
        trader,
        order,
        orderId,
        tag,
        bound,
        size,
        outcome.remaining,
      );
    }

    return this.resultFor(
      orderId,
      tag,
      { ...order, size },
      filled,
      canRest ? outcome.remaining : 0n,
    );
  }

  private insertRestingPerpOrder(
    runtime: MarketRuntime,
    trader: TraderKey,
    order: NewOrder,
    orderId: string,
    tag: bigint,
    price: bigint,
    totalSize: bigint,
    remaining: bigint,
  ): void {
    const resting: RestingOrder = {
      orderId,
      tag,
      trader,
      side: order.side,
      type: order.type === "postOnly" ? "postOnly" : "limit",
      price,
      size: totalSize,
      remaining,
      reduceOnly: Boolean(order.reduceOnly),
      sequence: this.orderSeq,
    };
    runtime.book.insert(resting);
  }

  private settlePerpFill(
    runtime: MarketRuntime,
    config: MarketConfig,
    takerAccount: Account,
    takerSide: Side,
    resting: RestingOrder,
    fillPrice: bigint,
    fillSize: bigint,
    takerTag: bigint,
  ): void {
    const makerAccount = this.ensureAccount(resting.trader);
    const takerDelta = takerSide === "buy" ? fillSize : -fillSize;
    const makerDelta = -takerDelta;

    this.applyPerpPositionChange(takerAccount, config.id, runtime, takerDelta, fillPrice);
    this.applyPerpPositionChange(makerAccount, config.id, runtime, makerDelta, fillPrice);

    const notional = mulDivScale(fillPrice, fillSize);
    const fee = bpsOf(notional, config.takerFeeBps);
    takerAccount.debit(QUOTE_TOKEN, fee);
    this.ensureAccount(HOUSE_FEES).credit(QUOTE_TOKEN, fee);

    const now = this.clock.nowMs();
    this.sequence += 1;
    this.recordVolume(runtime, notional, now);
    this.emitFill({
      market: config.id,
      price: fillPrice,
      size: fillSize,
      takerSide,
      takerTag,
      makerTag: resting.tag,
      timestampMs: now,
      sequence: this.sequence,
    });
  }

  private applyPerpPositionChange(
    account: Account,
    marketId: MarketId,
    runtime: MarketRuntime,
    signedDelta: bigint,
    fillPrice: bigint,
  ): void {
    this.settlePendingFunding(account, marketId, runtime);
    const position = account.positionIn(marketId, runtime.fundingIndex);
    const oldSize = position.size;
    const oldPositiveContribution = oldSize > 0n ? oldSize : 0n;

    if (oldSize === 0n || signOf(oldSize) === signOf(signedDelta)) {
      const newSize = oldSize + signedDelta;
      const oldNotional = mulDivScale(absBigInt(oldSize), position.entryPrice);
      const addedNotional = mulDivScale(absBigInt(signedDelta), fillPrice);
      position.entryPrice =
        newSize === 0n ? 0n : divScale(oldNotional + addedNotional, absBigInt(newSize));
      position.size = newSize;
    } else {
      const absDelta = absBigInt(signedDelta);
      const absOld = absBigInt(oldSize);
      const closingSize = absDelta < absOld ? absDelta : absOld;
      const closingSigned = closingSize * signOf(oldSize);
      const realized = mulDivScale(closingSigned, fillPrice - position.entryPrice);
      account.credit(QUOTE_TOKEN, realized);
      this.ensureAccount(HOUSE_INSURANCE).debit(QUOTE_TOKEN, realized);

      const newSize = oldSize + signedDelta;
      if (absDelta > absOld) {
        position.entryPrice = fillPrice;
      } else if (newSize === 0n) {
        position.entryPrice = 0n;
      }
      position.size = newSize;
    }

    const newPositiveContribution = position.size > 0n ? position.size : 0n;
    runtime.openInterest += newPositiveContribution - oldPositiveContribution;
  }

  async updateFunding(market: MarketId): Promise<void> {
    const runtime = this.requireRuntime(market);
    if (runtime.markPrice === null) return;
    const mid = runtime.book.mid();
    if (mid === null) return;
    const premium = divScale(mid - runtime.markPrice, runtime.markPrice);
    const capBps = this.maxFundingRateBpsPerUpdate;
    const capScaled = (BigInt(capBps) * 1_000_000n) / 10_000n;
    const clamped = premium > capScaled ? capScaled : premium < -capScaled ? -capScaled : premium;
    const deltaIndex = mulDivScale(runtime.markPrice, clamped);
    runtime.fundingIndex += deltaIndex;
  }

  async liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean> {
    const runtime = this.requireRuntime(market);
    if (runtime.markPrice === null || runtime.markPriceUpdatedAtMs === null) return false;
    if (this.clock.nowMs() - runtime.markPriceUpdatedAtMs > runtime.config.maxStalePriceMs)
      return false;
    if (!this.accounts.has(liquidator) || !this.accounts.has(target)) return false;

    const targetAccount = this.ensureAccount(target);
    this.settlePendingFunding(targetAccount, market, runtime);
    const position = targetAccount.positionIn(market, runtime.fundingIndex);
    if (position.size === 0n) return false;

    const equity = this.equityOf(targetAccount);
    const maintenanceRequirement = this.marginRequirement(
      targetAccount,
      runtime.config.maintenanceMarginBps,
    );
    if (equity >= maintenanceRequirement) return false;

    const mark = runtime.markPrice;
    const penalty = bpsOf(mark, runtime.config.liquidationPenaltyBps);
    const executionPrice = position.size > 0n ? mark - penalty : mark + penalty;

    const closingSigned = position.size;
    const realized = mulDivScale(closingSigned, executionPrice - position.entryPrice);
    targetAccount.credit(QUOTE_TOKEN, realized);
    this.ensureAccount(HOUSE_INSURANCE).debit(QUOTE_TOKEN, realized);

    const oldPositiveContribution = position.size > 0n ? position.size : 0n;
    const liquidatedSize = position.size;
    position.size = 0n;
    position.entryPrice = 0n;
    runtime.openInterest += 0n - oldPositiveContribution;

    const freeBalance = targetAccount.freeBalance(QUOTE_TOKEN);
    if (freeBalance < 0n) {
      const shortfall = -freeBalance;
      this.ensureAccount(HOUSE_INSURANCE).debit(QUOTE_TOKEN, shortfall);
      targetAccount.credit(QUOTE_TOKEN, shortfall);
    }

    const liquidatorAccount = this.ensureAccount(liquidator);
    this.applyPerpPositionChange(
      liquidatorAccount,
      market,
      runtime,
      liquidatedSize,
      executionPrice,
    );

    return true;
  }

  async cancelAll(trader: TraderKey, market: MarketId): Promise<number> {
    const runtime = this.requireRuntime(market);
    const cancelled = runtime.book.cancelAllForTrader(trader);
    for (const order of cancelled) {
      if (runtime.config.kind === "spot") this.releaseRestingSpotLock(runtime, order);
    }
    return cancelled.length;
  }

  async traderState(trader: TraderKey): Promise<TraderState> {
    const account = this.ensureAccount(trader);
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

    const openOrders: OrderView[] = [];
    for (const config of MARKETS) {
      const runtime = this.requireRuntime(config.id);
      for (const resting of runtime.book.openOrdersForTrader(trader)) {
        openOrders.push({
          orderId: resting.orderId,
          tag: resting.tag,
          market: config.id,
          side: resting.side,
          type: resting.type,
          price: resting.price,
          size: resting.size,
          remainingSize: resting.remaining,
          reduceOnly: resting.reduceOnly,
        });
      }
    }

    return { trader, balances, positions, openOrders, equity: this.equityOf(account) };
  }
}
