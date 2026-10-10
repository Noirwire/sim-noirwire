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
}

export interface NewOrder {
  market: MarketId;
  side: Side;
  type: OrderType;
  price?: bigint;
  size: bigint;
  reduceOnly?: boolean;
}

export type OrderStatus = "open" | "filled" | "partiallyFilled" | "cancelled" | "rejected";

export interface PlaceResult {
  orderId: string;
  tag: bigint;
  status: OrderStatus;
  filledSize: bigint;
  remainingSize: bigint;
  reason?: string;
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
  traderState(trader: TraderKey): Promise<TraderState>;
  updateFunding(market: MarketId): Promise<void>;
  liquidate(liquidator: TraderKey, target: TraderKey, market: MarketId): Promise<boolean>;
  onFill(listener: (fill: Fill) => void): () => void;
}
