import type { StatsTracker } from "../data/stats.js";
import type { Venue } from "../engine/types.js";
import { placeOrderWithItsFills, placingOrdersThrough } from "../engine/venue-orders.js";

/** A venue whose every order, and every fill that order produces, counts as bot activity. */
export const withBotTracking = (venue: Venue, stats: StatsTracker): Venue =>
  placingOrdersThrough(venue, async (trader, order) => {
    stats.recordOrder(trader);
    const { result, fills } = await placeOrderWithItsFills(venue, trader, order);
    for (const fill of fills) stats.recordFill(fill, "bot");
    return result;
  });
