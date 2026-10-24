import { describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import type { MakerSafety } from "../src/bots/maker-safety.js";
import type { MemoryVenue } from "../src/engine/memory-venue.js";
import type { NewOrder, Venue } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";

/**
 * A maker under a risk rule the test steers (`plan`), on the in-memory venue, that has quoted and been
 * hit into a short of 2.5. The venue it ticks against records the maker's own orders and its position at
 * every read, and can close that position right after one read, as another fill or a liquidation would.
 */
const shortMaker = async () => {
  const { venue: memory, clock } = makeVenue();
  await publish(memory, clock, PERP, 100);
  await openFunded(memory, "taker", { nUSD: 100_000 });

  const plan = { reduceOnly: false, flatten: false };
  const stopped: string[] = [];
  const safety = {
    assess: async () => ({
      action: "quote",
      centre: dollars(100),
      extraSpreadBps: 0,
      reduceOnly: plan.reduceOnly,
      flatten: plan.flatten,
    }),
    alert: () => {},
    requoteSucceeded: () => {},
    mayGrow: () => true,
    stopFor: async (reason: string) => {
      stopped.push(reason);
    },
  } as unknown as MakerSafety;

  const makerKey = makerTraderKey(PERP);
  const placedByMaker: NewOrder[] = [];
  const answers: Awaited<ReturnType<Venue["placeOrder"]>>[] = [];
  const trail: bigint[] = [];
  let reads = 0;
  let closeAtRead: number | null = null;
  const venue = new Proxy(memory, {
    get(target, property) {
      if (property === "placeOrder") {
        return async (trader: string, order: NewOrder) => {
          if (trader === makerKey) placedByMaker.push(order);
          const answer = await target.placeOrder(trader, order);
          if (trader === makerKey) answers.push(answer);
          return answer;
        };
      }
      if (property === "traderState") {
        return async (trader: string) => {
          const state = await target.traderState(trader);
          if (trader !== makerKey) return state;
          reads += 1;
          trail.push(state.positions[PERP]?.size ?? 0n);
          if (closeAtRead === reads) {
            closeAtRead = null;
            await target.placeOrder(makerKey, {
              market: PERP,
              side: "buy",
              type: "ioc",
              price: dollars(110),
              size: dollars(2.5),
            });
          }
          return state;
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
    levels: 3,
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
    safety,
  });
  await maker.ensureOpen(venue);
  await maker.tick(venue);
  await memory.placeOrder("taker", {
    market: PERP,
    side: "buy",
    type: "ioc",
    price: dollars(110),
    size: dollars(2.5),
  });
  expect((await venue.traderState(maker.trader)).positions[PERP]?.size).toBe(-dollars(2.5));

  return {
    venue,
    memory,
    clock,
    maker,
    plan,
    stopped,
    placedByMaker,
    /** What the venue answered to each of the maker's orders. */
    answers,
    /** Closes the maker's position right after the read its next dispatch makes: the second of its next tick. */
    closeAfterDispatchRead: () => {
      closeAtRead = reads + 2;
    },
    /** The maker's position at every read so far. */
    positions: () => [...trail],
  };
};

/** Liquidity for the maker to close its short against. */
const offerToClose = async ({ memory }: { memory: MemoryVenue }): Promise<void> => {
  await memory.placeOrder("taker", {
    market: PERP,
    side: "sell",
    type: "limit",
    price: dollars(100),
    size: dollars(5),
  });
};

describe("HouseMaker", () => {
  it("quotes within its hard position limit: skips the side that would grow past it", async () => {
    const { venue, clock } = makeVenue();
    await publish(venue, clock, PERP, 100);
    await openFunded(venue, "taker", { nUSD: 100_000 });

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
      requoteIntervalMs: 1_000,
      positionLimitNotional: dollars(150), // ~1.5 SOL at $100
      maxSkewBps: 20,
      lotSize: 1_000n,
      startingQuoteBalance: dollars(100_000),
      startingBaseBalance: 0n,
      clock,
    });
    await maker.ensureOpen(venue);
    await maker.tick(venue);

    // The taker buys from the maker's asks until the maker is short past
    // its position limit.
    await venue.placeOrder("taker", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(110),
      size: dollars(2),
    });

    clock.advance(2_000);
    await maker.tick(venue);

    const state = await venue.traderState(maker.trader);
    const position = state.positions[PERP]?.size ?? 0n;
    expect(position).toBeLessThanOrEqual(-dollars(1.5));

    const sides = new Set(state.openOrders.map((order) => order.side));
    // Short past its limit: a sell would grow the short further.
    expect(sides.has("sell")).toBe(false);
  });

  it("requotes when the price moves past the threshold, not on every tick", async () => {
    const { venue, clock } = makeVenue();
    await publish(venue, clock, PERP, 100);

    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 1,
      spreadBps: 10,
      levelStepBps: 0,
      baseSizePerLevel: dollars(1),
      requoteThresholdBps: 50,
      requoteIntervalMs: 1_000_000, // effectively never fires on its own
      positionLimitNotional: dollars(10_000),
      maxSkewBps: 20,
      lotSize: 1_000n,
      startingQuoteBalance: dollars(100_000),
      startingBaseBalance: 0n,
      clock,
    });
    await maker.ensureOpen(venue);
    await maker.tick(venue);
    const firstQuotes = (await venue.traderState(maker.trader)).openOrders;

    // A tiny move: below the 50bps threshold, no requote expected.
    await publish(venue, clock, PERP, 100.1);
    clock.advance(10);
    await maker.tick(venue);
    const afterTinyMove = (await venue.traderState(maker.trader)).openOrders;
    expect(afterTinyMove.map((o) => o.price)).toEqual(firstQuotes.map((o) => o.price));

    // A big move: past the threshold, requote expected.
    await publish(venue, clock, PERP, 110);
    clock.advance(10);
    await maker.tick(venue);
    const afterBigMove = (await venue.traderState(maker.trader)).openOrders;
    expect(afterBigMove.map((o) => o.price)).not.toEqual(firstQuotes.map((o) => o.price));
  });

  it("skews its quotes away from accumulated inventory", async () => {
    const { venue, clock } = makeVenue();
    await publish(venue, clock, PERP, 100);
    await openFunded(venue, "taker", { nUSD: 100_000 });

    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 1,
      spreadBps: 20,
      levelStepBps: 0,
      baseSizePerLevel: dollars(1),
      requoteThresholdBps: 1,
      requoteIntervalMs: 1_000,
      positionLimitNotional: dollars(1_000),
      maxSkewBps: 50,
      lotSize: 1_000n,
      startingQuoteBalance: dollars(100_000),
      startingBaseBalance: 0n,
      clock,
    });
    await maker.ensureOpen(venue);
    await maker.tick(venue);
    const flatOrders = (await venue.traderState(maker.trader)).openOrders;
    const flatMid =
      (flatOrders.find((o) => o.side === "buy")!.price! +
        flatOrders.find((o) => o.side === "sell")!.price!) /
      2n;

    // The taker buys from the maker, leaving the maker short.
    await venue.placeOrder("taker", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(110),
      size: dollars(1),
    });

    clock.advance(2_000);
    await maker.tick(venue);
    const shortOrders = (await venue.traderState(maker.trader)).openOrders;
    const shortMid =
      (shortOrders.find((o) => o.side === "buy")!.price! +
        shortOrders.find((o) => o.side === "sell")!.price!) /
      2n;

    // Short inventory should push the quoting centre up (to attract buys
    // back / discourage selling more), not down.
    expect(shortMid).toBeGreaterThan(flatMid);
  });

  it("leaves no resting order under a reduce-only plan, and a flatten brings a short to exactly flat, not past it", async () => {
    const rig = await shortMaker();
    const { venue, clock, maker, plan, stopped } = rig;
    expect((await venue.traderState(maker.trader)).openOrders.length).toBeGreaterThan(0);

    plan.reduceOnly = true;
    clock.advance(2_000);
    await publish(venue, clock, PERP, 100);
    await maker.tick(venue);

    const pulled = await venue.traderState(maker.trader);
    expect(pulled.openOrders).toHaveLength(0);
    expect(pulled.positions[PERP]?.size).toBe(-dollars(2.5));

    await venue.placeOrder("taker", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(5),
    });
    plan.flatten = true;
    clock.advance(2_000);
    await publish(venue, clock, PERP, 100);
    await maker.tick(venue);

    const after = await venue.traderState(maker.trader);
    expect(after.positions[PERP]).toBeUndefined();
    expect(after.openOrders).toHaveLength(0);
    expect(stopped).toEqual([]);
  });

  describe("when the position changes between the maker's read and its dispatch", () => {
    it("places nothing under a reduce-only plan, so no exposure opens the other way", async () => {
      const rig = await shortMaker();
      const { venue, clock, maker, plan, stopped, placedByMaker, positions } = rig;
      await offerToClose(rig);

      plan.reduceOnly = true;
      rig.closeAfterDispatchRead();
      clock.advance(2_000);
      await publish(venue, clock, PERP, 100);
      const placedBefore = placedByMaker.length;
      await maker.tick(venue);
      await venue.placeOrder("taker", {
        market: PERP,
        side: "sell",
        type: "ioc",
        price: dollars(90),
        size: dollars(10),
      });

      expect(placedByMaker.length).toBe(placedBefore);
      const after = await venue.traderState(maker.trader);
      expect(after.positions[PERP]).toBeUndefined();
      expect(after.openOrders).toHaveLength(0);
      expect(positions().every((size) => size <= 0n)).toBe(true);
      expect(stopped).toEqual([]);
    });

    it("has the venue cut a flatten's reduce-only order to nothing, so the position never flips", async () => {
      const rig = await shortMaker();
      const { venue, clock, maker, plan, stopped, placedByMaker, answers, positions } = rig;
      await offerToClose(rig);

      plan.reduceOnly = true;
      plan.flatten = true;
      rig.closeAfterDispatchRead();
      clock.advance(2_000);
      await publish(venue, clock, PERP, 100);
      const placedBefore = placedByMaker.length;
      await maker.tick(venue);

      const flatten = placedByMaker.slice(placedBefore);
      expect(flatten).toHaveLength(1);
      expect(flatten[0]).toMatchObject({ side: "buy", type: "limit", reduceOnly: true });
      expect(answers.at(-1)).toMatchObject({
        status: "rejected",
        reason: expect.stringContaining("no position to reduce"),
      });
      const after = await venue.traderState(maker.trader);
      expect(after.positions[PERP]).toBeUndefined();
      expect(after.openOrders).toHaveLength(0);
      expect(positions().every((size) => size <= 0n)).toBe(true);
      expect(stopped).toEqual([]);
    });
  });
});
