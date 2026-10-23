import { describe, expect, it } from "vitest";
import { type HedgeInput, decideHedge } from "../src/hedge/hedge-decision.js";
import { dollars } from "./helpers.js";

const input = (over: Partial<HedgeInput> = {}): HedgeInput => ({
  makerPosition: dollars(1),
  hedgePosition: 0n,
  equity: dollars(1_000),
  maxLeverage: 3,
  triggerNotional: dollars(5),
  rules: {
    minOrderNotional: dollars(10),
    sizeIncrement: dollars(0.01),
    priceIncrement: dollars(0.01),
  },
  reference: { ok: true, price: dollars(150) },
  priceBandBps: 20,
  mayGrow: true,
  ...over,
});

describe("the hedge decision", () => {
  it("sells to offset a long maker, with a limit price 20 bps through the reference", () => {
    expect(decideHedge(input())).toEqual({
      action: "order",
      side: "sell",
      size: dollars(1),
      limitPrice: dollars(149.7),
      reduceOnly: false,
    });
  });

  it("buys to offset a short maker, with the limit above the reference", () => {
    expect(decideHedge(input({ makerPosition: dollars(-1) }))).toMatchObject({
      action: "order",
      side: "buy",
      size: dollars(1),
      limitPrice: dollars(150.3),
    });
  });

  it("rounds the size down to the venue's increment and the limit to its price step", () => {
    const decision = decideHedge(
      input({
        makerPosition: dollars(1.23456),
        rules: {
          minOrderNotional: dollars(10),
          sizeIncrement: dollars(0.01),
          priceIncrement: dollars(0.25),
        },
      }),
    );
    expect(decision).toMatchObject({ size: dollars(1.23), limitPrice: dollars(149.75) });
  });

  it("does nothing when the maker is already hedged", () => {
    expect(decideHedge(input({ hedgePosition: dollars(-1) }))).toEqual({
      action: "none",
      reason: "hedged",
    });
  });

  it("leaves exposure under the venue's minimum notional alone, so small differences add up", () => {
    const small = decideHedge(input({ makerPosition: dollars(0.05) }));
    expect(small).toEqual({ action: "none", reason: "below the trigger" });

    const enough = decideHedge(input({ makerPosition: dollars(0.07) }));
    expect(enough).toMatchObject({ action: "order", size: dollars(0.07) });
  });

  it("does not send an order that rounding brings under the venue's minimum", () => {
    expect(decideHedge(input({ makerPosition: dollars(0.0699) }))).toEqual({
      action: "none",
      reason: "below the venue minimum",
    });
  });

  it("waits for the trigger when it is higher than the venue's minimum", () => {
    const decision = decideHedge(
      input({ makerPosition: dollars(0.2), triggerNotional: dollars(50) }),
    );
    expect(decision).toEqual({ action: "none", reason: "below the trigger" });
  });

  it("never grows the hedge past the margin times the leverage cap", () => {
    const capped = decideHedge(input({ makerPosition: dollars(5), equity: dollars(100) }));
    expect(capped).toMatchObject({ side: "sell", size: dollars(2) });

    const partway = decideHedge(
      input({ makerPosition: dollars(5), equity: dollars(100), hedgePosition: dollars(-1.5) }),
    );
    expect(partway).toMatchObject({ side: "sell", size: dollars(0.5) });

    const atCap = decideHedge(
      input({ makerPosition: dollars(5), equity: dollars(100), hedgePosition: dollars(-2) }),
    );
    expect(atCap).toEqual({ action: "none", reason: "margin cap" });
  });

  it("sends nothing to grow the hedge when the account holds no margin", () => {
    expect(decideHedge(input({ equity: 0n }))).toEqual({ action: "none", reason: "margin cap" });
  });

  it("still shrinks a hedge that is past the cap, reduce-only", () => {
    const decision = decideHedge(
      input({
        makerPosition: dollars(1),
        equity: dollars(100),
        hedgePosition: dollars(-4),
      }),
    );
    expect(decision).toMatchObject({ side: "buy", size: dollars(3), reduceOnly: true });
  });

  it("only shrinks the hedge when it may not grow", () => {
    expect(decideHedge(input({ mayGrow: false }))).toEqual({
      action: "none",
      reason: "margin cap",
    });

    const shrinking = decideHedge(
      input({ mayGrow: false, makerPosition: dollars(0.2), hedgePosition: dollars(-1) }),
    );
    expect(shrinking).toMatchObject({ side: "buy", size: dollars(0.8), reduceOnly: true });
  });

  it("is not reduce-only when the order crosses through a flat hedge", () => {
    const decision = decideHedge(input({ hedgePosition: dollars(0.5) }));
    expect(decision).toMatchObject({ side: "sell", size: dollars(1.5), reduceOnly: false });
  });

  it("sends nothing without a trusted reference price", () => {
    const decision = decideHedge(
      input({ reference: { ok: false, reason: "the Kraken price is 11 s old" } }),
    );
    expect(decision).toEqual({
      action: "none",
      reason: "no trusted price",
      detail: "the Kraken price is 11 s old",
    });
  });
});
