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

/** The reason of an order refused before it was handed on because its expiry was too near: nothing was sent. */
export const ORDER_EXPIRY_TOO_NEAR =
  "the order's expiry is already past or within a second, so nothing was sent";

/** An order the venue proves did not run, for a cause that passes by itself: shown as rejected, flagged as such. */
export const unrunOrder = (
  orderId: string,
  tag: bigint,
  order: NewOrder,
  reason: string,
): PlaceResult => ({ ...rejectedOrder(orderId, tag, order, reason), didNotRun: true });

/** An order that failed after it may have been sent: shown as rejected, flagged as not known to be. */
export const unknownOrder = (
  orderId: string,
  tag: bigint,
  order: NewOrder,
  reason: string,
): PlaceResult => ({ ...rejectedOrder(orderId, tag, order, reason), outcomeUnknown: true });

/** `venue` with its orders placed through `placeOrder`, and everything else untouched. */
export const placingOrdersThrough = (venue: Venue, placeOrder: Venue["placeOrder"]): Venue => ({
  markets: () => venue.markets(),
  publishPrice: (market, price, publishedAtMs) => venue.publishPrice(market, price, publishedAtMs),
  openTrader: (trader) => venue.openTrader(trader),
  deposit: (trader, token, amount) => venue.deposit(trader, token, amount),
  placeOrder,
  cancelAll: (trader, market) => venue.cancelAll(trader, market),
  ...(venue.cancelOrder
    ? { cancelOrder: (trader, market, orderId) => venue.cancelOrder!(trader, market, orderId) }
    : {}),
  traderState: (trader) => venue.traderState(trader),
  updateFunding: (market) => venue.updateFunding(market),
  liquidate: (liquidator, target, market) => venue.liquidate(liquidator, target, market),
  unsettledPlaces: (trader) => venue.unsettledPlaces?.(trader) ?? 0,
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
