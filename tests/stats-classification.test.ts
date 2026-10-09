import { describe, expect, it } from "vitest";
import { withBotTracking } from "../src/bots/instrumented-venue.js";
import { StatsTracker } from "../src/data/stats.js";
import { dollars, makeVenue, openFunded } from "./helpers.js";

const SPOT = "NSOL-NUSD";

describe("bot vs. user fill classification", () => {
  it("classifies a bot taker's own fill as bot activity, not user, the moment it happens", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "bot:maker:test", { SOL: 5 });
    await openFunded(venue, "bot:taker:test", { nUSD: 1000 });

    const stats = new StatsTracker();
    const botVenue = withBotTracking(venue, stats);

    await botVenue.placeOrder("bot:maker:test", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    // The fill happens inside this very call, synchronously, before it
    // returns - a registry populated only after the call resolves would
    // have missed it (the regression this test guards against).
    await botVenue.placeOrder("bot:taker:test", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    const snapshot = stats.snapshot(0);
    expect(snapshot.bot.fills).toBe(1);
    expect(snapshot.user.fills).toBe(0);
    expect(snapshot.bot.volume).toBe(dollars(100));
  });

  it("does not attribute a fill to bot activity just because the resting side was a bot", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "bot:maker:test", { SOL: 5 });
    await openFunded(venue, "a-real-user", { nUSD: 1000 });

    const stats = new StatsTracker();
    const botVenue = withBotTracking(venue, stats);

    await botVenue.placeOrder("bot:maker:test", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });

    // The user trades directly against the raw venue, as the dev-trading
    // route does, and classifies its own fill as user activity.
    const unsubscribe = venue.onFill((fill) => stats.recordFill(fill, "user"));
    await venue.placeOrder("a-real-user", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });
    unsubscribe();

    const snapshot = stats.snapshot(0);
    expect(snapshot.user.fills).toBe(1);
    expect(snapshot.bot.fills).toBe(0);
  });
});
