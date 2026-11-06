import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { makerReadsOf } from "../src/bots/maker-reads.js";
import { type Config, loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MARKETS, type MarketConfig } from "../src/engine/markets.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import type { TraderState, Venue } from "../src/engine/types.js";
import { VenueNotReady } from "../src/engine/venue-not-ready.js";
import type { AppContext } from "../src/http/context.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import { isPricedByMints } from "../src/prices/mints.js";
import {
  BTC_REFERENCE,
  BTC_USD_FEED_ID,
  REFERENCE_MARKETS,
  SOL_REFERENCE,
  SOL_USD_FEED_ID,
  readPythAccount,
  referenceSources,
} from "../src/prices/reference-price.js";
import { pythPriceAccountOf } from "../src/rollup/program.js";
import { type Deployment, deployedMarket, deployedMarkets } from "../src/rollup/settings.js";
import { marketUnits, toChainPrice, toChainSize } from "../src/rollup/units.js";
import { type BotProblems, openBots, referenceMarketOf } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { dollars } from "./helpers.js";

const BTC = "NBTC-PERP";
const SOL = "NSOL-PERP";
const NVDA = "NNVDA-PERP";
const ROOT = join("data-test", `btc-market-${Date.now()}`);

const marketNamed = (id: string): MarketConfig => {
  const found = MARKETS.find((market) => market.id === id);
  if (!found) throw new Error(`no market ${id}`);
  return found;
};

const contextOf = (over: Partial<Config>, extra: Partial<AppContext> = {}): AppContext => {
  const clock = new ManualClock(1_000_000);
  return {
    config: { ...loadConfig({} as NodeJS.ProcessEnv), ...over },
    venue: new MemoryVenue({ clock }),
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
    hub: new Hub(),
    activity: new Activity({
      lifecycle: { wake: async () => {}, sleep: async () => {} },
      idleAfterMs: 60_000,
      idleAfterLastSocketMs: 15_000,
      onError: () => {},
    }),
    ...extra,
  };
};

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("the BTC perpetual's definition", () => {
  it("is listed with the lot and tick of the chain's market, which translate whole", () => {
    const market = marketNamed(BTC);
    expect(market.kind).toBe("perp");
    expect(market.base).toBe("BTC");
    const units = marketUnits(10_000n, 8);
    expect(toChainSize(units, market.lotSize)).toBe(1n);
    expect(toChainPrice(units, market.tickSize)).toBe(100n);
    expect(toChainPrice(units, dollars(75_351.04))).toBe(7_535_104n);
  });

  it("leaves the SOL market's lot and tick as they were", () => {
    const market = marketNamed(SOL);
    const units = marketUnits(1_000_000n, 9);
    expect(toChainSize(units, market.lotSize)).toBe(1n);
    expect(toChainPrice(units, market.tickSize)).toBe(10n);
  });

  it("is the chain's BTC-PERP, and the SOL market is still the chain's SOL-PERP", () => {
    const entry = (id: number, symbol: string) => ({
      id,
      symbol,
      kind: "perp" as const,
      baseDecimals: 9,
    });
    const base = {
      network: "devnet",
      programId: "11111111111111111111111111111111",
      gate: "11111111111111111111111111111111",
      depositUrl: "http://127.0.0.1:1",
      tokens: [],
    };
    const both: Deployment = { ...base, markets: [entry(0, "SOL-PERP"), entry(1, "BTC-PERP")] };
    const solOnly: Deployment = { ...base, markets: [entry(0, "SOL-PERP")] };

    expect(deployedMarket(both, BTC).id).toBe(1);
    expect(deployedMarkets(both, MARKETS).map((market) => market.id)).toEqual([SOL, BTC]);
    expect(deployedMarkets(solOnly, MARKETS).map((market) => market.id)).toEqual([SOL]);
    expect(() => deployedMarket(solOnly, BTC)).toThrow("the deployment has no market NBTC-PERP");
  });

  it("is not run by the in-memory service, which has no price for it", () => {
    expect(isPricedByMints(BTC)).toBe(false);
    expect(isPricedByMints(SOL)).toBe(true);
    expect(isPricedByMints(NVDA)).toBe(true);
  });
});

describe("the reference price of each market", () => {
  it("is configured for SOL and BTC perpetuals and no other market", () => {
    expect(Object.keys(REFERENCE_MARKETS).sort()).toEqual(["BTC", "SOL"]);
    expect(referenceMarketOf(marketNamed(SOL))).toBe(SOL_REFERENCE);
    expect(referenceMarketOf(marketNamed(BTC))).toBe(BTC_REFERENCE);
    expect(referenceMarketOf(marketNamed(NVDA))).toBeUndefined();
    expect(referenceMarketOf(marketNamed("NSOL-NUSD"))).toBeUndefined();
  });

  it("reads Pyth's BTC/USD account from the push oracle's address for its feed", () => {
    expect(BTC_USD_FEED_ID).toBe(
      "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    );
    expect(pythPriceAccountOf(BTC_USD_FEED_ID)).toBe(
      "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
    );
    expect(pythPriceAccountOf(SOL_USD_FEED_ID)).toBe(
      "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE",
    );
  });

  const accountOf = (feedId: string): Buffer => {
    const data = Buffer.alloc(134);
    data[40] = 1;
    Buffer.from(feedId, "hex").copy(data, 41);
    data.writeBigInt64LE(7_535_104_000_000n, 73);
    data.writeBigUInt64LE(1_000_000n, 81);
    data.writeInt32LE(-8, 89);
    data.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1_000)), 93);
    return data;
  };

  it("takes a BTC account only for the BTC feed, and a SOL account only for the SOL feed", () => {
    expect(readPythAccount(accountOf(BTC_USD_FEED_ID), BTC_USD_FEED_ID).price).toBe(
      dollars(75_351.04),
    );
    expect(() => readPythAccount(accountOf(BTC_USD_FEED_ID))).toThrow(
      "the Pyth price account is not the SOL/USD feed",
    );
    expect(() => readPythAccount(accountOf(SOL_USD_FEED_ID), BTC_USD_FEED_ID)).toThrow(
      `the Pyth price account is not the feed ${BTC_USD_FEED_ID}`,
    );
    expect(readPythAccount(accountOf(SOL_USD_FEED_ID)).source).toBe("Pyth");
  });

  const asked = async (market?: typeof BTC_REFERENCE): Promise<string[]> => {
    const urls: string[] = [];
    const quote = { bid: "100.0", ask: "100.2", ts: "1" };
    const answers: Record<string, unknown> = {
      coinbase: quote,
      kraken: { error: [], result: { PAIR: { a: ["100.2", "1", "1"], b: ["100.0", "1", "1"] } } },
      okx: { data: [{ bidPx: "100.0", askPx: "100.2", ts: "1" }] },
    };
    const sources = referenceSources(
      async () => accountOf(market?.feedId ?? SOL_USD_FEED_ID),
      async (url) => {
        urls.push(url);
        return answers[
          url.includes("coinbase") ? "coinbase" : url.includes("kraken") ? "kraken" : "okx"
        ];
      },
      Date.now,
      market,
    );
    await Promise.all(sources.map((source) => source.read()));
    return urls;
  };

  it("asks the BTC pairs of the three exchanges for a BTC market", async () => {
    expect(await asked(BTC_REFERENCE)).toEqual([
      "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
      "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
      "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDC",
    ]);
  });

  it("asks the SOL pairs when no market is named, as it always did", async () => {
    expect(await asked()).toEqual([
      "https://api.exchange.coinbase.com/products/SOL-USD/ticker",
      "https://api.kraken.com/0/public/Ticker?pair=SOLUSD",
      "https://www.okx.com/api/v5/market/ticker?instId=SOL-USDC",
    ]);
  });
});

describe("the makers' risk rules, market by market", () => {
  const openedFor = async (market: MarketConfig) => {
    const venue = new MemoryVenue();
    const wiring = {
      venue,
      botVenue: venue,
      botMarkets: [market],
      botSizes: async () => ({
        makerLevel: market.lotSize * 5n,
        takerMin: 0n,
        takerMax: 0n,
        lotSize: market.lotSize,
        takerStartingBase: 0n,
      }),
      afterMakersOpen: async () => {},
      needsFundingUpdater: false,
      liquidationTargets: () => [],
    } as unknown as VenueWiring;
    const config = loadConfig({
      VENUE: "memory",
      NOISE_TAKERS_ENABLED: "0",
      LIQUIDATOR_ENABLED: "0",
      DATA_DIR: ROOT,
      HOUSE_MAKER_RISK_RULES: "1",
    });
    const problems: BotProblems = { onError: () => {}, onRecovered: () => {} };
    return openBots(config, wiring, problems);
  };

  it("cover the SOL perpetual as before and the BTC perpetual too", async () => {
    for (const id of [SOL, BTC]) {
      const bots = await openedFor(marketNamed(id));
      for (const loop of bots.start()) loop.stop();
    }
  });

  it("still refuse a market with no reference price, naming the ones that have", async () => {
    await expect(openedFor(marketNamed(NVDA))).rejects.toThrow(
      "HOUSE_MAKER_RISK_RULES cannot cover NNVDA-PERP: the risk rules need a reference price, " +
        "and this service has one for SOL and BTC perpetuals only. Leave the market out of the deployment.",
    );
    await expect(openedFor(marketNamed("NSOL-NUSD"))).rejects.toThrow("cannot cover NSOL-NUSD");
  });
});

describe("the maker routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  const stateOf = (over: Partial<TraderState>): TraderState => ({
    trader: "bot:maker:NBTC-PERP",
    balances: {},
    positions: {},
    openOrders: [],
    equity: 0n,
    ...over,
  });

  const serve = async (
    over: Partial<Config>,
    traderState: Venue["traderState"],
    withReads = true,
  ) => {
    app = await buildServer(
      contextOf(
        over,
        withReads
          ? { makerReads: makerReadsOf({ traderState }, [marketNamed(SOL), marketNamed(BTC)]) }
          : {},
      ),
    );
    return app;
  };

  const maker =
    async (state: Record<string, TraderState>) =>
    async (trader: string): Promise<TraderState> => {
      const found = state[trader];
      if (!found) throw new Error(`no state for ${trader}`);
      return found;
    };

  const held = {
    "bot:maker:NBTC-PERP": stateOf({
      positions: { [BTC]: { size: -dollars(1.25), entryPrice: dollars(75_000) } },
      equity: 2_500_000_000n,
    }),
    "bot:maker:NSOL-PERP": stateOf({ equity: 1_000_000_000n }),
  };

  it("serves the maker's signed position and equity off mainnet", async () => {
    const server = await serve({ NETWORK: "devnet" }, await maker(held));

    const position = await server.inject({
      method: "GET",
      url: `/v1/maker/position?market=${BTC}`,
    });
    expect(position.statusCode).toBe(200);
    expect(JSON.parse(position.body)).toEqual({
      market: BTC,
      size: "-1.250000",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });

    const equity = await server.inject({ method: "GET", url: "/v1/maker/equity" });
    expect(equity.statusCode).toBe(200);
    expect(JSON.parse(equity.body)).toEqual({
      equityUsdc6: "3500000000",
      observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    });
    const one = await server.inject({ method: "GET", url: `/v1/maker/equity?market=${BTC}` });
    expect(JSON.parse(one.body).equityUsdc6).toBe("2500000000");
  });

  it("reports a maker with no position as flat", async () => {
    const server = await serve({ NETWORK: "devnet" }, await maker(held));

    const position = await server.inject({
      method: "GET",
      url: `/v1/maker/position?market=${SOL}`,
    });

    expect(JSON.parse(position.body).size).toBe("0.000000");
  });

  it("shows no key, seed or address", async () => {
    const server = await serve({ NETWORK: "devnet" }, await maker(held));

    for (const url of [`/v1/maker/position?market=${BTC}`, "/v1/maker/equity"]) {
      const body = JSON.parse((await server.inject({ method: "GET", url })).body);
      expect(Object.keys(body).sort()).toEqual(
        url.includes("position") ? ["market", "observedAt", "size"] : ["equityUsdc6", "observedAt"],
      );
    }
  });

  it("refuses a missing or unknown market, and a market with no maker", async () => {
    const server = await serve({ NETWORK: "devnet" }, await maker(held));

    expect((await server.inject({ method: "GET", url: "/v1/maker/position" })).statusCode).toBe(
      400,
    );
    expect(
      (await server.inject({ method: "GET", url: "/v1/maker/position?market=NOPE-PERP" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await server.inject({ method: "GET", url: `/v1/maker/position?market=${NVDA}` })).statusCode,
    ).toBe(404);
  });

  it("answers 503 with the reason while the venue is not ready", async () => {
    const server = await serve({ NETWORK: "devnet" }, async () => {
      throw new VenueNotReady("still starting");
    });

    const response = await server.inject({
      method: "GET",
      url: `/v1/maker/position?market=${BTC}`,
    });

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "still starting" });
  });

  it("does not exist on mainnet, even when the context carries the reads", async () => {
    const server = await serve({ NETWORK: "mainnet" }, await maker(held));

    for (const url of [`/v1/maker/position?market=${BTC}`, "/v1/maker/equity"]) {
      expect((await server.inject({ method: "GET", url })).statusCode).toBe(404);
    }
  });
});

describe("the public tape", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("accepts NBTC-PERP, and still refuses a market that does not exist", async () => {
    app = await buildServer(contextOf({ NETWORK: "devnet" }));

    const btc = await app.inject({ method: "GET", url: `/v1/tape?market=${BTC}` });
    const sol = await app.inject({ method: "GET", url: `/v1/tape?market=${SOL}` });
    const none = await app.inject({ method: "GET", url: "/v1/tape?market=NETH-PERP" });

    expect(btc.statusCode).toBe(200);
    expect(JSON.parse(btc.body).fills).toEqual([]);
    expect(sol.statusCode).toBe(200);
    expect(none.statusCode).toBe(400);
  });
});
