import type { FillOrigin } from "../data/stats.js";
import type { MarketId, TraderKey } from "../engine/types.js";

interface BotOrder {
  market: MarketId;
  trader: TraderKey;
  secret: Uint8Array;
  retiredAtMs: number | null;
  /** Counts the orders added, so a cancel can tell the ones it was issued over from later ones. */
  sequence: number;
}

const KEEP_AFTER_RETIRED_MS = 10_000;

/**
 * The secrets of the orders this service's bots placed. A fill on the public
 * tape names nobody; a bot's fill is recognised by recomputing its receipt
 * from one of these secrets. A secret is kept until its order can no longer
 * fill and the tape has been read past that moment.
 */
export class BotOrderSecrets {
  private readonly orders: BotOrder[] = [];
  private added = 0;

  add(market: MarketId, trader: TraderKey, secret: Uint8Array): void {
    this.added += 1;
    this.orders.push({ market, trader, secret, retiredAtMs: null, sequence: this.added });
  }

  /** The orders added so far, to fence a cancel with. */
  mark(): number {
    return this.added;
  }

  retire(secret: Uint8Array, atMs: number): void {
    for (const order of this.orders) {
      if (order.secret === secret && order.retiredAtMs === null) order.retiredAtMs = atMs;
    }
  }

  /**
   * Every live order of `trader` on `market` that was added by `fence` (a `mark`) was cancelled at
   * `atMs`. A later order was placed after the cancel was issued, so it is not covered.
   */
  retireAll(market: MarketId, trader: TraderKey, atMs: number, fence = Infinity): void {
    for (const order of this.orders) {
      if (
        order.market === market &&
        order.trader === trader &&
        order.retiredAtMs === null &&
        order.sequence <= fence
      ) {
        order.retiredAtMs = atMs;
      }
    }
  }

  /** Forgets the orders of `market` that ended well before the tape was last read in full. */
  forgetEndedBefore(market: MarketId, tapeReadAtMs: number): void {
    for (let at = this.orders.length - 1; at >= 0; at -= 1) {
      const order = this.orders[at]!;
      if (
        order.market === market &&
        order.retiredAtMs !== null &&
        order.retiredAtMs + KEEP_AFTER_RETIRED_MS < tapeReadAtMs
      ) {
        this.orders.splice(at, 1);
      }
    }
  }

  of(market: MarketId): Uint8Array[] {
    return this.orders.filter((order) => order.market === market).map((order) => order.secret);
  }
}

/**
 * A fill counts as bot activity only when both of its receipts are a bot's.
 * Anything else has a user on at least one side.
 */
export const originOf = (roles: { maker: boolean; taker: boolean }): FillOrigin =>
  roles.maker && roles.taker ? "bot" : "user";
