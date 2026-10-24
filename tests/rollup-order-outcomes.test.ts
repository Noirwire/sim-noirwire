import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import type { NewOrder } from "../src/engine/types.js";
import type { ChainMarket, PlaceOutcome } from "../src/rollup/chain-types.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import {
  RollupVenue,
  PLACE_DEADLINE_MS,
  type RollupVenueOptions,
  SETTLEMENT_DEADLINE_MS,
} from "../src/rollup/rollup-venue.js";
import { dollars } from "./helpers.js";

const fakeTrader = vi.hoisted(() => ({
  place: undefined as undefined | (() => Promise<unknown>),
  cancel: undefined as undefined | (() => Promise<unknown>),
  failToOpen: false,
  /** While set, opening the trader waits for it. */
  opening: undefined as undefined | Promise<void>,
  placed: 0,
  expiries: [] as (number | undefined)[],
}));

vi.mock("../src/rollup/bot-accounts.js", () => ({
  BotAccounts: class {
    count = 0;
    async trader() {
      if (fakeTrader.failToOpen) throw new Error("the trader could not be opened");
      await fakeTrader.opening;
      return {
        address: "owner",
        cancelAll: () => fakeTrader.cancel?.(),
        place: (_market: number, params: { restingExpirySeconds?: number }) => {
          fakeTrader.placed += 1;
          fakeTrader.expiries.push(params.restingExpirySeconds);
          return fakeTrader.place?.();
        },
      };
    }
    allFunded() {
      return true;
    }
    retire() {}
    close() {}
  },
}));

const SOL_PERP: ChainMarket = {
  marketId: 0,
  kind: "perp",
  tick: 100n,
  baseLot: 1_000_000n,
  minNotional: 1_000_000n,
  bandBps: 400,
  initialMarginBps: 1_000,
  maxMoveBps: 250,
  maxPriceAgeSeconds: 10,
  fundingIntervalSeconds: 60,
  baseToken: 1,
  quoteToken: 0,
  positionCap: 1_000_000n,
  status: "active",
  oracleHealth: "healthy",
};

const TRADER = "bot:maker:NSOL-PERP";

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  market: "NSOL-PERP",
  side: "buy",
  type: "limit",
  price: dollars(150),
  size: dollars(2),
  expiresInSeconds: 30,
  ...over,
});

const venueWith = () => {
  const market = new RollupMarket(MARKETS[0], SOL_PERP, 9);
  market.acceptPrice({ price: 150_000n, publishTimeSeconds: 1_000 });
  const options = {
    program: {},
    settings: {
      depositRpcUrl: "http://localhost:1",
      rollupRpcUrl: "http://localhost:1",
      rollupWsUrl: "ws://localhost:1",
      gate: Keypair.generate(),
      faucet: null,
    },
    markets: [MARKETS[0]],
    bots: [],
    recordedThrough: {},
    keyCheckpoints: {},
    usersEverOpened: () => 0,
    handlers: {
      onFill: () => {},
      onPrice: () => {},
      onBotOrder: () => {},
      onBotOrderUnknown: () => {},
      onBotOrderSettled: () => {},
      onChainStats: () => {},
      onError: () => {},
      onRecovered: () => {},
      onUnreachable: () => {},
    },
  } as unknown as RollupVenueOptions;
  const Venue = RollupVenue as unknown as new (
    options: RollupVenueOptions,
    markets: RollupMarket[],
  ) => RollupVenue;
  const venue = new Venue(options, [market]);
  const secrets = () =>
    (venue as unknown as { secrets: { of(market: string): Uint8Array[] } }).secrets.of("NSOL-PERP");
  return { venue, secrets };
};

beforeEach(() => {
  fakeTrader.place = undefined;
  fakeTrader.failToOpen = false;
  fakeTrader.opening = undefined;
  fakeTrader.cancel = undefined;
  fakeTrader.placed = 0;
  fakeTrader.expiries = [];
});

describe("the expiry of a resting order", () => {
  const rested = () =>
    Promise.resolve<PlaceOutcome>({
      status: "rested",
      filled: 0n,
      rested: 1n,
      sendToResultMs: 1,
    });

  it("is exactly the absolute time the caller recorded, however late the order is sent", async () => {
    const { venue } = venueWith();
    fakeTrader.place = rested;
    const recordedAtMs = Date.now() + 5_500;

    await venue.placeOrder(TRADER, order({ expiresInSeconds: 600, expiresAtMs: recordedAtMs }));

    expect(fakeTrader.expiries).toEqual([Math.floor(recordedAtMs / 1_000)]);
  });

  it("still counts from the moment of sending when no absolute time is given", async () => {
    const { venue } = venueWith();
    fakeTrader.place = rested;
    const before = Math.floor(Date.now() / 1_000);

    await venue.placeOrder(TRADER, order({ expiresInSeconds: 30 }));

    expect(fakeTrader.expiries[0]).toBeGreaterThanOrEqual(before + 30);
  });
});

describe("a cancel that completes late", () => {
  it("ends only the orders that stood when it was issued, not a ladder placed after", async () => {
    const { venue, secrets } = venueWith();
    const book = venue as unknown as {
      secrets: { forgetEndedBefore(market: string, tapeReadAtMs: number): void };
    };
    const rested = () =>
      Promise.resolve<PlaceOutcome>({
        status: "rested",
        filled: 0n,
        rested: 1n,
        sendToResultMs: 1,
      });
    fakeTrader.place = rested;
    await venue.placeOrder(TRADER, order());

    let complete: (cancelled: bigint) => void = () => {};
    fakeTrader.cancel = () => new Promise<bigint>((resolve) => (complete = resolve));
    const cancelling = venue.cancelAll(TRADER, "NSOL-PERP");
    await Promise.resolve();
    await venue.placeOrder(TRADER, order());
    expect(secrets()).toHaveLength(2);

    complete(1n);
    await cancelling;
    book.secrets.forgetEndedBefore("NSOL-PERP", Date.now() + 1_000_000);

    expect(secrets()).toHaveLength(1);
  });
});

describe("an order the program never answers", () => {
  afterEach(() => vi.useRealTimers());

  it("is reported as unknown at the deadline, keeps its secret, and a late answer changes nothing", async () => {
    vi.useFakeTimers();
    const { venue, secrets } = venueWith();
    let answer: (outcome: PlaceOutcome) => void = () => {};
    fakeTrader.place = () => new Promise<PlaceOutcome>((resolve) => (answer = resolve));

    const placing = venue.placeOrder(TRADER, order());
    await vi.advanceTimersByTimeAsync(PLACE_DEADLINE_MS - 1);
    let settled = false;
    void placing.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await placing;

    expect(result).toMatchObject({ status: "rejected", outcomeUnknown: true });
    expect(result.reason).toContain("did not answer");
    expect(secrets()).toHaveLength(1);

    answer({ status: "rested", filled: 0n, rested: 1n, sendToResultMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.outcomeUnknown).toBe(true);
    expect(secrets()).toHaveLength(1);
  });

  it("counts as unsettled until the program's own answer or failure, not the deadline", async () => {
    vi.useFakeTimers();
    const { venue } = venueWith();
    let answer: (outcome: PlaceOutcome) => void = () => {};
    let fail: (error: Error) => void = () => {};
    fakeTrader.place = () => new Promise<PlaceOutcome>((resolve) => (answer = resolve));

    const first = venue.placeOrder(TRADER, order());
    await vi.advanceTimersByTimeAsync(PLACE_DEADLINE_MS);
    await first;
    expect(venue.unsettledPlaces(TRADER)).toBe(1);
    expect(venue.unsettledPlaces("bot:other")).toBe(0);

    answer({ status: "rested", filled: 0n, rested: 1n, sendToResultMs: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(venue.unsettledPlaces(TRADER)).toBe(0);

    fakeTrader.place = () => new Promise<PlaceOutcome>((_, reject) => (fail = reject));
    const second = venue.placeOrder(TRADER, order());
    await vi.advanceTimersByTimeAsync(PLACE_DEADLINE_MS);
    await second;
    expect(venue.unsettledPlaces(TRADER)).toBe(1);
    fail(new Error("the connection dropped"));
    await vi.advanceTimersByTimeAsync(0);
    expect(venue.unsettledPlaces(TRADER)).toBe(0);
  });

  it("is a clean rejection, and is never sent later, when the trader was still being opened", async () => {
    vi.useFakeTimers();
    const { venue } = venueWith();
    let opened: () => void = () => {};
    fakeTrader.opening = new Promise<void>((resolve) => (opened = resolve));
    fakeTrader.place = () =>
      Promise.resolve<PlaceOutcome>({
        status: "rested",
        filled: 0n,
        rested: 1n,
        sendToResultMs: 1,
      });

    const placing = venue.placeOrder(TRADER, order());
    await vi.advanceTimersByTimeAsync(PLACE_DEADLINE_MS);
    const result = await placing;
    expect(result.status).toBe("rejected");
    expect(result.outcomeUnknown).toBeUndefined();

    opened();
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeTrader.placed).toBe(0);
  });
});

describe("what the rollup venue tells the maker about an order that may have been sent", () => {
  it("flags an exception after the order was handed to the program as an unknown outcome", async () => {
    const { venue, secrets } = venueWith();
    fakeTrader.place = () => Promise.reject(new Error("the connection dropped"));

    const result = await venue.placeOrder(TRADER, order());

    expect(result).toMatchObject({ status: "rejected", outcomeUnknown: true });
    expect(secrets()).toHaveLength(1);
  });

  it("keeps a clean rejection, with no flag, for a failure before anything was sent", async () => {
    const { venue } = venueWith();
    fakeTrader.failToOpen = true;

    const result = await venue.placeOrder(TRADER, order());

    expect(result.status).toBe("rejected");
    expect(result.outcomeUnknown).toBeUndefined();
  });

  it("carries an unknown outcome through when the settlement itself fails", async () => {
    const { venue, secrets } = venueWith();
    fakeTrader.place = () =>
      Promise.resolve<PlaceOutcome>({
        status: "unknown",
        filled: 0n,
        rested: 0n,
        sendToResultMs: 0,
        settled: Promise.reject(new Error("the rollup stopped answering")),
      });

    const result = await venue.placeOrder(TRADER, order());

    expect(result).toMatchObject({ status: "rejected", outcomeUnknown: true });
    expect(secrets()).toHaveLength(1);
  });

  it("stops waiting for a settlement that never comes and keeps the order unknown", async () => {
    vi.useFakeTimers();
    try {
      const { venue, secrets } = venueWith();
      fakeTrader.place = () =>
        Promise.resolve<PlaceOutcome>({
          status: "unknown",
          filled: 0n,
          rested: 0n,
          sendToResultMs: 0,
          settled: new Promise(() => {}),
        });

      const placing = venue.placeOrder(TRADER, order());
      await vi.advanceTimersByTimeAsync(SETTLEMENT_DEADLINE_MS);
      const result = await placing;

      expect(result).toMatchObject({ status: "rejected", outcomeUnknown: true });
      expect(secrets()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not flag an order the rollup's clock settled as expired", async () => {
    const { venue } = venueWith();
    const expired: PlaceOutcome = { status: "expired", filled: 0n, rested: 0n, sendToResultMs: 0 };
    fakeTrader.place = () =>
      Promise.resolve({ ...expired, status: "unknown", settled: Promise.resolve(expired) });

    const result = await venue.placeOrder(TRADER, order());

    expect(result.status).toBe("rejected");
    expect(result.outcomeUnknown).toBeUndefined();
  });
});

describe("a resting order without an expiry", () => {
  it("is refused before an order secret is registered", async () => {
    const { venue, secrets } = venueWith();

    const result = await venue.placeOrder(TRADER, order({ expiresInSeconds: undefined }));

    expect(result.status).toBe("rejected");
    expect(secrets()).toHaveLength(0);
  });
});
