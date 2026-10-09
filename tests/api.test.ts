import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig, type Config } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import type { AppContext } from "../src/http/context.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import { dollars } from "./helpers.js";

const testConfig = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    ALLOWED_ORIGINS: "http://localhost:9999",
    ...overrides,
  } as NodeJS.ProcessEnv);

const buildCtx = (
  overrides: Record<string, string> = {},
): { ctx: AppContext; clock: ManualClock } => {
  const config = testConfig(overrides);
  const clock = new ManualClock(1_000_000);
  const venue = new MemoryVenue({ clock });
  const tape = new TapeStore();
  const candles = new CandleAggregator();
  const stats = new StatsTracker();
  const fundLedger = new FundLedger({
    perIpLimit: config.FUND_IP_RATE_LIMIT,
    perIpWindowMs: config.FUND_IP_RATE_WINDOW_MS,
    clock,
  });
  const hub = new Hub();
  venue.onFill((fill) => {
    tape.record(fill);
    candles.record(fill);
    hub.broadcastFill(fill);
  });
  return { ctx: { config, venue, tape, candles, stats, fundLedger, hub }, clock };
};

let runningApp: FastifyInstance | null = null;

afterEach(async () => {
  if (runningApp) {
    await runningApp.close();
    runningApp = null;
  }
});

describe("HTTP API", () => {
  it("funds an address once, then refuses a second grant for the same address", async () => {
    const { ctx } = buildCtx();
    const app = await buildServer(ctx);
    const address = "11111111111111111111111111111111";

    const first = await app.inject({ method: "POST", url: "/v1/fund", payload: { address } });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).amount).toBe("5000.000000");

    const second = await app.inject({ method: "POST", url: "/v1/fund", payload: { address } });
    expect(second.statusCode).toBe(409);

    await app.close();
  });

  it("refuses a fund request once the per-IP rate limit is reached", async () => {
    const { ctx } = buildCtx({ FUND_IP_RATE_LIMIT: "2" });
    const app = await buildServer(ctx);

    for (let i = 1; i <= 2; i += 1) {
      const address = `${"A".repeat(31)}${i}`;
      const result = await app.inject({ method: "POST", url: "/v1/fund", payload: { address } });
      expect(result.statusCode).toBe(200);
    }
    const third = await app.inject({
      method: "POST",
      url: "/v1/fund",
      payload: { address: `${"A".repeat(31)}9` },
    });
    expect(third.statusCode).toBe(429);

    await app.close();
  });

  it("refuses a malformed fund address with a 400, never opening a trader for it", async () => {
    const { ctx } = buildCtx();
    const app = await buildServer(ctx);

    const result = await app.inject({
      method: "POST",
      url: "/v1/fund",
      payload: { address: "not-base58!!" },
    });
    expect(result.statusCode).toBe(400);

    await app.close();
  });

  it("dev trading routes are absent unless VENUE=memory and DEV_TRADING=1", async () => {
    const disabled = await buildServer(buildCtx({ DEV_TRADING: "0" }).ctx);
    const disabledResult = await disabled.inject({
      method: "GET",
      url: "/v1/dev/trader?address=x",
    });
    expect(disabledResult.statusCode).toBe(404);
    await disabled.close();

    const wrongVenueCtx = buildCtx({ DEV_TRADING: "1" }).ctx;
    wrongVenueCtx.config = { ...wrongVenueCtx.config, VENUE: "rollup" };
    const wrongVenue = await buildServer(wrongVenueCtx);
    const wrongVenueResult = await wrongVenue.inject({
      method: "GET",
      url: "/v1/dev/trader?address=x",
    });
    expect(wrongVenueResult.statusCode).toBe(404);
    await wrongVenue.close();

    const enabled = await buildServer(buildCtx({ DEV_TRADING: "1" }).ctx);
    const enabledResult = await enabled.inject({ method: "GET", url: "/v1/dev/trader?address=x" });
    expect(enabledResult.statusCode).toBe(200);
    await enabled.close();
  });

  it("rejects an invalid dev order (unknown market) with a 400", async () => {
    const { ctx } = buildCtx({ DEV_TRADING: "1" });
    const app = await buildServer(ctx);

    const result = await app.inject({
      method: "POST",
      url: "/v1/dev/orders",
      payload: {
        address: "abc",
        market: "NOT-A-MARKET",
        side: "buy",
        type: "limit",
        price: "1",
        size: "1",
      },
    });
    expect(result.statusCode).toBe(400);

    await app.close();
  });

  it("places a dev order and reports its fill through GET /v1/tape", async () => {
    const { ctx } = buildCtx({ DEV_TRADING: "1" });
    await ctx.venue.openTrader("seller");
    await ctx.venue.deposit("seller", "SOL", dollars(5));
    await ctx.venue.placeOrder("seller", {
      market: "NSOL-NUSD",
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    const app = await buildServer(ctx);
    await ctx.venue.openTrader("buyer");
    await ctx.venue.deposit("buyer", "nUSD", dollars(1_000));

    const order = await app.inject({
      method: "POST",
      url: "/v1/dev/orders",
      payload: {
        address: "buyer",
        market: "NSOL-NUSD",
        side: "buy",
        type: "ioc",
        price: "100",
        size: "1",
      },
    });
    expect(order.statusCode).toBe(200);
    expect(JSON.parse(order.body).status).toBe("filled");

    const tape = await app.inject({ method: "GET", url: "/v1/tape?market=NSOL-NUSD&limit=10" });
    const body = JSON.parse(tape.body);
    expect(body.fills).toHaveLength(1);
    expect(body.fills[0].size).toBe("1.000000");
    expect(body.network).toBe(ctx.config.NETWORK);
    expect(body.simulated).toBe(true);

    await app.close();
  });

  it("rejects an unknown market on GET /v1/candles with a 400", async () => {
    const { ctx } = buildCtx();
    const app = await buildServer(ctx);
    const result = await app.inject({ method: "GET", url: "/v1/candles?market=BOGUS&interval=1m" });
    expect(result.statusCode).toBe(400);
    await app.close();
  });

  it("delivers a fill over the websocket stream to a subscriber of that market", async () => {
    const { ctx } = buildCtx({ DEV_TRADING: "1" });
    await ctx.venue.openTrader("seller");
    await ctx.venue.deposit("seller", "SOL", dollars(5));
    await ctx.venue.openTrader("buyer");
    await ctx.venue.deposit("buyer", "nUSD", dollars(1_000));
    const app = await buildServer(ctx);
    await app.listen({ port: 0, host: "127.0.0.1" });
    runningApp = app;

    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?market=NSOL-NUSD`);

    const firstFillMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for a fill message")),
        5_000,
      );
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data as string) as Record<string, unknown>;
        if (message.type === "fill") {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
    });

    await ctx.venue.placeOrder("seller", {
      market: "NSOL-NUSD",
      side: "sell",
      type: "limit",
      price: dollars(100),
      size: dollars(1),
    });
    await app.inject({
      method: "POST",
      url: "/v1/dev/orders",
      payload: {
        address: "buyer",
        market: "NSOL-NUSD",
        side: "buy",
        type: "ioc",
        price: "100",
        size: "1",
      },
    });

    const message = await firstFillMessage;
    expect(message.market).toBe("NSOL-NUSD");
    expect(message.size).toBe("1.000000");
    socket.close();
  });
});
