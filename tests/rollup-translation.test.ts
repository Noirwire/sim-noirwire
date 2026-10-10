import { describe, expect, it } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import type { NewOrder } from "../src/engine/types.js";
import type { ChainMarket, PlaceOutcome, SeatView } from "../src/rollup/chain-types.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import {
  bandEdge,
  chainPriceAndSize,
  placeResultOf,
  traderStateOf,
} from "../src/rollup/translation.js";
import { UserOrderCount } from "../src/wiring/user-order-count.js";
import { dollars } from "./helpers.js";

const SOL_PERP: ChainMarket = {
  marketId: 0,
  kind: "perp",
  tick: 100n,
  baseLot: 1_000_000n,
  minNotional: 1_000_000n,
  bandBps: 400,
  initialMarginBps: 1_000,
  maxMoveBps: 250,
  maxPriceAgeSeconds: 10,
  fundingIntervalSeconds: 60,
  baseToken: 1,
  quoteToken: 0,
};

/** One lot is 0.001 SOL; a chain price is quote atoms per lot. */
const warmedUpAt150 = (): RollupMarket => {
  const market = new RollupMarket(MARKETS[0], SOL_PERP, 9);
  market.acceptPrice({ price: 150_000n, publishTimeSeconds: 1_000 });
  market.setTarget(dollars(150));
  return market;
};

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  market: "NSOL-PERP",
  side: "buy",
  type: "limit",
  price: dollars(150),
  size: dollars(2),
  ...over,
});

const outcome = (over: Partial<PlaceOutcome>): PlaceOutcome => ({
  status: "filled",
  filled: 0n,
  rested: 0n,
  sendToResultMs: 12,
  ...over,
});

describe("an order on its way to the program", () => {
  it("gives an order with no price the edge of the program's band, on the tick", () => {
    expect(bandEdge(SOL_PERP, 150_050n, "buy")).toBe(156_000n);
    expect(bandEdge(SOL_PERP, 150_050n, "sell")).toBe(144_100n);
  });

  it("turns a price per unit and a size in units into a price per lot and lots", () => {
    expect(chainPriceAndSize(warmedUpAt150(), order())).toEqual({ price: 150_000n, size: 2_000n });
  });

  it("refuses an order before the market has a mark, and while the mark is still warming up", () => {
    const market = new RollupMarket(MARKETS[0], SOL_PERP, 9);
    expect(typeof chainPriceAndSize(market, order())).toBe("string");

    market.acceptPrice({ price: 150_000n, publishTimeSeconds: 1_000 });
    market.setTarget(dollars(120));
    expect(market.warmingUp).toBe(true);
    expect(typeof chainPriceAndSize(market, order())).toBe("string");
  });

  it("refuses a size that is not whole lots and a price finer than the market counts", () => {
    const market = warmedUpAt150();
    expect(typeof chainPriceAndSize(market, order({ size: 2_000_500n }))).toBe("string");
    expect(typeof chainPriceAndSize(market, order({ price: 150_000_001n }))).toBe("string");
  });
});

describe("what the program made of a bot's order", () => {
  const market = warmedUpAt150();
  const result = (over: Partial<PlaceOutcome>) =>
    placeResultOf("bot#1", order(), market, 2_000n, outcome(over));

  it("reports a remainder that rests after a partial fill as partially filled", () => {
    expect(result({ status: "rested", filled: 500n, rested: 1_500n })).toMatchObject({
      status: "partiallyFilled",
      filledSize: dollars(0.5),
      remainingSize: dollars(1.5),
    });
    expect(result({ status: "rested", rested: 2_000n }).status).toBe("open");
  });

  it("reports an order cancelled with nothing filled as cancelled, and with something as partly filled", () => {
    expect(result({ status: "cancelled" }).status).toBe("cancelled");
    expect(result({ status: "cancelled", filled: 1n }).status).toBe("partiallyFilled");
  });

  it("reports every order the program did not execute as rejected, with nothing filled", () => {
    for (const status of ["refused", "expired", "invalid", "failed", "unknown"] as const) {
      expect(result({ status })).toMatchObject({ status: "rejected", remainingSize: dollars(2) });
    }
  });
});

describe("a trader's own view of its seat", () => {
  const tokens = [
    { index: 0, symbol: "nUSD", decimals: 6, mint: "nusd-mint" },
    { index: 1, symbol: "nSOL", decimals: 9, mint: "nsol-mint" },
  ];
  const view: SeatView = {
    seat: 7,
    collateral: dollars(1_000),
    spot: [
      { available: dollars(20), locked: dollars(5) },
      { available: 3_000_000_000n, locked: 0n },
    ],
    perp: [{ base: -2_000n, quote: 296_000_000n }],
    ordersMarketId: 0,
    orders: [{ side: "sell", price: 151_000n, remaining: 500n, sequence: 42n }],
  };
  const state = traderStateOf("bot:maker:NSOL-PERP", view, [warmedUpAt150()], tokens);

  it("shows a short as a negative size at the price it was entered, and marks it into equity", () => {
    expect(state.positions["NSOL-PERP"]).toEqual({ size: -dollars(2), entryPrice: dollars(148) });
    expect(state.equity).toBe(dollars(1_000) - dollars(300) + dollars(296));
  });

  it("keeps perpetuals collateral apart from the spot balance of the same token", () => {
    expect(state.balances.nUSD).toEqual({ balance: dollars(1_000), locked: 0n });
    expect(state.balances["nUSD (spot)"]).toEqual({ balance: dollars(20), locked: dollars(5) });
    expect(state.balances.SOL).toEqual({ balance: dollars(3), locked: 0n });
  });

  it("lists a resting order with what is left of it", () => {
    expect(state.openOrders).toMatchObject([
      { market: "NSOL-PERP", side: "sell", price: dollars(151), remainingSize: dollars(0.5) },
    ]);
  });
});

describe("counting users' orders from the chain's public counter", () => {
  it("takes the first reading as the start and counts growth less the bots' own orders", () => {
    const users = new UserOrderCount();
    expect(users.afterChainOrders(500n)).toBe(0);

    users.botOrderSent();
    users.botOrderExecuted();
    users.botOrderAnswered();
    users.botOrderSent();
    expect(users.afterChainOrders(505n)).toBe(3);
  });
});
