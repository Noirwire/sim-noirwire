import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { type Config, loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import type { AppContext } from "../src/http/context.js";
import { Hub } from "../src/http/hub.js";
import { RateLimiter, SocketLimiter } from "../src/http/rate-limit.js";
import { buildServer } from "../src/http/server.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

const serve = async (over: Partial<Config> = {}, context: Partial<AppContext> = {}) => {
  const config: Config = { ...loadConfig({} as NodeJS.ProcessEnv), NETWORK: "mainnet", ...over };
  const clock = new ManualClock(1_000_000);
  const venue = new MemoryVenue({ clock });
  const hub = new Hub();
  const ctx: AppContext = {
    config,
    venue,
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
    hub,
    activity: new Activity({
      lifecycle: { wake: async () => {}, sleep: async () => {} },
      idleAfterMs: 60_000,
      idleAfterLastSocketMs: 15_000,
      onError: () => {},
    }),
    ...context,
  };
  app = await buildServer(ctx);
  return app;
};

const getFrom = (server: FastifyInstance, url: string, forwardedFor?: string) =>
  server.inject({
    method: "GET",
    url,
    remoteAddress: "10.0.0.1",
    headers: forwardedFor ? { "x-forwarded-for": forwardedFor } : {},
  });

describe("the market data on mainnet", () => {
  it("is labelled live on markets, tape and candles, and the quote is USDC", async () => {
    const server = await serve();

    const markets = JSON.parse((await getFrom(server, "/v1/markets")).body);
    const tape = JSON.parse((await getFrom(server, "/v1/tape?market=NSOL-PERP")).body);
    const candles = JSON.parse(
      (await getFrom(server, "/v1/candles?market=NSOL-PERP&interval=1m")).body,
    );

    expect(markets.network).toBe("mainnet");
    expect(markets.simulated).toBe(false);
    expect(tape.simulated).toBe(false);
    expect(candles.simulated).toBe(false);
    expect(markets.markets.map((market: { quote: string }) => market.quote)).toEqual([
      "USDC",
      "USDC",
      "USDC",
    ]);
  });

  it("stays labelled simulated, with the test dollar, off mainnet", async () => {
    const server = await serve({ NETWORK: "devnet" });

    const markets = JSON.parse((await getFrom(server, "/v1/markets")).body);

    expect(markets.simulated).toBe(true);
    expect(markets.markets[0].quote).toBe("nUSD");
  });

  it("answers the health probe a container runs", async () => {
    const server = await serve();

    const health = await getFrom(server, "/v1/health");

    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, network: "mainnet" });
  });

  it("has no fund routes and no test trading: they answer 404", async () => {
    const server = await serve({ DEV_TRADING: true });
    const address = "11111111111111111111111111111111";

    for (const [method, url] of [
      ["POST", "/v1/fund"],
      ["POST", "/v1/fund/prepare"],
      ["POST", "/v1/fund/submit"],
      ["GET", "/v1/dev/trader?address=x"],
      ["POST", "/v1/dev/orders"],
    ] as const) {
      const answer = await server.inject({ method, url, payload: { address } });
      expect(answer.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it("keeps the fund route off devnet", async () => {
    const server = await serve({ NETWORK: "devnet" });

    const funded = await server.inject({
      method: "POST",
      url: "/v1/fund",
      payload: { address: "11111111111111111111111111111111" },
    });

    expect(funded.statusCode).toBe(200);
  });
});

describe("the seat occupancy gauge", () => {
  it("is on the stats beside the exchange's seat capacity when the gate runs, and absent when it does not", async () => {
    const withGate = await serve(
      {},
      { seatOccupancy: () => ({ viewsOpened: 42, seatCapacity: 2_048 }) },
    );
    const stats = JSON.parse((await getFrom(withGate, "/v1/stats")).body);
    expect(stats.seats).toEqual({ viewsOpened: 42, seatCapacity: 2_048 });

    const withoutGate = await serve();
    expect(JSON.parse((await getFrom(withoutGate, "/v1/stats")).body).seats).toBeUndefined();
  });
});

describe("the per-IP request limit on mainnet", () => {
  it("answers 429 with how long to wait once an address is past its minute's share", async () => {
    const server = await serve({ PUBLIC_RATE_LIMIT_PER_MINUTE: 3 });

    for (let request = 1; request <= 3; request += 1) {
      expect((await getFrom(server, "/v1/stats")).statusCode).toBe(200);
    }
    const refused = await getFrom(server, "/v1/stats");

    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(JSON.parse(refused.body).error).toMatch(/too many requests.*wait \d+ s and try again/);
  });

  it("counts every route and a path that matches none", async () => {
    const server = await serve({ PUBLIC_RATE_LIMIT_PER_MINUTE: 2 });

    await getFrom(server, "/v1/health");
    await getFrom(server, "/wp-admin");

    expect((await getFrom(server, "/v1/markets")).statusCode).toBe(429);
  });

  it("counts each caller apart behind the proxies it was told about", async () => {
    const server = await serve({ PUBLIC_RATE_LIMIT_PER_MINUTE: 1, TRUSTED_PROXY_HOPS: 1 });

    expect((await getFrom(server, "/v1/stats", "203.0.113.1")).statusCode).toBe(200);
    expect((await getFrom(server, "/v1/stats", "203.0.113.2")).statusCode).toBe(200);
    expect((await getFrom(server, "/v1/stats", "203.0.113.1")).statusCode).toBe(429);
  });

  it("ignores a forwarded address when no proxy is trusted, so it cannot be used to dodge the limit", async () => {
    const server = await serve({ PUBLIC_RATE_LIMIT_PER_MINUTE: 1, TRUSTED_PROXY_HOPS: 0 });

    expect((await getFrom(server, "/v1/stats", "203.0.113.1")).statusCode).toBe(200);
    expect((await getFrom(server, "/v1/stats", "203.0.113.2")).statusCode).toBe(429);
  });

  it("does not limit devnet", async () => {
    const server = await serve({ NETWORK: "devnet", PUBLIC_RATE_LIMIT_PER_MINUTE: 1 });

    for (let request = 1; request <= 5; request += 1) {
      expect((await getFrom(server, "/v1/stats")).statusCode).toBe(200);
    }
  });
});

describe("the per-IP stream socket limit on mainnet", () => {
  const open = (port: number): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/stream?market=NSOL-PERP`);
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error("websocket failed to open")));
    });

  it("closes the socket past an address's share, and takes a new one once another closes", async () => {
    const server = await serve({ PUBLIC_SOCKETS_PER_IP: 1 });
    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const first = await open(port);
    const second = await open(port);
    const closed = await new Promise<CloseEvent>((resolve) =>
      second.addEventListener("close", resolve),
    );

    expect(closed.code).toBe(1008);
    expect(closed.reason).toContain("too many open streams");
    expect(first.readyState).toBe(WebSocket.OPEN);

    const firstClosed = new Promise<void>((resolve) =>
      first.addEventListener("close", () => resolve()),
    );
    first.close();
    await firstClosed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = await open(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(third.readyState).toBe(WebSocket.OPEN);
    third.close();
  });
});

describe("the limiters", () => {
  it("starts a new minute for an address, and forgets addresses whose minute ended", () => {
    const clock = new ManualClock(0);
    const limiter = new RateLimiter(2, clock);

    expect(limiter.hit("a")).toBe(0);
    expect(limiter.hit("a")).toBe(0);
    expect(limiter.hit("a")).toBe(60);
    clock.advance(45_000);
    expect(limiter.hit("a")).toBe(15);
    clock.advance(15_000);
    expect(limiter.hit("a")).toBe(0);

    clock.advance(120_000);
    expect(limiter.hit("b")).toBe(0);
    expect((limiter as unknown as { windows: Map<string, unknown> }).windows.has("a")).toBe(false);
  });

  it("hands each address its sockets and takes one back only once", () => {
    const limiter = new SocketLimiter(2);

    const first = limiter.acquire("a");
    const second = limiter.acquire("a");
    expect(limiter.acquire("a")).toBeNull();
    expect(limiter.acquire("b")).not.toBeNull();

    first?.();
    first?.();
    expect(limiter.acquire("a")).not.toBeNull();
    expect(limiter.acquire("a")).toBeNull();
    second?.();
  });
});
