import { describe, expect, it, vi } from "vitest";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { HouseMaker, holdLapsesAtMs } from "../src/bots/house-maker.js";
import type { MakerSafety } from "../src/bots/maker-safety.js";
import type { MemoryVenue } from "../src/engine/memory-venue.js";
import { rejectedOrder, unknownOrder } from "../src/engine/venue-orders.js";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { NewOrder, PlaceResult, Venue } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";
const INTERVAL_MS = 10_000;

interface Behaviour {
  /** Makes the venue refuse the maker's post-only orders on this side, for the reason given. */
  refusePostOnly: { side: "buy" | "sell"; reason: string } | null;
  /** Runs just before the maker's take reaches the venue. */
  beforeTake: (() => Promise<unknown>) | null;
  /** Makes the venue lose the answer to the maker's take. */
  takeOutcomeUnknown: boolean;
  /** Holds back the answer to a refused post-only order until the promise it returns settles. */
  delayRefusal: (() => Promise<unknown>) | null;
}

/** The venue as the maker sees it: every order it sends is recorded, and its post-only orders can be made to fail. */
const recorded = (memory: MemoryVenue, behaviour: Behaviour) => {
  const makerKey = makerTraderKey(PERP);
  const sent: NewOrder[] = [];
  const venue = new Proxy(memory, {
    get(target, property) {
      if (property === "placeOrder") {
        return async (trader: string, order: NewOrder): Promise<PlaceResult> => {
          if (trader !== makerKey) return target.placeOrder(trader, order);
          sent.push(order);
          if (order.type === "ioc") await behaviour.beforeTake?.();
          if (order.type === "ioc" && behaviour.takeOutcomeUnknown) {
            return unknownOrder("lost", 0n, order, "the answer never came");
          }
          const refusing = behaviour.refusePostOnly;
          if (order.type === "postOnly" && refusing && order.side === refusing.side) {
            await behaviour.delayRefusal?.();
            return rejectedOrder("refused", 0n, order, refusing.reason);
          }
          return target.placeOrder(trader, order);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryVenue & Venue;
  return { venue, sent };
};

const quoting = (
  plan: { action: string; centre: bigint },
  calls: { stops: string[]; alerts: string[] } = { stops: [], alerts: [] },
): MakerSafety =>
  ({
    assess: async () => ({ ...plan, extraSpreadBps: 0, reduceOnly: false }),
    alert: (message: string) => calls.alerts.push(message),
    requoteSucceeded: () => {},
    ladderResting: () => {},
    mayGrow: () => true,
    stopFor: async (reason: string) => {
      calls.stops.push(reason);
    },
  }) as unknown as MakerSafety;

const setup = async (
  options: { safety?: MakerSafety; positionLimitNotional?: bigint; ledger?: MakerLedger } = {},
) => {
  const { venue: memory, clock } = makeVenue();
  await publish(memory, clock, PERP, 100);
  await openFunded(memory, "user", { nUSD: 100_000 });
  const behaviour: Behaviour = {
    refusePostOnly: null,
    beforeTake: null,
    takeOutcomeUnknown: false,
    delayRefusal: null,
  };
  const { venue, sent } = recorded(memory, behaviour);
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
    positionLimitNotional: options.positionLimitNotional ?? dollars(1_000),
    maxSkewBps: 0,
    lotSize: 1_000n,
    startingQuoteBalance: dollars(100_000),
    startingBaseBalance: 0n,
    clock,
    ...(options.safety ? { safety: options.safety } : {}),
    ...(options.ledger ? { ledger: options.ledger } : {}),
  });
  await maker.ensureOpen(venue);
  const moveTo = async (price: number, afterMs = 1_000): Promise<void> => {
    clock.advance(afterMs);
    await publish(memory, clock, PERP, price);
  };
  const userRests = (side: "buy" | "sell", price: number, size: number) =>
    memory.placeOrder("user", {
      market: PERP,
      side,
      type: "limit",
      price: dollars(price),
      size: dollars(size),
    });
  const positionOf = async (trader: string): Promise<bigint> =>
    (await memory.traderState(trader)).positions[PERP]?.size ?? 0n;
  const makerOrders = async (side: "buy" | "sell") =>
    (await memory.traderState(maker.trader)).openOrders.filter((open) => open.side === side);
  const ioc = () => sent.filter((order) => order.type === "ioc");
  return { venue, clock, maker, behaviour, sent, ioc, moveTo, userRests, positionOf, makerOrders };
};

describe("a house maker whose ask would cross a user's resting bid", () => {
  it("fills the user at the user's own price and rests its asks afterwards", async () => {
    const { venue, maker, moveTo, userRests, positionOf, makerOrders, ioc } = await setup();
    await maker.tick(venue);
    await userRests("buy", 99.5, 0.5);

    await moveTo(99);
    await maker.tick(venue);

    expect(await positionOf("user")).toBe(dollars(0.5));
    expect((await venue.traderState("user")).positions[PERP]?.entryPrice).toBe(dollars(99.5));
    expect(await positionOf(maker.trader)).toBe(-dollars(0.5));
    expect(ioc()).toHaveLength(1);
    expect((await makerOrders("sell")).length).toBeGreaterThan(0);
    expect(maker.emptySide).toBeNull();
  });

  it("fills the user and keeps resting asks when every ask level would cross", async () => {
    const { venue, maker, moveTo, userRests, positionOf, makerOrders, ioc } = await setup();
    await maker.tick(venue);
    await userRests("buy", 99.5, 1.5);

    await moveTo(99);
    await maker.tick(venue);

    expect(await positionOf("user")).toBe(dollars(1.5));
    expect(ioc()).toHaveLength(2);
    const asks = await makerOrders("sell");
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.some((ask) => ask.price !== null && ask.price < dollars(99.5))).toBe(true);
    expect(maker.emptySide).toBeNull();
  });

  it("does the same for a user's resting ask below a rising market", async () => {
    const { venue, maker, moveTo, userRests, positionOf, makerOrders, ioc } = await setup();
    await maker.tick(venue);
    await userRests("sell", 100.5, 1.5);

    await moveTo(101);
    await maker.tick(venue);

    expect(await positionOf("user")).toBe(-dollars(1.5));
    expect(await positionOf(maker.trader)).toBe(dollars(1.5));
    expect(ioc()).toHaveLength(2);
    expect((await makerOrders("buy")).length).toBeGreaterThan(0);
    expect(maker.emptySide).toBeNull();
  });

  it("sells no more than the level it was quoting, whatever the user bids for", async () => {
    const { venue, maker, moveTo, userRests, positionOf, ioc } = await setup();
    await maker.tick(venue);
    await userRests("buy", 99.5, 5);

    await moveTo(99);
    await maker.tick(venue);

    expect(ioc().every((order) => order.size <= dollars(1))).toBe(true);
    expect(await positionOf("user")).toBe(dollars(2));
  });

  it("is held to the position limit, and sends no take once that leaves no room", async () => {
    const { venue, maker, moveTo, userRests, positionOf, ioc } = await setup({
      positionLimitNotional: dollars(100),
    });
    await maker.tick(venue);
    await userRests("buy", 99.5, 5);

    await moveTo(99);
    await maker.tick(venue);
    expect(ioc().every((order) => order.size <= dollars(1))).toBe(true);
    const soldAfterFirst = await positionOf("user");
    expect(soldAfterFirst).toBeLessThanOrEqual(dollars(1.02));
    const takesAfterFirst = ioc().length;

    await moveTo(99, INTERVAL_MS);
    await maker.tick(venue);

    expect(ioc()).toHaveLength(takesAfterFirst);
    expect(await positionOf("user")).toBe(soldAfterFirst);
  });

  it("takes nothing while the risk rules have the quotes pulled", async () => {
    const plan = { action: "quote", centre: dollars(100) };
    const { venue, maker, moveTo, userRests, positionOf, sent } = await setup({
      safety: quoting(plan),
    });
    await maker.tick(venue);
    await userRests("buy", 99.5, 1.5);

    plan.action = "pull";
    plan.centre = dollars(99);
    await moveTo(99);
    const before = sent.length;
    await maker.tick(venue);

    expect(sent).toHaveLength(before);
    expect(await positionOf("user")).toBe(0n);
  });

  it("treats a take that finds nothing as normal and quotes the level again, without stopping", async () => {
    const calls = { stops: [] as string[], alerts: [] as string[] };
    const plan = { action: "quote", centre: dollars(100) };
    const { venue, maker, behaviour, moveTo, userRests, positionOf, makerOrders, ioc, sent } =
      await setup({ safety: quoting(plan, calls) });
    await maker.tick(venue);
    await userRests("buy", 99.5, 1.5);
    behaviour.beforeTake = async () => {
      behaviour.beforeTake = null;
      await venue.cancelAll("user", PERP);
    };

    plan.centre = dollars(99);
    await moveTo(99);
    await maker.tick(venue);

    expect(ioc()).toHaveLength(1);
    expect(sent.filter((order) => order.type === "postOnly" && order.side === "sell")).toHaveLength(
      5,
    );
    expect(await positionOf("user")).toBe(0n);
    expect((await makerOrders("sell")).length).toBeGreaterThan(0);
    expect(calls.stops).toEqual([]);
    expect(calls.alerts).toEqual([]);
  });

  it("holds the maker when a take's outcome is unknown, and frees it once the take's expiry has lapsed", async () => {
    const dir = join("data-test", `takes-crossing-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      const ledger = await MakerLedger.open(makerStatePath(dir, PERP));
      const plan = { action: "quote", centre: dollars(100) };
      const { venue, maker, behaviour, moveTo, userRests, sent, clock } = await setup({
        safety: quoting(plan),
        ledger,
      });
      await maker.tick(venue);
      await userRests("buy", 99.5, 1.5);
      behaviour.takeOutcomeUnknown = true;

      plan.centre = dollars(99);
      await moveTo(99);
      await expect(maker.tick(venue)).rejects.toThrow(/outcome unknown/);
      const take = sent.find((order) => order.type === "ioc");
      expect(take?.expiresAtMs).toBeDefined();
      expect(maker.quarantinedSinceMs).not.toBeNull();

      behaviour.takeOutcomeUnknown = false;
      await moveTo(99, 1_000);
      await maker.tick(venue).catch(() => {});
      expect(maker.quarantinedSinceMs).not.toBeNull();

      const lapse = holdLapsesAtMs(take?.expiresAtMs ?? 0);
      await moveTo(99, lapse - clock.nowMs() + 1);
      await maker.tick(venue);
      expect(maker.quarantinedSinceMs).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends neither a take nor a re-place when it was withdrawn while the refusal was on its way", async () => {
    const { venue, maker, behaviour, sent, ioc } = await setup();
    behaviour.refusePostOnly = { side: "sell", reason: "post-only order would match" };
    let release: () => void = () => {};
    const answerHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    behaviour.delayRefusal = () => answerHeld;

    const ticking = maker.tick(venue);
    await vi.waitFor(() => expect(sent.some((order) => order.side === "sell")).toBe(true));
    const sentBefore = sent.length;
    await maker.withdraw(venue);
    release();
    await ticking;

    expect(ioc()).toHaveLength(0);
    expect(sent).toHaveLength(sentBefore);
  });

  it("sends no take for a refusal that is not a would-match", async () => {
    const { venue, maker, behaviour, ioc } = await setup();
    behaviour.refusePostOnly = { side: "sell", reason: "insufficient margin" };

    await maker.tick(venue);

    expect(ioc()).toHaveLength(0);
  });

  it("takes once and quotes once more per level, even when the second quote is refused too", async () => {
    const { venue, maker, behaviour, sent, ioc } = await setup({
      safety: quoting({ action: "quote", centre: dollars(100) }),
    });
    behaviour.refusePostOnly = { side: "sell", reason: "post-only order would match" };

    await maker.tick(venue);

    expect(ioc()).toHaveLength(2);
    expect(sent.filter((order) => order.type === "postOnly" && order.side === "sell")).toHaveLength(
      4,
    );
  });
});
