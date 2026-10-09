import { describe, expect, it } from "vitest";
import type { Fill } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded } from "./helpers.js";

const SPOT = "NSOL-NUSD";

describe("MemoryVenue spot matching", () => {
  it("fills resting orders in price-time priority: same price, earlier order first", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller-a", { SOL: 2 });
    await openFunded(venue, "seller-b", { SOL: 2 });
    await openFunded(venue, "buyer", { nUSD: 1000 });

    await venue.placeOrder("seller-a", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("seller-b", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });

    const fills: Fill[] = [];
    venue.onFill((fill) => fills.push(fill));

    await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1.5),
    });

    expect(fills).toHaveLength(2);
    expect(fills[0]!.size).toBe(dollars(1));
    expect(fills[1]!.size).toBe(dollars(0.5));

    const sellerAState = await venue.traderState("seller-a");
    const sellerBState = await venue.traderState("seller-b");
    expect(sellerAState.openOrders).toHaveLength(0);
    expect(sellerBState.openOrders).toHaveLength(1);
    expect(sellerBState.openOrders[0]!.remainingSize).toBe(dollars(0.5));
  });

  it("partially fills a limit order and rests the remainder", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });

    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(2),
    });

    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(3),
    });

    expect(result.status).toBe("partiallyFilled");
    expect(result.filledSize).toBe(dollars(2));
    expect(result.remainingSize).toBe(dollars(1));

    const buyerState = await venue.traderState("buyer");
    expect(buyerState.openOrders).toHaveLength(1);
    expect(buyerState.openOrders[0]!.remainingSize).toBe(dollars(1));
  });

  it("limit: matches up to its price and rests any remainder", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });
    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(2),
    });
    expect(result.status).toBe("partiallyFilled");
    expect(result.remainingSize).toBe(dollars(1));
  });

  it("postOnly: rejects outright when it would take liquidity", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });
    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "postOnly",
      price: dollars(101),
      size: dollars(1),
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("would cross the book");

    const sellerState = await venue.traderState("seller");
    expect(sellerState.openOrders).toHaveLength(1);
  });

  it("postOnly: rests in full when it would not cross", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "buyer", { nUSD: 1000 });
    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "postOnly",
      price: dollars(90),
      size: dollars(1),
    });
    expect(result.status).toBe("open");
    expect(result.remainingSize).toBe(dollars(1));
  });

  it("ioc: fills what it can and cancels the rest instead of resting", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });
    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(3),
    });
    expect(result.status).toBe("partiallyFilled");
    expect(result.filledSize).toBe(dollars(1));
    const buyerState = await venue.traderState("buyer");
    expect(buyerState.openOrders).toHaveLength(0);
  });

  it("market: requires a worst price and sweeps the book up to it", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });

    const missingPrice = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "market",
      size: dollars(1),
    });
    expect(missingPrice.status).toBe("rejected");
    expect(missingPrice.reason).toBe("market order requires a worst price");

    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const result = await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "market",
      price: dollars(105),
      size: dollars(1),
    });
    expect(result.status).toBe("filled");
  });

  it("self-trade cancels the resting order instead of filling against itself", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "trader", { SOL: 5, nUSD: 1000 });

    await venue.placeOrder("trader", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });

    const fills: Fill[] = [];
    venue.onFill((fill) => fills.push(fill));

    const result = await venue.placeOrder("trader", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    expect(fills).toHaveLength(0);
    expect(result.filledSize).toBe(0n);
    const state = await venue.traderState("trader");
    expect(state.openOrders).toHaveLength(0);
    expect(state.balances.SOL!.locked).toBe(0n);
  });

  it("releases a spot lock exactly on cancel, never more or less", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "buyer", { nUSD: 1000 });

    await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "limit",
      price: dollars(100),
      size: dollars(2),
    });
    const afterPlace = await venue.traderState("buyer");
    expect(afterPlace.balances.nUSD!.locked).toBeGreaterThan(0n);
    expect(afterPlace.balances.nUSD!.balance + afterPlace.balances.nUSD!.locked).toBe(
      dollars(1000),
    );

    const cancelled = await venue.cancelAll("buyer", SPOT);
    expect(cancelled).toBe(1);

    const afterCancel = await venue.traderState("buyer");
    expect(afterCancel.balances.nUSD!.locked).toBe(0n);
    expect(afterCancel.balances.nUSD!.balance).toBe(dollars(1000));
  });

  it("charges the taker a fee and credits it to the house fee account, never the maker", async () => {
    const { venue } = makeVenue();
    await openFunded(venue, "seller", { SOL: 5 });
    await openFunded(venue, "buyer", { nUSD: 1000 });
    await venue.placeOrder("seller", {
      market: SPOT,
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await venue.placeOrder("buyer", {
      market: SPOT,
      side: "buy",
      type: "ioc",
      price: dollars(100),
      size: dollars(1),
    });

    const seller = await venue.traderState("seller");
    const fees = await venue.traderState("house:fees");
    expect(seller.balances.nUSD!.balance).toBe(dollars(100));
    expect(fees.balances.nUSD!.balance).toBeGreaterThan(0n);
  });
});
