import { describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import type { MemoryVenue } from "../src/engine/memory-venue.js";
import type { Venue } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";
const REQUOTE_MS = 1_000;

const quotingMaker = async () => {
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
    requoteIntervalMs: REQUOTE_MS,
    positionLimitNotional: dollars(1_000),
    maxSkewBps: 20,
    lotSize: 1_000n,
    startingQuoteBalance: dollars(100_000),
    startingBaseBalance: 0n,
    clock,
  });
  await maker.ensureOpen(venue);
  return { venue, clock, maker };
};

/** The venue as the maker reads it, with the market's mark gone or the read failing when told to. */
const steered = (venue: MemoryVenue, mode: { noMark: boolean; failing: boolean }): Venue =>
  new Proxy(venue, {
    get(target, property) {
      if (property === "markets") {
        return async () => {
          if (mode.failing) throw new Error("the venue did not answer");
          const markets = await target.markets();
          return mode.noMark ? markets.map((market) => ({ ...market, markPrice: null })) : markets;
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Venue;

describe("when the house maker has no quotes resting", () => {
  it("is quiet from the start and stops being once a ladder rests", async () => {
    const { venue, maker } = await quotingMaker();
    expect(maker.notQuoting?.because).toBe("it has not quoted yet");

    await maker.tick(venue);

    expect(maker.notQuoting).toBeNull();
  });

  it("is quiet once the last ladder has expired, though no tick has said anything since", async () => {
    const { venue, clock, maker } = await quotingMaker();
    await maker.tick(venue);
    expect(maker.notQuoting).toBeNull();

    clock.advance(60_000);

    expect(maker.notQuoting).toMatchObject({ because: "its last quotes expired" });
    expect(clock.nowMs() - (maker.notQuoting?.sinceMs ?? clock.nowMs())).toBeGreaterThan(30_000);
  });

  it("is quiet when ticks stop early for want of a mark, and again when one comes back", async () => {
    const { venue, clock, maker } = await quotingMaker();
    const mode = { noMark: false, failing: false };
    const seen = steered(venue, mode);
    await maker.tick(seen);

    mode.noMark = true;
    clock.advance(500);
    await maker.tick(seen);
    expect(maker.notQuoting).toMatchObject({ because: "the market has no mark price" });

    mode.noMark = false;
    clock.advance(REQUOTE_MS);
    await maker.tick(seen);
    expect(maker.notQuoting).toBeNull();
  });

  it("is quiet when a tick fails, and not when the ladder still stands on the next one that works", async () => {
    const { venue, clock, maker } = await quotingMaker();
    const mode = { noMark: false, failing: false };
    const seen = steered(venue, mode);
    await maker.tick(seen);

    mode.failing = true;
    await expect(maker.tick(seen)).rejects.toThrow("did not answer");
    expect(maker.notQuoting?.because).toContain("its last tick failed");

    mode.failing = false;
    clock.advance(100);
    await maker.tick(seen);
    expect(maker.notQuoting).toBeNull();
  });
});
