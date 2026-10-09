import { describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";

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

    const state = await venue.traderState(maker.traderKey());
    const position = state.positions[PERP]?.size ?? 0n;
    expect(position).toBeLessThanOrEqual(-dollars(1.5));

    const sides = new Set(state.openOrders.map((order) => order.side));
    // Maxed out short: it may still quote asks (further reducing is fine
    // reasoning aside, selling more would deepen the short) but must never
    // quote a buy that would... the hard limit specifically forbids growing
    // past it, i.e. no further sell-side growth. Here it is short past the
    // limit, so it must not quote sell (growing the short further).
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
    const firstQuotes = (await venue.traderState(maker.traderKey())).openOrders;

    // A tiny move: below the 50bps threshold, no requote expected.
    await publish(venue, clock, PERP, 100.1);
    clock.advance(10);
    await maker.tick(venue);
    const afterTinyMove = (await venue.traderState(maker.traderKey())).openOrders;
    expect(afterTinyMove.map((o) => o.price)).toEqual(firstQuotes.map((o) => o.price));

    // A big move: past the threshold, requote expected.
    await publish(venue, clock, PERP, 110);
    clock.advance(10);
    await maker.tick(venue);
    const afterBigMove = (await venue.traderState(maker.traderKey())).openOrders;
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
    const flatOrders = (await venue.traderState(maker.traderKey())).openOrders;
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
    const shortOrders = (await venue.traderState(maker.traderKey())).openOrders;
    const shortMid =
      (shortOrders.find((o) => o.side === "buy")!.price! +
        shortOrders.find((o) => o.side === "sell")!.price!) /
      2n;

    // Short inventory should push the quoting centre up (to attract buys
    // back / discourage selling more), not down.
    expect(shortMid).toBeGreaterThan(flatMid);
  });
});
