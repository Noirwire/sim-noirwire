import type { SeatView } from "../rollup/chain-types.js";
import type { RollupMarket } from "../rollup/rollup-market.js";
import { perpSlotOf, slotValueOf } from "../rollup/translation.js";

const BPS = 10_000n;

/** What a seat holds against what the program asks of it, in quote atoms. */
export interface MarginReading {
  collateral: bigint;
  equity: bigint;
  initialMargin: bigint;
  /** The most a withdrawal could take now: collateral only, and equity must stay at initial margin. */
  withdrawable: bigint;
}

const ceilDiv = (value: bigint, divisor: bigint): bigint => (value + divisor - 1n) / divisor;

/** The worst position, in lots, the seat's position and resting orders could grow to on one side. */
const worstCaseLots = (base: bigint, bids: bigint, asks: bigint): bigint => {
  const long = base + bids > 0n ? base + bids : 0n;
  const short = asks - base > 0n ? asks - base : 0n;
  return long > short ? long : short;
};

/** Initial margin of a notional that is held at `initialMarginBps`, rounded up. */
export const marginOfNotional = (notional: bigint, initialMarginBps: number): bigint =>
  ceilDiv(notional * BigInt(initialMarginBps), BPS);

/**
 * The seat's equity and initial margin as the program counts them. Resting
 * orders count in initial margin. Null while a market the seat holds
 * something on has no mark, since its value then cannot be told.
 */
export const marginReadingOf = (
  view: SeatView,
  markets: Iterable<RollupMarket>,
): MarginReading | null => {
  let equity = view.collateral;
  let initialMargin = 0n;
  for (const market of markets) {
    const { chain } = market;
    if (chain.kind !== "perp") continue;
    const slot = perpSlotOf(view, market);
    const resting = chain.marketId === view.ordersMarketId ? view.orders : [];
    const bids = resting
      .filter((order) => order.side === "buy")
      .reduce((sum, order) => sum + order.remaining, 0n);
    const asks = resting
      .filter((order) => order.side === "sell")
      .reduce((sum, order) => sum + order.remaining, 0n);
    const worst = worstCaseLots(slot?.base ?? 0n, bids, asks);
    if (market.mark === 0n) {
      if (worst > 0n || (slot !== undefined && slot.base !== 0n)) return null;
      continue;
    }
    equity += slotValueOf(view, market);
    initialMargin += marginOfNotional(worst * market.mark, chain.initialMarginBps);
  }
  const room = equity - initialMargin;
  const free = view.collateral < room ? view.collateral : room;
  return {
    collateral: view.collateral,
    equity,
    initialMargin,
    withdrawable: free > 0n ? free : 0n,
  };
};
