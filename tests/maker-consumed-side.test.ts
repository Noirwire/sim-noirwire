import { describe, expect, it } from "vitest";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { HouseMaker } from "../src/bots/house-maker.js";
import type { MakerSafety } from "../src/bots/maker-safety.js";
import type { MemoryVenue } from "../src/engine/memory-venue.js";
import { rejectedOrder } from "../src/engine/venue-orders.js";
import type { NewOrder, Side, Venue } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";
const INTERVAL_MS = 10_000;

/** The venue as the maker sees it: its orders and seat reads are counted, and a side can be made to refuse. */
const counted = (memory: MemoryVenue, refusing: { side: Side | null }) => {
  const makerKey = makerTraderKey(PERP);
  const count = { placed: 0, seatReads: 0 };
  const venue = new Proxy(memory, {
    get(target, property) {
      if (property === "placeOrder") {
        return async (trader: string, order: NewOrder) => {
          if (trader !== makerKey) return target.placeOrder(trader, order);
          if (order.side === refusing.side)
            return rejectedOrder("refused", 0n, order, "post-only order would match");
          count.placed += 1;
          return target.placeOrder(trader, order);
        };
      }
      if (property === "traderState") {
        return async (trader: string) => {
          if (trader === makerKey) count.seatReads += 1;
          return target.traderState(trader);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryVenue & Venue;
  return { venue, count };
};

const makerOf = async (safety?: MakerSafety, positionLimitNotional = dollars(1_000)) => {
  const { venue: memory, clock } = makeVenue();
  await publish(memory, clock, PERP, 100);
  await openFunded(memory, "taker", { nUSD: 100_000 });
  const refusing: { side: Side | null } = { side: null };
  const { venue, count } = counted(memory, refusing);
  const maker = new HouseMaker({
    market: PERP,
    kind: "perp",
    baseToken: "SOL",
    quoteToken: "nUSD",
    levels: 2,
    spreadBps: 10,
    levelStepBps: 5,
    baseSizePerLevel: dollars(1),
    requoteThresholdBps: 5,
    requoteIntervalMs: INTERVAL_MS,
    positionLimitNotional,
    maxSkewBps: 20,
    lotSize: 1_000n,
    startingQuoteBalance: dollars(100_000),
    startingBaseBalance: 0n,
    clock,
    ...(safety ? { safety } : {}),
  });
  await maker.ensureOpen(venue);
  const later = async (ms: number): Promise<void> => {
    clock.advance(ms);
    await publish(memory, clock, PERP, 100);
  };
  const takeAsks = (size: number) =>
    memory.placeOrder("taker", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(110),
      size: dollars(size),
    });
  const takeBids = (size: number) =>
    memory.placeOrder("taker", {
      market: PERP,
      side: "sell",
      type: "ioc",
      price: dollars(90),
      size: dollars(size),
    });
  return { venue, clock, maker, count, refusing, later, takeAsks, takeBids };
};

const steeredSafety = (plan: { action: string }): MakerSafety =>
  ({
    assess: async () => ({
      ...plan,
      centre: dollars(100),
      extraSpreadBps: 0,
      reduceOnly: false,
    }),
    alert: () => {},
    requoteSucceeded: () => {},
    ladderResting: () => {},
    mayGrow: () => true,
    stopFor: async () => {},
  }) as unknown as MakerSafety;

describe("when a taker consumes one side of the house maker's ladder", () => {
  it("requotes on the next tick that reads the seat, long before the requote interval", async () => {
    const { venue, maker, count, later, takeAsks } = await makerOf();
    await maker.tick(venue);
    expect(count.placed).toBe(4);

    await takeAsks(2);
    await later(2_000);
    await maker.tick(venue);

    expect(count.placed).toBe(8);
  });

  it("requotes when a side is left under half of what the ladder placed, though it is not empty", async () => {
    const { venue, maker, count, later, takeAsks } = await makerOf();
    await maker.tick(venue);

    await takeAsks(1.5);
    await later(2_000);
    await maker.tick(venue);

    expect(count.placed).toBe(8);
  });

  it("reads the seat at most once per two seconds, and sends nothing while the ladder stands", async () => {
    const { venue, maker, count, later, takeAsks } = await makerOf();
    await maker.tick(venue);
    const readsAfterQuote = count.seatReads;

    await takeAsks(2);
    for (let tick = 0; tick < 3; tick += 1) {
      await later(500);
      await maker.tick(venue);
    }
    expect(count.seatReads).toBe(readsAfterQuote);
    expect(count.placed).toBe(4);

    await later(500);
    await maker.tick(venue);
    expect(count.placed).toBe(8);
  });

  it("leaves a ladder alone that nothing has touched, with one seat read per two seconds", async () => {
    const { venue, maker, count, later } = await makerOf();
    await maker.tick(venue);
    const readsAfterQuote = count.seatReads;

    for (let tick = 0; tick < 8; tick += 1) {
      await later(500);
      await maker.tick(venue);
    }

    expect(count.placed).toBe(4);
    expect(count.seatReads - readsAfterQuote).toBeLessThanOrEqual(2);
  });

  it("does not requote while the risk rules have the quotes pulled", async () => {
    const plan = { action: "quote" };
    const { venue, maker, count, later, takeAsks } = await makerOf(steeredSafety(plan));
    await maker.tick(venue);
    expect(count.placed).toBe(4);

    plan.action = "pull";
    await takeAsks(2);
    for (let tick = 0; tick < 3; tick += 1) {
      await later(2_000);
      await maker.tick(venue);
    }

    expect(count.placed).toBe(4);
  });

  it("does not requote when the seat cannot be read", async () => {
    const { venue, maker, count, later, takeAsks } = await makerOf();
    await maker.tick(venue);
    await takeAsks(2);
    const failing = new Proxy(venue, {
      get(target, property) {
        if (property === "traderState") {
          return async () => {
            throw new Error("the venue did not answer");
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Venue;

    await later(2_000);
    await maker.tick(failing);

    expect(count.placed).toBe(4);
  });
});

describe("the side of the house maker's ladder that rests nothing", () => {
  it("is named, with the time it was first seen, while the venue refuses that side's orders", async () => {
    const { venue, maker, refusing, later, clock } = await makerOf();
    refusing.side = "sell";
    const began = clock.nowMs();
    await maker.tick(venue);

    expect(maker.emptySide).toEqual({ side: "asks", sinceMs: began });

    await later(INTERVAL_MS);
    await maker.tick(venue);
    expect(maker.emptySide).toEqual({ side: "asks", sinceMs: began });
  });

  it("names the bids when those are the empty side", async () => {
    const { venue, maker, refusing } = await makerOf();
    refusing.side = "buy";

    await maker.tick(venue);

    expect(maker.emptySide?.side).toBe("bids");
  });

  it("is not reported while both sides rest", async () => {
    const { venue, maker } = await makerOf();

    await maker.tick(venue);

    expect(maker.emptySide).toBeNull();
  });

  it("ends once the ladder rests on that side again", async () => {
    const { venue, maker, refusing, later } = await makerOf();
    refusing.side = "sell";
    await maker.tick(venue);
    expect(maker.emptySide).not.toBeNull();

    refusing.side = null;
    await later(INTERVAL_MS);
    await maker.tick(venue);

    expect(maker.emptySide).toBeNull();
  });

  it("is not reported for a side the position limit leaves no room on", async () => {
    const { venue, maker, takeBids, later } = await makerOf(undefined, dollars(100));
    await maker.tick(venue);
    // The limit is one unit at this price: a maker long by that much has no room left to buy.
    await takeBids(1);
    await later(2_000);
    await maker.tick(venue);
    await later(INTERVAL_MS);
    await maker.tick(venue);

    expect(maker.emptySide).toBeNull();
    expect((await venue.traderState(maker.trader)).openOrders.some((o) => o.side === "buy")).toBe(
      false,
    );
  });

  it("is not reported while the risk rules have the quotes pulled", async () => {
    const plan = { action: "quote" };
    const { venue, maker, refusing, later } = await makerOf(steeredSafety(plan));
    refusing.side = "sell";
    await maker.tick(venue);
    expect(maker.emptySide).not.toBeNull();

    plan.action = "pull";
    await later(INTERVAL_MS);
    await maker.tick(venue);

    expect(maker.emptySide).toBeNull();
  });
});
