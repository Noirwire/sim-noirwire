import type { Fill, NewOrder, PlaceResult, TraderKey, Venue } from "./types.js";

export const rejectedOrder = (
  orderId: string,
  tag: bigint,
  order: NewOrder,
  reason: string,
): PlaceResult => ({
  orderId,
  tag,
  status: "rejected",
  filledSize: 0n,
  remainingSize: order.size,
  reason,
});

/** `venue` with its orders placed through `placeOrder`, and everything else untouched. */
export const placingOrdersThrough = (venue: Venue, placeOrder: Venue["placeOrder"]): Venue => ({
  markets: () => venue.markets(),
  publishPrice: (market, price, publishedAtMs) => venue.publishPrice(market, price, publishedAtMs),
  openTrader: (trader) => venue.openTrader(trader),
  deposit: (trader, token, amount) => venue.deposit(trader, token, amount),
  placeOrder,
  cancelAll: (trader, market) => venue.cancelAll(trader, market),
  traderState: (trader) => venue.traderState(trader),
  updateFunding: (market) => venue.updateFunding(market),
  liquidate: (liquidator, target, market) => venue.liquidate(liquidator, target, market),
  onFill: (listener) => venue.onFill(listener),
});

/**
 * Places an order and returns the fills it produced. A fill names no trader,
 * so whoever places an order is the only one who can say whose its fills
 * are. The in-memory venue emits them inside the call, before the result
 * comes back, which is why the listener is in place before the order is sent.
 */
export const placeOrderWithItsFills = async (
  venue: Venue,
  trader: TraderKey,
  order: NewOrder,
): Promise<{ result: PlaceResult; fills: Fill[] }> => {
  const fills: Fill[] = [];
  const unsubscribe = venue.onFill((fill) => fills.push(fill));
  try {
    return { result: await venue.placeOrder(trader, order), fills };
  } finally {
    unsubscribe();
  }
};
