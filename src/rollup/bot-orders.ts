import type { FillOrigin } from "../data/stats.js";
import type { MarketId, TraderKey } from "../engine/types.js";

interface BotOrder {
  market: MarketId;
  trader: TraderKey;
  secret: Uint8Array;
  retiredAtMs: number | null;
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

  add(market: MarketId, trader: TraderKey, secret: Uint8Array): void {
    this.orders.push({ market, trader, secret, retiredAtMs: null });
  }

  retire(secret: Uint8Array, atMs: number): void {
    for (const order of this.orders) {
      if (order.secret === secret && order.retiredAtMs === null) order.retiredAtMs = atMs;
    }
  }

  /** Every live order of `trader` on `market` was cancelled at `atMs`. */
  retireAll(market: MarketId, trader: TraderKey, atMs: number): void {
    for (const order of this.orders) {
      if (order.market === market && order.trader === trader && order.retiredAtMs === null) {
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
