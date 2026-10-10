import { absBigInt, bpsOf, roundDownToStep, roundUpToStep } from "../engine/money.js";
import type {
  NewOrder,
  OrderStatus,
  PlaceResult,
  Side,
  TraderKey,
  TraderState,
} from "../engine/types.js";
import type { ChainMarket, PlaceOutcome, PlaceStatus, SeatView } from "./chain-types.js";
import type { RollupMarket } from "./rollup-market.js";
import { COLLATERAL_TOKEN, type DeployedToken, simTokenOf } from "./tokens.js";
import { toChainPrice, toChainSize, toSimAmount, toSimPrice, toSimSize } from "./units.js";

/** A view shows the seat's whole nUSD spot balance apart from its perpetuals collateral. */
const SPOT_COLLATERAL_BALANCE = `${COLLATERAL_TOKEN} (spot)`;
/** The program gives a bot's order no tag: its fills are recognised by receipt instead. */
const NO_TAG = 0n;

/**
 * The furthest price the program accepts on `side`: the edge of its band
 * around the mark, on the tick. An order with no price of its own takes it.
 */
export const bandEdge = (
  { bandBps, tick }: Pick<ChainMarket, "bandBps" | "tick">,
  mark: bigint,
  side: Side,
): bigint => {
  const band = bpsOf(mark, bandBps);
  return side === "buy" ? roundDownToStep(mark + band, tick) : roundUpToStep(mark - band, tick);
};

/** The order's price and size in the program's units, or why it cannot be sent. */
export const chainPriceAndSize = (
  market: RollupMarket,
  order: NewOrder,
): { price: bigint; size: bigint } | string => {
  if (market.mark === 0n) return "no mark price yet";
  if (market.warmingUp) return "the market is warming up";
  const price =
    order.price === undefined
      ? bandEdge(market.chain, market.mark, order.side)
      : toChainPrice(market.units, order.price);
  const size = toChainSize(market.units, order.size);
  if (price === null) return "price is finer than the market counts";
  if (size === null) return "size is not a whole number of lots";
  return { price, size };
};

const STATUS_OF: Record<PlaceStatus, (filled: bigint, size: bigint) => OrderStatus> = {
  filled: () => "filled",
  rested: (filled, size) => (filled > 0n && filled < size ? "partiallyFilled" : "open"),
  cancelled: (filled) => (filled > 0n ? "partiallyFilled" : "cancelled"),
  refused: () => "rejected",
  expired: () => "rejected",
  invalid: () => "rejected",
  failed: () => "rejected",
  unknown: () => "rejected",
};

const reasonOf = (outcome: PlaceOutcome): string | undefined => {
  if (outcome.status === "expired") return "no result before the order expired";
  if (outcome.status === "refused") return "post-only order would match";
  return outcome.reason;
};

/** What the program made of an order of `chainSize` lots, in this service's terms. */
export const placeResultOf = (
  orderId: string,
  order: NewOrder,
  market: RollupMarket,
  chainSize: bigint,
  outcome: PlaceOutcome,
): PlaceResult => {
  const filledSize = toSimSize(market.units, outcome.filled);
  return {
    orderId,
    tag: NO_TAG,
    status: STATUS_OF[outcome.status](outcome.filled, chainSize),
    filledSize,
    remainingSize: order.size - filledSize,
    reason: reasonOf(outcome),
  };
};

/** A trader's own view of its seat, in this service's terms. */
export const traderStateOf = (
  trader: TraderKey,
  view: SeatView,
  markets: Iterable<RollupMarket>,
  tokens: DeployedToken[],
): TraderState => {
  const balances: TraderState["balances"] = {
    [COLLATERAL_TOKEN]: { balance: view.collateral, locked: 0n },
  };
  for (const token of tokens) {
    const simToken = simTokenOf(token.symbol);
    const held = view.spot[token.index];
    if (!simToken || !held) continue;
    balances[simToken === COLLATERAL_TOKEN ? SPOT_COLLATERAL_BALANCE : simToken] = {
      balance: toSimAmount(held.available, token.decimals),
      locked: toSimAmount(held.locked, token.decimals),
    };
  }

  const positions: TraderState["positions"] = {};
  const openOrders: TraderState["openOrders"] = [];
  let equity = view.collateral;
  for (const market of markets) {
    const { chain, units, config } = market;
    if (chain.marketId === view.ordersMarketId) {
      for (const order of view.orders) {
        const remaining = toSimSize(units, order.remaining);
        openOrders.push({
          orderId: order.sequence.toString(),
          tag: NO_TAG,
          market: config.id,
          side: order.side,
          type: "limit",
          price: toSimPrice(units, order.price),
          size: remaining,
          remainingSize: remaining,
          reduceOnly: false,
        });
      }
    }
    const slot = view.perp[chain.marketId];
    if (chain.kind !== "perp" || !slot || slot.base === 0n) continue;
    positions[config.id] = {
      size: toSimSize(units, slot.base),
      entryPrice: toSimPrice(units, absBigInt(slot.quote) / absBigInt(slot.base)),
    };
    equity += slot.base * market.mark + slot.quote;
  }
  return { trader, balances, positions, openOrders, equity };
};
