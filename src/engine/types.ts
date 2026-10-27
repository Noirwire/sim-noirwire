export type MarketId = string;
export type Side = "buy" | "sell";
export type OrderType = "limit" | "postOnly" | "ioc" | "market";
export type MarketKind = "perp" | "spot";
export type TraderKey = string;

export interface MarketInfo {
  id: MarketId;
  kind: MarketKind;
  base: string;
  quote: string;
  tickSize: bigint;
  lotSize: bigint;
  maxLeverage: number;
  markPrice: bigint | null;
  markPriceUpdatedAtMs: number | null;
  /** True while a venue is still bringing its mark from a set-up price to the real one. */
  warmingUp?: boolean;
  change24h: number | null;
  volume24h: bigint;
  openInterest: bigint | null;
  /** Set while the venue would refuse a resting order that adds exposure: why. */
  quotesRefusedBecause?: string;
  /**
   * Set together with `quotesRefusedBecause` when the only thing wrong is that
   * the market is reduce-only: it still takes orders flagged reduce-only, so
   * a maker can still flatten its position there.
   */
  takesReduceOnlyOrders?: boolean;
  /**
   * In base units, where the venue has one: the most a trader may reach on
   * one side, its position on that side, its open orders there and a new
   * order together.
   */
  positionCap?: bigint;
}

export interface NewOrder {
  market: MarketId;
  side: Side;
  type: OrderType;
  price?: bigint;
  size: bigint;
  reduceOnly?: boolean;
  /**
   * How long a resting remainder stays valid after it is placed, in seconds.
   * A venue with order expiry makes it void then by itself; the in-memory
   * venue leaves orders resting until they are cancelled.
   */
  expiresInSeconds?: number;
  /**
   * The absolute time a resting remainder becomes void, in milliseconds. A caller that has recorded
   * the expiry elsewhere sets it so the venue uses exactly that time, whenever the order is sent;
   * it takes precedence over `expiresInSeconds`.
   */
  expiresAtMs?: number;
}

export type OrderStatus = "open" | "filled" | "partiallyFilled" | "cancelled" | "rejected";

export interface PlaceResult {
  orderId: string;
  tag: bigint;
  status: OrderStatus;
  filledSize: bigint;
  remainingSize: bigint;
  reason?: string;
  /**
   * Set with a `rejected` status when the order may still have been executed: the
   * rejection is this service's guess, not the venue's answer. A caller that
   * needs the truth reconciles before it sends or cancels anything else.
   */
  outcomeUnknown?: true;
  /**
   * Set with a `rejected` status when the order provably never ran, for a cause that passes by itself
   * (its transaction window ran out). A caller may drop the rest of its batch and send again later.
   */
  didNotRun?: true;
}

export interface Fill {
  market: MarketId;
  price: bigint;
  size: bigint;
  takerSide: Side;
  takerTag: bigint;
  makerTag: bigint;
  timestampMs: number;
  sequence: number;
}

export interface TokenBalance {
  balance: bigint;
  locked: bigint;
}

export interface PerpPositionView {
  size: bigint;
  entryPrice: bigint;
}

export interface OrderView {
  orderId: string;
  tag: bigint;
  market: MarketId;
  side: Side;
  type: OrderType;
  price: bigint | null;
  size: bigint;
  remainingSize: bigint;
  reduceOnly: boolean;
}

export interface TraderState {
  trader: TraderKey;
  balances: Record<string, TokenBalance>;
  positions: Record<MarketId, PerpPositionView>;
  openOrders: OrderView[];
  equity: bigint;
}

export interface Venue {
  markets(): Promise<MarketInfo[]>;
  publishPrice(market: MarketId, price: bigint, publishedAtMs: number): Promise<void>;
  openTrader(trader: TraderKey): Promise<void>;
  deposit(trader: TraderKey, token: string, amount: bigint): Promise<void>;
  placeOrder(trader: TraderKey, order: NewOrder): Promise<PlaceResult>;
  cancelAll(trader: TraderKey, market: MarketId): Promise<number>;
  /**
   * Cancels the one resting order that `traderState` lists under `orderId`. False when it was
   * already gone (filled, expired or cancelled). A venue without it can only cancel everything.
   */
  cancelOrder?(trader: TraderKey, market: MarketId, orderId: string): Promise<boolean>;
  traderState(trader: TraderKey): Promise<TraderState>;
  updateFunding(market: MarketId): Promise<void>;
  liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean>;
  /**
   * How many order calls for `trader` were handed on and have neither answered nor failed, though
   * their caller stopped waiting. A venue that never gives up on a call has none.
   */
  unsettledPlaces?(trader: TraderKey): number;
  onFill(listener: (fill: Fill) => void): () => void;
}
