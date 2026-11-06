import { describe, expect, it } from "vitest";
import { HouseMaker, ladderOrders } from "../src/bots/house-maker.js";
import { MAKER_LIMITS } from "../src/bots/maker-limits.js";
import { ManualClock } from "../src/engine/clock.js";
import type { MarketInfo, NewOrder, TraderState } from "../src/engine/types.js";
import { dollars } from "./helpers.js";

const BTC = "NBTC-PERP";
const BAND_BPS = 40;
const MARK = dollars(90_000);

const SHAPE = {
  market: BTC,
  levels: 5,
  spreadBps: 15,
  levelStepBps: 5,
  baseSizePerLevel: dollars(0.0001),
  maxSkewBps: 20,
  lotSize: dollars(0.0001),
};

const ladder = {
  mark: MARK,
  tickSize: dollars(1),
  positionLimit: dollars(0.0011),
  minEdgeBps: MAKER_LIMITS.minHalfSpreadBps,
};

const edgeBps = (order: NewOrder): number =>
  Number(((order.price! > MARK ? order.price! - MARK : MARK - order.price!) * 10_000n) / MARK);

describe("the house maker's BTC ladder inside a 40 bps band", () => {
  const maxEdgeBps = BAND_BPS - MAKER_LIMITS.bandHeadroomBps;

  it("keeps the nearest quote at the minimum half spread and every quote inside the band at full skew", () => {
    for (const position of [0n, dollars(0.0005), -dollars(0.0005)]) {
      const orders = ladderOrders(SHAPE, { ...ladder, position, maxEdgeBps });
      expect(orders.length).toBeGreaterThan(0);
      for (const order of orders) {
        expect(edgeBps(order)).toBeLessThanOrEqual(BAND_BPS - 1);
      }
      const nearest = Math.min(...orders.map(edgeBps));
      expect(nearest).toBeGreaterThanOrEqual(MAKER_LIMITS.minHalfSpreadBps - 1);
    }
  });

  it("would reach past the band without the bound, so the bound is what holds it", () => {
    const loose = ladderOrders(SHAPE, { ...ladder, position: dollars(0.0005) });
    expect(Math.max(...loose.map(edgeBps))).toBeGreaterThan(BAND_BPS);
  });

  it("leaves a ladder with no band bound as it was", () => {
    const orders = ladderOrders(SHAPE, { ...ladder, position: 0n, maxEdgeBps: undefined });
    expect(orders).toEqual(ladderOrders(SHAPE, { ...ladder, position: 0n }));
  });

  it("keeps the minimum half spread inside the 40 bps band", () => {
    expect(MAKER_LIMITS.minHalfSpreadBps).toBeLessThan(BAND_BPS - MAKER_LIMITS.bandHeadroomBps);
  });
});

describe("the house maker's room to overlap a requote on a 100x market", () => {
  const makerOptions = {
    ...SHAPE,
    kind: "perp" as const,
    baseToken: "BTC",
    quoteToken: "nUSD",
    requoteThresholdBps: 12,
    requoteIntervalMs: 90_000,
    positionLimitNotional: dollars(50_000),
    startingQuoteBalance: dollars(200_000),
    startingBaseBalance: 0n,
    clock: new ManualClock(1_000),
  };

  const market = (maxLeverage: number): MarketInfo => ({
    id: BTC,
    kind: "perp",
    base: "BTC",
    quote: "nUSD",
    tickSize: dollars(1),
    lotSize: dollars(0.0001),
    maxLeverage,
    bandBps: BAND_BPS,
    markPrice: MARK,
    markPriceUpdatedAtMs: 1_000,
    change24h: null,
    volume24h: 0n,
    openInterest: null,
  });

  const roomAt = (maxLeverage: number) => {
    const maker = new HouseMaker(makerOptions);
    const seat = { equity: dollars(100) } as TraderState;
    return (
      maker as unknown as {
        overlapRoom(
          plan: { centre: bigint },
          market: MarketInfo,
          seat: TraderState,
          position: bigint,
          orders: NewOrder[],
        ): { buy: bigint; sell: bigint; orders: number };
      }
    ).overlapRoom({ centre: MARK }, market(maxLeverage), seat, 0n, []);
  };

  it("counts the margin at no more than 5x, so 100x does not quote 20x the size", () => {
    expect(roomAt(100)).toEqual(roomAt(5));
    expect(roomAt(100).buy).toBeGreaterThan(0n);
    expect(roomAt(2).buy).toBeLessThan(roomAt(5).buy);
  });
});
