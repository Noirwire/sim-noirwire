/**
 * What the hedge controller needs from an external perpetuals venue. Sizes are
 * SOL and prices and margin are dollars, all scaled like the rest of the
 * service. A position is signed: negative is short.
 */

/** The venue's own limits on an order, read from the venue rather than assumed. */
export interface HedgeMarketRules {
  /** The least notional the venue accepts for one order, in dollars. */
  minOrderNotional: bigint;
  /** Order sizes are whole multiples of this. */
  sizeIncrement: bigint;
  /** Order prices are whole multiples of this. */
  priceIncrement: bigint;
}

/** The hedge account as the venue reports it now. */
export interface HedgeAccount {
  /** Signed SOL position. */
  position: bigint;
  /** The margin the account holds, in dollars: what the position may be sized against. */
  equity: bigint;
}

/** An immediate-or-cancel order: it fills what it can at the limit price or better, and the rest is dropped. */
export interface HedgeOrder {
  /** Chosen by the controller, so an order can be found again, and cancelled, after an unclear answer. */
  clientId: string;
  side: "buy" | "sell";
  size: bigint;
  /** The worst price the order may fill at. */
  limitPrice: bigint;
  reduceOnly: boolean;
}

/** The venue's answer to an order. It says what the venue took, never what was filled: the position says that. */
export type HedgeAck = { status: "accepted" } | { status: "rejected"; reason: string };

export interface HedgeFill {
  clientId: string;
  side: "buy" | "sell";
  size: bigint;
  price: bigint;
  atMs: number;
}

export type HedgeHealth = { ok: true } | { ok: false; reason: string };

export interface HedgeVenue {
  rules(): Promise<HedgeMarketRules>;
  account(): Promise<HedgeAccount>;
  /** Throws, or resolves without an answer the controller can believe, when the outcome is unknown. */
  placeIoc(order: HedgeOrder): Promise<HedgeAck>;
  cancel(clientId: string): Promise<void>;
  fills(sinceMs: number): Promise<HedgeFill[]>;
  /** Whether the venue answers and is trading: its heartbeat. */
  health(): Promise<HedgeHealth>;
}
