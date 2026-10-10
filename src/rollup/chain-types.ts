/**
 * What the program adapter hands to the rest of this service: plain values in
 * the program's own units (a price in quote atoms per lot, a size in lots),
 * with nothing of the client package's types in them.
 */

export type ChainSide = "buy" | "sell";
export type ChainOrderType = "limit" | "postOnly" | "ioc" | "market";

export interface ChainMarket {
  marketId: number;
  kind: "perp" | "spot";
  tick: bigint;
  baseLot: bigint;
  minNotional: bigint;
  bandBps: number;
  initialMarginBps: number;
  maxMoveBps: number;
  maxPriceAgeSeconds: number;
  fundingIntervalSeconds: number;
  baseToken: number;
  quoteToken: number;
}

export interface PublicAddresses {
  exchange: string;
  stats: string;
  market: string;
  tape: string;
  priceFeed: string;
}

export interface ChainPrice {
  price: bigint;
  publishTimeSeconds: number;
}

export interface ChainFill {
  sequence: bigint;
  price: bigint;
  size: bigint;
  timeSeconds: number;
  takerSide: ChainSide;
  makerReceipt: Uint8Array;
  takerReceipt: Uint8Array;
}

export interface ChainTape {
  lastSequence: bigint;
  /** Newest first, as the tape account holds them. */
  fills: ChainFill[];
}

export interface ChainStats {
  orders: bigint;
  fills: bigint;
  /** Per market id. */
  openInterest: bigint[];
}

export interface ChainOrder {
  side: ChainSide;
  type: ChainOrderType;
  price: bigint;
  size: bigint;
  reduceOnly: boolean;
  secret: Uint8Array;
  /** Unix seconds after which a resting remainder is void; none when absent. */
  restingExpirySeconds?: number;
}

/**
 * `invalid`: refused before signing, by the market's public settings.
 * `failed`: the transaction landed and the program refused it; nothing changed.
 * `expired`: no result showed before the order's expiry.
 */
export type PlaceStatus =
  "filled" | "rested" | "cancelled" | "refused" | "expired" | "invalid" | "failed" | "unknown";

export interface PlaceOutcome {
  status: PlaceStatus;
  filled: bigint;
  rested: bigint;
  /** From the send to the result showing in the trader's private view, as the client timed it. */
  sendToResultMs: number;
  reason?: string;
  /**
   * Only with `unknown`: the client stopped waiting while the order could
   * still run. Resolves, once the rollup's clock is past the order's expiry
   * at the latest, to what became of it: executed after all, or `expired`.
   * The trader sends nothing else until then.
   */
  settled?: Promise<PlaceOutcome>;
}

/** Whether the program executed the order and counted it, whatever became of it. */
export const executed = (outcome: PlaceOutcome): boolean =>
  !["expired", "invalid", "failed", "unknown"].includes(outcome.status);

/**
 * `nothing` covers a seat that is not open, has no position, is healthy, or is past the worst price.
 * `refused`: the program refused the liquidator itself, as when the seat is its own.
 */
export type LiquidationOutcome =
  "liquidated" | "nothing" | "stalePrice" | "liquidatorMarginInsufficient" | "refused" | "noResult";

export interface SeatView {
  seat: number;
  collateral: bigint;
  /** Per token index. */
  spot: { available: bigint; locked: bigint }[];
  /** Per market id. */
  perp: { base: bigint; quote: bigint }[];
  ordersMarketId: number;
  orders: { side: ChainSide; price: bigint; remaining: bigint; sequence: bigint }[];
}

export type DepositTarget = "collateral" | { spotToken: number };

/** Where a trader's four live order keys sit in their derivation. It holds no secret. */
export interface KeyCheckpoint {
  indices: number[];
  nextIndex: number;
}

export type Unsubscribe = () => Promise<void>;
