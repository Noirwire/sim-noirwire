import type { StatsTracker } from "../data/stats.js";
import type { Fill, NewOrder, PlaceResult, TraderKey, Venue } from "../engine/types.js";

/**
 * Wraps a Venue so every order a bot places, and every fill it produces, is
 * counted in the bot activity bucket. A fill carries no trader identity by
 * the time any other listener sees it, so it is classified right here,
 * while the trader placing this very order is still known: a temporary
 * listener captures exactly the fills this one `placeOrder` call produces
 * (registering it only after the call resolves would be too late - fills
 * fire synchronously, inside the call, before a result ever comes back).
 * Used exclusively by bot wiring in main.ts; the HTTP layer talks to the
 * real venue directly.
 */
export const withBotTracking = (venue: Venue, stats: StatsTracker): Venue => ({
  markets: () => venue.markets(),
  publishPrice: (market, price, publishedAtMs) => venue.publishPrice(market, price, publishedAtMs),
  openTrader: (trader) => venue.openTrader(trader),
  deposit: (trader, token, amount) => venue.deposit(trader, token, amount),
  placeOrder: async (trader: TraderKey, order: NewOrder): Promise<PlaceResult> => {
    stats.recordOrder(trader);
    const fillsFromThisOrder: Fill[] = [];
    const unsubscribe = venue.onFill((fill) => fillsFromThisOrder.push(fill));
    let result: PlaceResult;
    try {
      result = await venue.placeOrder(trader, order);
    } finally {
      unsubscribe();
    }
    for (const fill of fillsFromThisOrder) stats.recordFill(fill, "bot");
    return result;
  },
  cancelAll: (trader, market) => venue.cancelAll(trader, market),
  traderState: (trader) => venue.traderState(trader),
  updateFunding: (market) => venue.updateFunding(market),
  liquidate: (liquidator, target, market) => venue.liquidate(liquidator, target, market),
  onFill: (listener) => venue.onFill(listener),
  stats: () => venue.stats(),
});
