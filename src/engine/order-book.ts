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
  sequence: number;
}

export interface MatchedFill {
  resting: RestingOrder;
  price: bigint;
  size: bigint;
}

export interface MatchOutcome {
  fills: MatchedFill[];
  selfCancels: RestingOrder[];
  remaining: bigint;
}

export interface PostOnlyCheck {
  selfCancels: RestingOrder[];
  wouldCross: boolean;
}

const crosses = (side: Side, restingPrice: bigint, bound: bigint): boolean =>
  side === "buy" ? restingPrice <= bound : restingPrice >= bound;

const betterThan = (side: Side, a: bigint, b: bigint): boolean => (side === "buy" ? a > b : a < b);

export class OrderBook {
  private readonly bids: RestingOrder[] = [];
  private readonly asks: RestingOrder[] = [];
  private readonly byId = new Map<string, RestingOrder>();

  private sideLevels(side: Side): RestingOrder[] {
    return side === "buy" ? this.bids : this.asks;
  }

  private oppositeLevels(side: Side): RestingOrder[] {
    return side === "buy" ? this.asks : this.bids;
  }

  bestBid(): bigint | null {
    return this.bids.length > 0 ? this.bids[0]!.price : null;
  }

  bestAsk(): bigint | null {
    return this.asks.length > 0 ? this.asks[0]!.price : null;
  }

  mid(): bigint | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === null || ask === null) return null;
    return (bid + ask) / 2n;
  }

  match(takerSide: Side, takerTrader: TraderKey, bound: bigint, size: bigint): MatchOutcome {
    const fills: MatchedFill[] = [];
    const selfCancels: RestingOrder[] = [];
    const opposite = this.oppositeLevels(takerSide);
    let remaining = size;

    while (remaining > 0n && opposite.length > 0) {
      const best = opposite[0]!;
      if (!crosses(takerSide, best.price, bound)) break;
      if (best.trader === takerTrader) {
        opposite.shift();
        this.byId.delete(best.orderId);
        selfCancels.push(best);
        continue;
      }
      const matchSize = remaining < best.remaining ? remaining : best.remaining;
      fills.push({ resting: best, price: best.price, size: matchSize });
      best.remaining -= matchSize;
      remaining -= matchSize;
      if (best.remaining === 0n) {
        opposite.shift();
        this.byId.delete(best.orderId);
      }
    }

    return { fills, selfCancels, remaining };
  }

  checkPostOnly(side: Side, trader: TraderKey, price: bigint): PostOnlyCheck {
    const opposite = this.oppositeLevels(side);
    const selfCancels: RestingOrder[] = [];
    for (const candidate of opposite) {
      if (!crosses(side, candidate.price, price)) break;
      if (candidate.trader === trader) {
        selfCancels.push(candidate);
        continue;
      }
      return { selfCancels, wouldCross: true };
    }
    return { selfCancels, wouldCross: false };
  }

  removeSelfCancels(selfCancels: RestingOrder[]): void {
    for (const order of selfCancels) {
      const levels = this.sideLevels(order.side);
      const index = levels.findIndex((candidate) => candidate.orderId === order.orderId);
      if (index >= 0) levels.splice(index, 1);
      this.byId.delete(order.orderId);
    }
  }

  insert(order: RestingOrder): void {
    const levels = this.sideLevels(order.side);
    let index = levels.length;
    for (let i = 0; i < levels.length; i += 1) {
      if (betterThan(order.side, order.price, levels[i]!.price)) {
        index = i;
        break;
      }
    }
    levels.splice(index, 0, order);
    this.byId.set(order.orderId, order);
  }

  get(orderId: string): RestingOrder | undefined {
    return this.byId.get(orderId);
  }

  cancel(orderId: string): RestingOrder | undefined {
    const order = this.byId.get(orderId);
    if (!order) return undefined;
    const levels = this.sideLevels(order.side);
    const index = levels.findIndex((candidate) => candidate.orderId === orderId);
    if (index >= 0) levels.splice(index, 1);
    this.byId.delete(orderId);
    return order;
  }

  cancelAllForTrader(trader: TraderKey): RestingOrder[] {
    const cancelled: RestingOrder[] = [];
    for (const levels of [this.bids, this.asks]) {
      for (let i = levels.length - 1; i >= 0; i -= 1) {
        if (levels[i]!.trader === trader) {
          cancelled.push(levels[i]!);
          this.byId.delete(levels[i]!.orderId);
          levels.splice(i, 1);
        }
      }
    }
    return cancelled;
  }

  openOrdersForTrader(trader: TraderKey): RestingOrder[] {
    return [...this.bids, ...this.asks].filter((order) => order.trader === trader);
  }
}
