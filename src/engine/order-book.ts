import type { OrderType, Side, TraderKey } from "./types.js";

export interface RestingOrder {
  orderId: string;
  tag: bigint;
  trader: TraderKey;
  side: Side;
  type: Extract<OrderType, "limit" | "postOnly">;
  price: bigint;
  size: bigint;
  remaining: bigint;
  reduceOnly: boolean;
}

interface MatchedFill {
  resting: RestingOrder;
  price: bigint;
  size: bigint;
}

interface MatchOutcome {
  fills: MatchedFill[];
  selfCancels: RestingOrder[];
  remaining: bigint;
}

interface PostOnlyCheck {
  selfCancels: RestingOrder[];
  wouldCross: boolean;
}

const crosses = (side: Side, restingPrice: bigint, bound: bigint): boolean =>
  side === "buy" ? restingPrice <= bound : restingPrice >= bound;

const betterThan = (side: Side, a: bigint, b: bigint): boolean => (side === "buy" ? a > b : a < b);

/** One market's resting orders, each side sorted best price first and oldest first within a price. */
export class OrderBook {
  private readonly bids: RestingOrder[] = [];
  private readonly asks: RestingOrder[] = [];

  private sideLevels(side: Side): RestingOrder[] {
    return side === "buy" ? this.bids : this.asks;
  }

  private oppositeLevels(side: Side): RestingOrder[] {
    return side === "buy" ? this.asks : this.bids;
  }

  mid(): bigint | null {
    const bid = this.bids[0];
    const ask = this.asks[0];
    if (!bid || !ask) return null;
    return (bid.price + ask.price) / 2n;
  }

  /** A taker never fills against itself: its own resting order in the way is cancelled instead. */
  match(takerSide: Side, takerTrader: TraderKey, bound: bigint, size: bigint): MatchOutcome {
    const fills: MatchedFill[] = [];
    const selfCancels: RestingOrder[] = [];
    const opposite = this.oppositeLevels(takerSide);
    let remaining = size;

    while (remaining > 0n && opposite.length > 0) {
      const best = opposite[0];
      if (!crosses(takerSide, best.price, bound)) break;
      if (best.trader === takerTrader) {
        opposite.shift();
        selfCancels.push(best);
        continue;
      }
      const matchSize = remaining < best.remaining ? remaining : best.remaining;
      fills.push({ resting: best, price: best.price, size: matchSize });
      best.remaining -= matchSize;
      remaining -= matchSize;
      if (best.remaining === 0n) opposite.shift();
    }

    return { fills, selfCancels, remaining };
  }

  checkPostOnly(side: Side, trader: TraderKey, price: bigint): PostOnlyCheck {
    const selfCancels: RestingOrder[] = [];
    for (const candidate of this.oppositeLevels(side)) {
      if (!crosses(side, candidate.price, price)) break;
      if (candidate.trader !== trader) return { selfCancels, wouldCross: true };
      selfCancels.push(candidate);
    }
    return { selfCancels, wouldCross: false };
  }

  remove(orders: RestingOrder[]): void {
    for (const order of orders) {
      const levels = this.sideLevels(order.side);
      const index = levels.indexOf(order);
      if (index >= 0) levels.splice(index, 1);
    }
  }

  insert(order: RestingOrder): void {
    const levels = this.sideLevels(order.side);
    const firstWorse = levels.findIndex((resting) =>
      betterThan(order.side, order.price, resting.price),
    );
    levels.splice(firstWorse === -1 ? levels.length : firstWorse, 0, order);
  }

  cancelAllForTrader(trader: TraderKey): RestingOrder[] {
    const cancelled: RestingOrder[] = [];
    for (const levels of [this.bids, this.asks]) {
      for (let i = levels.length - 1; i >= 0; i -= 1) {
        if (levels[i].trader === trader) cancelled.push(...levels.splice(i, 1));
      }
    }
    return cancelled;
  }

  openOrdersForTrader(trader: TraderKey): RestingOrder[] {
    return [...this.bids, ...this.asks].filter((order) => order.trader === trader);
  }
}
