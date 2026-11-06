import { describe, expect, it } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import { marginOfNotional, marginReadingOf } from "../src/rebalance/free-collateral.js";
import type { ChainMarket, SeatView } from "../src/rollup/chain-types.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import { traderStateOf } from "../src/rollup/translation.js";

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
  positionCap: 1_000_000n,
  status: "active",
  oracleHealth: "healthy",
};

const marketAt = (price: bigint | null): RollupMarket => {
  const market = new RollupMarket(MARKETS[0], SOL_PERP, 9);
  if (price !== null) market.acceptPrice({ price, publishTimeSeconds: 1_000 });
  return market;
};

const USDC = 1_000_000n;

const seat = (over: Partial<SeatView>): SeatView => ({
  seat: 3,
  collateral: 1_000n * USDC,
  spot: [],
  perp: [],
  ordersMarketId: 0,
  orders: [],
  ...over,
});

describe("free collateral", () => {
  it("lets a flat seat with nothing resting withdraw all of its collateral", () => {
    const reading = marginReadingOf(seat({}), [marketAt(150_000n)]);
    expect(reading).toEqual({
      collateral: 1_000n * USDC,
      equity: 1_000n * USDC,
      initialMargin: 0n,
      withdrawable: 1_000n * USDC,
    });
  });

  it("holds back the initial margin of a position", () => {
    const view = seat({ perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }] });
    const reading = marginReadingOf(view, [marketAt(150_000n)]);
    expect(reading?.initialMargin).toBe(15n * USDC);
    expect(reading?.withdrawable).toBe(985n * USDC);
  });

  it("counts resting orders in the initial margin", () => {
    const view = seat({
      orders: [{ side: "buy", price: 149_000n, remaining: 2_000n, sequence: 1n }],
    });
    const reading = marginReadingOf(view, [marketAt(150_000n)]);
    expect(reading?.initialMargin).toBe(30n * USDC);
    expect(reading?.withdrawable).toBe(970n * USDC);
  });

  it("takes the larger side of the worst case, bids against the position", () => {
    const view = seat({
      perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }],
      orders: [
        { side: "buy", price: 149_000n, remaining: 500n, sequence: 1n },
        { side: "sell", price: 151_000n, remaining: 3_000n, sequence: 2n },
      ],
    });
    const reading = marginReadingOf(view, [marketAt(150_000n)]);
    // long 1500 lots against short 2000 lots: the short side is the worst case
    expect(reading?.initialMargin).toBe(30n * USDC);
  });

  it("cannot withdraw unrealized profit: only collateral leaves", () => {
    const view = seat({
      collateral: 200n * USDC,
      perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }],
    });
    const reading = marginReadingOf(view, [marketAt(250_000n)]);
    expect(reading?.equity).toBe(300n * USDC);
    expect(reading?.initialMargin).toBe(25n * USDC);
    expect(reading?.withdrawable).toBe(200n * USDC);
  });

  it("counts unrealized loss against what can leave", () => {
    const view = seat({ perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }] });
    const reading = marginReadingOf(view, [marketAt(100_000n)]);
    expect(reading?.equity).toBe(950n * USDC);
    expect(reading?.withdrawable).toBe(940n * USDC);
  });

  it("is never negative", () => {
    const view = seat({
      collateral: 10n * USDC,
      perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }],
    });
    expect(marginReadingOf(view, [marketAt(150_000n)])?.withdrawable).toBe(0n);
  });

  it("gives no reading while a held market has no mark", () => {
    const view = seat({ perp: [{ marketId: 0, base: 1_000n, quote: -150n * USDC }] });
    expect(marginReadingOf(view, [marketAt(null)])).toBeNull();
    expect(marginReadingOf(seat({}), [marketAt(null)])?.withdrawable).toBe(1_000n * USDC);
  });

  it("agrees with the equity the venue reports for the same seat", () => {
    const view = seat({ perp: [{ marketId: 0, base: 1_000n, quote: -120n * USDC }] });
    const market = marketAt(150_000n);
    const state = traderStateOf("maker", view, [market], []);
    expect(marginReadingOf(view, [market])?.equity).toBe(state.equity);
  });

  it("rounds margin up", () => {
    expect(marginOfNotional(15n, 1_000)).toBe(2n);
  });
});
