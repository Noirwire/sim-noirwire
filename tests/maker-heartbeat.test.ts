import { describe, expect, it } from "vitest";
import { MIN_PING_GAP_MS, healthPing } from "../src/bots/health-ping.js";
import { HouseMaker, type HouseMakerOptions, ladderOrders } from "../src/bots/house-maker.js";
import type { MakerSafety, Plan } from "../src/bots/maker-safety.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import type { MarketInfo, NewOrder, TraderState, Venue } from "../src/engine/types.js";
import { dollars } from "./helpers.js";

const PERP = "NSOL-PERP";
const START_MS = Date.parse("2026-11-02T12:00:00Z");
const SECRET_URL = "https://hc-ping.example/3f9a1c2e-secret-token";

const problemsOf = () => {
  const seen = { errors: [] as string[], recovered: 0 };
  return {
    seen,
    problems: {
      onError: (_what: string, error: unknown) => seen.errors.push((error as Error).message),
      onRecovered: () => (seen.recovered += 1),
    },
  };
};

/** Lets the ping that was just started finish, which takes a few turns of the event loop. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the health check ping", () => {
  it("sends one request to the address and reports nothing when it is answered", async () => {
    const sent: string[] = [];
    const { seen, problems } = problemsOf();
    const ping = healthPing(SECRET_URL, problems, async (url) => {
      sent.push(url);
      return { status: 200 };
    });

    ping();
    await settle();

    expect(sent).toEqual([SECRET_URL]);
    expect(seen.errors).toEqual([]);
  });

  it("is not fatal when the monitor cannot be reached, and its message never carries the address", async () => {
    const { seen, problems } = problemsOf();
    const ping = healthPing(SECRET_URL, problems, async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    });

    expect(() => ping()).not.toThrow();
    await settle();

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]).toContain("Quoting is not affected");
    expect(seen.errors[0]).not.toContain("secret-token");
    expect(seen.errors[0]).not.toContain("hc-ping.example");
  });

  it("says what the monitor answered when it is not a success, and what to check", async () => {
    const { seen, problems } = problemsOf();
    const ping = healthPing(SECRET_URL, problems, async () => ({ status: 404 }));

    ping();
    await settle();

    expect(seen.errors).toEqual(["the monitor answered 404. Check HEALTHCHECK_URL."]);
  });

  it("survives a log that throws", async () => {
    const clock = new ManualClock(START_MS);
    let sends = 0;
    const ping = healthPing(
      SECRET_URL,
      {
        onError: () => {
          throw new Error("the log is broken");
        },
        onRecovered: () => {},
      },
      async () => {
        sends += 1;
        return { status: 500 };
      },
      clock,
    );

    ping();
    await settle();
    clock.advance(MIN_PING_GAP_MS);
    ping();
    await settle();

    expect(sends).toBe(2);
  });

  it("reports that it works again after a failure, and sends no second ping while one is on its way", async () => {
    const { seen, problems } = problemsOf();
    const clock = new ManualClock(START_MS);
    let answers = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ping = healthPing(
      SECRET_URL,
      problems,
      async () => {
        answers += 1;
        if (answers === 1) throw new Error("down");
        await gate;
        return { status: 200 };
      },
      clock,
    );

    ping();
    await settle();
    clock.advance(MIN_PING_GAP_MS);
    ping();
    clock.advance(MIN_PING_GAP_MS);
    ping();
    await settle();
    expect(answers).toBe(2);
    release();
    await settle();

    expect(seen.errors).toHaveLength(1);
    expect(seen.recovered).toBe(1);
  });

  it("sends at most one ping every 15 s, however often the maker requotes", async () => {
    const clock = new ManualClock(START_MS);
    const sent: number[] = [];
    const ping = healthPing(
      SECRET_URL,
      problemsOf().problems,
      async () => {
        sent.push(clock.nowMs() - START_MS);
        return { status: 200 };
      },
      clock,
    );

    for (let at = 0; at <= 60_000; at += 10_000) {
      clock.set(START_MS + at);
      ping();
      await settle();
    }

    expect(sent).toEqual([0, 20_000, 40_000, 60_000]);
  });

  it("sends the next ping once 15 s have passed since the last, and not a moment before", async () => {
    const clock = new ManualClock(START_MS);
    let sends = 0;
    const ping = healthPing(
      SECRET_URL,
      problemsOf().problems,
      async () => {
        sends += 1;
        return { status: 200 };
      },
      clock,
    );

    ping();
    await settle();
    clock.advance(MIN_PING_GAP_MS - 1);
    ping();
    await settle();
    expect(sends).toBe(1);

    clock.advance(1);
    ping();
    await settle();
    expect(sends).toBe(2);
  });

  it("counts the gap from the last ping it sent, not from a call it dropped", async () => {
    const clock = new ManualClock(START_MS);
    let sends = 0;
    const ping = healthPing(
      SECRET_URL,
      problemsOf().problems,
      async () => {
        sends += 1;
        return { status: 200 };
      },
      clock,
    );

    ping();
    await settle();
    clock.advance(10_000);
    ping();
    clock.advance(5_000);
    ping();
    await settle();

    expect(sends).toBe(2);
  });

  it("is read from HEALTHCHECK_URL, which is optional and must be an address", () => {
    expect(loadConfig({}).HEALTHCHECK_URL).toBeUndefined();
    expect(loadConfig({ HEALTHCHECK_URL: SECRET_URL }).HEALTHCHECK_URL).toBe(SECRET_URL);
    expect(() => loadConfig({ HEALTHCHECK_URL: "not an address" })).toThrow();
  });
});

class Book {
  orders: NewOrder[] = [];
  cancels = 0;
  failPlacing: Error | null = null;
  failCancelling: Error | null = null;

  asVenue(): Venue {
    const info: MarketInfo = {
      id: PERP,
      kind: "perp",
      base: "SOL",
      quote: "nUSD",
      tickSize: dollars(0.01),
      lotSize: dollars(0.001),
      maxLeverage: 5,
      markPrice: dollars(150),
      markPriceUpdatedAtMs: 0,
      change24h: null,
      volume24h: 0n,
      openInterest: null,
    };
    return {
      markets: async () => [info],
      cancelAll: async () => {
        if (this.failCancelling) throw this.failCancelling;
        this.cancels += 1;
        return 0;
      },
      placeOrder: async (_trader: string, order: NewOrder) => {
        if (this.failPlacing) throw this.failPlacing;
        this.orders.push(order);
        return { orderId: "", tag: 0n, status: "open", filledSize: 0n, remainingSize: order.size };
      },
      traderState: async (): Promise<TraderState> => ({
        trader: "maker",
        balances: {},
        positions: {},
        openOrders: [],
        equity: dollars(1_000),
      }),
    } as unknown as Venue;
  }
}

const makerOver = (over: Partial<HouseMakerOptions>): HouseMaker =>
  new HouseMaker({
    market: PERP,
    kind: "perp",
    baseToken: "SOL",
    quoteToken: "nUSD",
    levels: 2,
    spreadBps: 15,
    levelStepBps: 5,
    baseSizePerLevel: dollars(0.3),
    requoteThresholdBps: 6,
    requoteIntervalMs: 10_000,
    positionLimitNotional: dollars(250),
    maxSkewBps: 20,
    lotSize: dollars(0.001),
    startingQuoteBalance: dollars(1_000),
    startingBaseBalance: 0n,
    clock: new ManualClock(Date.parse("2026-11-02T12:00:00Z")),
    ...over,
  });

describe("the heartbeat of a house maker", () => {
  it("beats after a requote that sent every order, and not when sending failed", async () => {
    let beats = 0;
    const book = new Book();
    const maker = makerOver({ afterRequote: () => (beats += 1) });

    await maker.tick(book.asVenue());
    expect(beats).toBe(1);

    book.failPlacing = new Error("the program answered something new");
    const failing = makerOver({ afterRequote: () => (beats += 1) });
    await expect(failing.tick(book.asVenue())).rejects.toThrow("something new");
    expect(beats).toBe(1);
  });

  it("does not beat on a tick that did not requote", async () => {
    let beats = 0;
    const book = new Book();
    const maker = makerOver({ afterRequote: () => (beats += 1) });

    await maker.tick(book.asVenue());
    await maker.tick(book.asVenue());

    expect(beats).toBe(1);
  });

  it("does not beat while the risk rules pull its quotes", async () => {
    let beats = 0;
    const book = new Book();
    const pulling = {
      assess: async (): Promise<Plan> => ({ action: "pull", reason: "a source is old" }),
      stopFor: async () => {},
    } as unknown as MakerSafety;
    const maker = makerOver({ safety: pulling, afterRequote: () => (beats += 1) });

    await maker.tick(book.asVenue());

    expect(beats).toBe(0);
  });
});

describe("the ladder's edge from the reference price", () => {
  const SHAPE = {
    market: PERP,
    levels: 1,
    spreadBps: 15,
    levelStepBps: 5,
    baseSizePerLevel: dollars(0.3),
    maxSkewBps: 20,
    lotSize: dollars(0.001),
  };
  const atLimitLong = {
    mark: dollars(150),
    tickSize: dollars(0.01),
    position: dollars(1.5),
    positionLimit: dollars(1.5),
  };
  const bpsFromReference = (price: bigint | undefined): number =>
    ((Number(price) / 1e6 - 150) / 150) * 10_000;

  it("lets a strong skew carry the reducing side through the reference when no edge is asked", () => {
    const orders = ladderOrders(SHAPE, atLimitLong);

    const ask = orders.find((order) => order.side === "sell");
    expect(bpsFromReference(ask?.price)).toBeLessThan(0);
  });

  it("keeps every quote at least the edge away from the reference, however strong the skew", () => {
    const long = ladderOrders({ ...SHAPE, levels: 3 }, { ...atLimitLong, minEdgeBps: 15 });
    const short = ladderOrders(
      { ...SHAPE, levels: 3 },
      { ...atLimitLong, position: -atLimitLong.position, minEdgeBps: 15 },
    );

    for (const order of [...long, ...short]) {
      const away = bpsFromReference(order.price);
      expect(order.side === "sell" ? away : -away).toBeGreaterThanOrEqual(15);
    }
    expect(long.some((order) => order.side === "sell")).toBe(true);
    expect(short.some((order) => order.side === "buy")).toBe(true);
  });

  it("does not move a quote that is already further away than the edge", () => {
    const orders = ladderOrders(SHAPE, { ...atLimitLong, position: 0n });
    const withEdge = ladderOrders(SHAPE, { ...atLimitLong, position: 0n, minEdgeBps: 10 });

    expect(withEdge).toEqual(orders);
  });
});

describe("a maker whose cancel failed", () => {
  it("tries the cancel again on the next tick while its quotes are pulled", async () => {
    const book = new Book();
    let plan: Plan = {
      action: "quote",
      centre: dollars(150),
      extraSpreadBps: 0,
      reduceOnly: false,
    };
    const safety = {
      assess: async () => plan,
      stopFor: async () => {},
      requoteSucceeded: () => {},
      alert: () => {},
    } as unknown as MakerSafety;
    const maker = makerOver({ safety });
    const venue = book.asVenue();
    await maker.tick(venue);
    const cancelsBefore = book.cancels;

    plan = { action: "stop" };
    book.failCancelling = new Error("the rollup did not answer");
    await expect(maker.tick(venue)).rejects.toThrow("did not answer");
    book.failCancelling = null;
    await maker.tick(venue);
    await maker.tick(venue);

    expect(book.cancels).toBe(cancelsBefore + 1);
  });
});
