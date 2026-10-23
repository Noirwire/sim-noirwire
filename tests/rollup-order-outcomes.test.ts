import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import type { NewOrder } from "../src/engine/types.js";
import type { ChainMarket, PlaceOutcome } from "../src/rollup/chain-types.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import { RollupVenue, type RollupVenueOptions } from "../src/rollup/rollup-venue.js";
import { dollars } from "./helpers.js";

const fakeTrader = vi.hoisted(() => ({
  place: undefined as undefined | (() => Promise<unknown>),
  failToOpen: false,
}));

vi.mock("../src/rollup/bot-accounts.js", () => ({
  BotAccounts: class {
    count = 0;
    async trader() {
      if (fakeTrader.failToOpen) throw new Error("the trader could not be opened");
      return { address: "owner", place: () => fakeTrader.place?.() };
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
