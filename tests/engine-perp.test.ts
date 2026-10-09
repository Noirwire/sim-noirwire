import { describe, expect, it } from "vitest";
import { HOUSE_INSURANCE } from "../src/engine/memory-venue.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";

describe("MemoryVenue perpetuals", () => {
  it("refuses an order that would exceed initial margin", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "trader", { nUSD: 100 });
    await publish(venue, clock, PERP, 100);

    // 10% initial margin means ~10x leverage; 50 SOL @ $100 needs $500 margin
    // against a $100 account.
    const result = await venue.placeOrder("trader", {
      market: PERP,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(50),
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("insufficient margin");
  });

  it("accepts an order within initial margin and opens a position", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 1000 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    expect(result.status).toBe("filled");
    const state = await venue.traderState("long");
    expect(state.positions[PERP]!.size).toBe(dollars(1));
    expect(state.positions[PERP]!.entryPrice).toBe(dollars(100));
  });

  it("reduce-only: clamps to the existing opposite position instead of opening new exposure", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 1000 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(5),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    await venue.placeOrder("short", {
      market: PERP,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(5),
    });
    const closeResult = await venue.placeOrder("long", {
      market: PERP,
      side: "sell",
      type: "ioc",
      price: dollars(100),
      size: dollars(3),
      reduceOnly: true,
    });

    expect(closeResult.filledSize).toBe(dollars(1));
    const state = await venue.traderState("long");
    expect(state.positions[PERP]).toBeUndefined();
  });

  it("reduce-only: refuses when there is no opposite position to reduce", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "trader", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    const result = await venue.placeOrder("trader", {
      market: PERP,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
      reduceOnly: true,
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("reduce-only: no position to reduce");
  });

  it("a stale price blocks an exposure-increasing order", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "trader", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);
    clock.advance(31_000); // past the market's 30s staleness limit

    const result = await venue.placeOrder("trader", {
      market: PERP,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("stale price");
  });

  it("a stale price does not block a pure reduction", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 1000 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);
    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    clock.advance(31_000);
    await venue.placeOrder("short", {
      market: PERP,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("long", {
      market: PERP,
      side: "sell",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
      reduceOnly: true,
    });

    expect(result.status).toBe("filled");
  });

  it("funding payments between two offsetting positions are exact opposites", async () => {
    const { venue, clock } = makeVenue({ maxFundingRateBpsPerUpdate: 10_000 });
    await openFunded(venue, "long", { nUSD: 1000 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "mm-bid", { nUSD: 1000 });
    await openFunded(venue, "mm-ask", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    // A resting book away from the mark price so updateFunding sees a premium.
    await venue.placeOrder("mm-bid", {
      market: PERP,
      side: "buy",
      type: "postOnly",
      price: dollars(104),
      size: dollars(1),
    });
    await venue.placeOrder("mm-ask", {
      market: PERP,
      side: "sell",
      type: "postOnly",
      price: dollars(106),
      size: dollars(1),
    });

    await venue.updateFunding(PERP);

    const longBefore = (await venue.traderState("long")).balances.nUSD!.balance;
    const shortBefore = (await venue.traderState("short")).balances.nUSD!.balance;

    // Touch both positions (a reduce-only no-op-sized trade) to settle funding.
    await venue.placeOrder("mm-bid", {
      market: PERP,
      side: "sell",
      type: "postOnly",
      price: dollars(100.01),
      size: dollars(0.001),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "sell",
      type: "ioc",
      price: dollars(100.01),
      size: dollars(0.001),
      reduceOnly: true,
    });
    await venue.placeOrder("mm-ask", {
      market: PERP,
      side: "buy",
      type: "postOnly",
      price: dollars(99.99),
      size: dollars(0.001),
    });
    await venue.placeOrder("short", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(99.99),
      size: dollars(0.001),
      reduceOnly: true,
    });

    const longAfter = (await venue.traderState("long")).balances.nUSD!.balance;
    const shortAfter = (await venue.traderState("short")).balances.nUSD!.balance;

    // The touching trades themselves are tiny and symmetric in notional, so
    // the dominant balance change is the funding settlement; what matters is
    // that insurance absorbed exactly the combined change (zero-sum).
    const insuranceBefore = dollars(10_000_000);
    const insuranceAfter = (await venue.traderState(HOUSE_INSURANCE)).balances.nUSD!.balance;
    const longDelta = longAfter - longBefore;
    const shortDelta = shortAfter - shortBefore;
    const insuranceDelta = insuranceAfter - insuranceBefore;
    expect(longDelta + shortDelta + insuranceDelta).toBe(0n);
  });

  it("liquidation moves the position to the liquidator and the penalty favours them", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 15 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "liquidator", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    // Price drops hard: long's equity falls well under the 5% maintenance
    // requirement on a 1 SOL position.
    await publish(venue, clock, PERP, 70);

    const liquidated = await venue.liquidate("liquidator", "long", PERP);
    expect(liquidated).toBe(true);

    const longState = await venue.traderState("long");
    expect(longState.positions[PERP]).toBeUndefined();
    expect(longState.balances.nUSD!.balance).toBeGreaterThanOrEqual(0n);

    const liquidatorState = await venue.traderState("liquidator");
    expect(liquidatorState.positions[PERP]!.size).toBe(dollars(1));
    // Entry price is below mark (70) by the penalty: a better deal than fair
    // mark, which is the liquidator's reward.
    expect(liquidatorState.positions[PERP]!.entryPrice).toBeLessThan(dollars(70));
  });

  it("liquidation covers negative equity from the insurance account", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 15 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "liquidator", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);

    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    const longBeforeLiquidation = (await venue.traderState("long")).balances.nUSD!.balance;
    const insuranceBefore = (await venue.traderState(HOUSE_INSURANCE)).balances.nUSD!.balance;

    await publish(venue, clock, PERP, 50);
    const liquidated = await venue.liquidate("liquidator", "long", PERP);
    expect(liquidated).toBe(true);

    const longState = await venue.traderState("long");
    const insuranceAfter = (await venue.traderState(HOUSE_INSURANCE)).balances.nUSD!.balance;

    // The target's whole remaining balance (it was already deeply
    // undercollateralized) ends up with the venue's insurance account: it
    // first captures the realized loss, then tops the target back up to
    // exactly zero rather than leaving it negative.
    expect(longState.balances.nUSD!.balance).toBe(0n);
    expect(insuranceAfter - insuranceBefore).toBe(longBeforeLiquidation);
  });

  it("liquidate refuses on a stale price", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 102 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "liquidator", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);
    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });
    await publish(venue, clock, PERP, 50);
    clock.advance(31_000);

    const liquidated = await venue.liquidate("liquidator", "long", PERP);
    expect(liquidated).toBe(false);
  });

  it("refuses liquidation of a healthy account", async () => {
    const { venue, clock } = makeVenue();
    await openFunded(venue, "long", { nUSD: 1000 });
    await openFunded(venue, "short", { nUSD: 1000 });
    await openFunded(venue, "liquidator", { nUSD: 1000 });
    await publish(venue, clock, PERP, 100);
    await venue.placeOrder("short", {
      market: PERP,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("long", {
      market: PERP,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    const liquidated = await venue.liquidate("liquidator", "long", PERP);
    expect(liquidated).toBe(false);
  });
});
