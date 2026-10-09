import type { Fill, MarketId } from "../engine/types.js";

const DEFAULT_CAPACITY_PER_MARKET = 2_000;

/** Keeps the most recent fills per market, bounded so memory never grows without limit. */
export class TapeStore {
  private readonly byMarket = new Map<MarketId, Fill[]>();

  constructor(private readonly capacityPerMarket = DEFAULT_CAPACITY_PER_MARKET) {}

  record(fill: Fill): void {
    const list = this.byMarket.get(fill.market) ?? [];
    list.push(fill);
    if (list.length > this.capacityPerMarket) list.shift();
    this.byMarket.set(fill.market, list);
  }

  recent(market: MarketId, limit: number): Fill[] {
    const list = this.byMarket.get(market) ?? [];
    return list.slice(Math.max(0, list.length - limit));
  }
}
