import { describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { MARKETS, type MarketConfig } from "../src/engine/markets.js";
import { SEAT_MARKET_SLOTS, type MemoryVenue } from "../src/engine/memory-venue.js";
import type { NewOrder, Venue } from "../src/engine/types.js";
import { isNotSeated, rejectedOrder } from "../src/engine/venue-orders.js";
import {
  NOT_SEATED_ERROR,
  SLOTS_FULL_ERROR,
  programErrorLabel,
  programRefusalText,
  sweepStopText,
} from "../src/rollup/program-errors.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";
const [SOL_PERP] = MARKETS as readonly [MarketConfig];

const perpMarkets = (count: number): MarketConfig[] =>
  Array.from({ length: count }, (_, at) => ({ ...SOL_PERP, id: `PERP-${at}` }));

const restingBuy = (market: string): NewOrder => ({
  market,
  side: "buy",
  type: "postOnly",
  price: dollars(90),
  size: dollars(1),
});

describe("a seat on the in-memory venue", () => {
  it("is taken by the first deposit: an opened trader with nothing refuses an order as not seated", async () => {
    const { venue, clock } = makeVenue();
    await publish(venue, clock, PERP, 100);
    await venue.openTrader("newcomer");
    expect(venue.seatHeld("newcomer")).toBe(false);

    const refused = await venue.placeOrder("newcomer", restingBuy(PERP));
    expect(refused.status).toBe("rejected");
    expect(isNotSeated(refused.reason)).toBe(true);

    await venue.deposit("newcomer", "nUSD", dollars(100));
    expect(venue.seatHeld("newcomer")).toBe(true);
    expect((await venue.placeOrder("newcomer", restingBuy(PERP))).status).toBe("open");
  });

  it("is given back when the account holds nothing: a liquidation that leaves it empty unseats it", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 15 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "liquidator", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);
    await venue.placeOrder("short", { ...restingBuy(PERP), side: "sell", price: dollars(100) });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });
    expect(venue.seatHeld("long")).toBe(true);

    await publish(venue, clock, PERP, 50);
    expect(await venue.liquidate("liquidator", "long", PERP)).toBe(true);

    expect(venue.seatHeld("long")).toBe(false);
    const refused = await venue.placeOrder("long", restingBuy(PERP));
    expect(isNotSeated(refused.reason)).toBe(true);
  });

  it(`holds positions or orders on ${SEAT_MARKET_SLOTS} markets and refuses a fifth like the program`, async () => {
    const markets = perpMarkets(SEAT_MARKET_SLOTS + 1);
    const { venue, clock } = makeVenue({ markets });
    for (const market of markets) await publish(venue, clock, market.id, 100);
    await openFunded(venue, "trader", { nUSD: 10_000 });

    for (const market of markets.slice(0, SEAT_MARKET_SLOTS)) {
      expect((await venue.placeOrder("trader", restingBuy(market.id))).status).toBe("open");
    }
    const fifth = markets[SEAT_MARKET_SLOTS]!;
    const refused = await venue.placeOrder("trader", restingBuy(fifth.id));
    expect(refused.status).toBe("rejected");
    expect(refused.reason).toContain("SlotsFull");

    expect((await venue.placeOrder("trader", restingBuy(markets[0]!.id))).status).toBe("open");

    await venue.cancelAll("trader", markets[0]!.id);
    expect((await venue.placeOrder("trader", restingBuy(fifth.id))).status).toBe("open");
  });

  it("counts a market while a position stands on it, not only while an order rests", async () => {
    const markets = perpMarkets(SEAT_MARKET_SLOTS + 1);
    const { venue, clock } = makeVenue({ markets });
    for (const market of markets) await publish(venue, clock, market.id, 100);
    await openFunded(venue, "trader", { nUSD: 10_000 });
    await openFunded(venue, "counterparty", { nUSD: 10_000 });

    for (const market of markets.slice(0, SEAT_MARKET_SLOTS)) {
      await venue.placeOrder("counterparty", {
        ...restingBuy(market.id),
        side: "sell",
        price: dollars(100),
      });
      await venue.placeOrder("trader", {
        market: market.id,
        side: "buy",
        type: "ioc",
        price: dollars(100),
        size: dollars(1),
      });
    }
    expect((await venue.traderState("trader")).openOrders).toEqual([]);

    const refused = await venue.placeOrder("trader", restingBuy(markets[SEAT_MARKET_SLOTS]!.id));
    expect(refused.reason).toContain("SlotsFull");
  });
});

describe("the house maker's seat", () => {
  it("deposits its float again when the venue says it holds no seat, then quotes", async () => {
    const { venue: memory, clock } = makeVenue();
    await publish(memory, clock, PERP, 100);
    const makerKey = makerTraderKey(PERP);
    const deposits: bigint[] = [];
    let refusedOnce = false;
    const venue = new Proxy(memory, {
      get(target, property) {
        if (property === "deposit") {
          return async (trader: string, token: string, amount: bigint) => {
            if (trader === makerKey) deposits.push(amount);
            return target.deposit(trader, token, amount);
          };
        }
        if (property === "placeOrder") {
          return async (trader: string, order: NewOrder) => {
            if (trader === makerKey && !refusedOnce) {
              refusedOnce = true;
              return rejectedOrder(
                "order-0",
                0n,
                order,
                "NotSeated (6155): deposit to take a seat",
              );
            }
            return target.placeOrder(trader, order);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as MemoryVenue & Venue;

    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 2,
      spreadBps: 20,
      levelStepBps: 5,
      baseSizePerLevel: dollars(1),
      requoteThresholdBps: 1,
      requoteIntervalMs: 1_000,
      positionLimitNotional: dollars(1_000),
      maxSkewBps: 20,
      lotSize: 1_000n,
      startingQuoteBalance: dollars(100_000),
      startingBaseBalance: 0n,
      clock,
    });
    await maker.ensureOpen(venue);
    expect(deposits).toEqual([dollars(100_000)]);

    await maker.tick(venue);

    expect(deposits).toEqual([dollars(100_000), dollars(100_000)]);
    expect((await venue.traderState(makerKey)).openOrders).toHaveLength(4);
  });
});

describe("the program's seat refusals in words", () => {
  it("names the codes and says what to do in plain words, without an em dash", () => {
    expect(programErrorLabel(SLOTS_FULL_ERROR)).toBe("SlotsFull (6093)");
    expect(programErrorLabel(NOT_SEATED_ERROR)).toBe("NotSeated (6155)");
    for (const code of [6156, 6160, 6161, 6162]) {
      expect(programErrorLabel(code)).not.toContain("unnamed");
    }
    for (const code of [SLOTS_FULL_ERROR, NOT_SEATED_ERROR, 6156, 6160, 6161, 6162]) {
      const text = programRefusalText(code);
      expect(text).not.toBeNull();
      expect(text).not.toContain(String.fromCharCode(0x2014));
    }
    expect(programRefusalText(6001)).toBeNull();
  });

  it("says why a liquidation sweep ended early, including a full liquidator seat", () => {
    expect(sweepStopText("liquidatorSlotsFull")).toContain("four other markets");
    expect(sweepStopText("liquidatorMarginInsufficient")).toContain("fund");
  });
});
