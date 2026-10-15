import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { VenueNotReady } from "../src/engine/venue-not-ready.js";
import type { Venue } from "../src/engine/types.js";
import type { AppContext } from "../src/http/context.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import type { Readiness } from "../src/rollup/rollup-venue.js";

const READY: Readiness = {
  connected: true,
  pricesFresh: true,
  botsFunded: true,
  fundingUpdates: {},
};

interface Setup {
  wakes: () => number;
  setWakeHeld: (held: boolean) => void;
  releaseWake: () => void;
  readiness: Readiness;
  startUp: { ready: boolean; problem: string | null };
  venue: Venue;
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

const serviceOn = async (
  rollupShaped: boolean,
  over: Partial<Pick<Setup, "venue">> = {},
): Promise<{ ctx: AppContext; setup: Setup; activity: Activity }> => {
  const config = loadConfig({ ALLOWED_ORIGINS: "http://localhost:9999" } as NodeJS.ProcessEnv);
  const clock = new ManualClock(1_000_000);
  let wakeCount = 0;
  let held = false;
  let release: () => void = () => {};
  const activity = new Activity({
    lifecycle: {
      wake: async () => {
        wakeCount += 1;
        if (held) await new Promise<void>((resolve) => (release = resolve));
      },
      sleep: async () => {},
    },
    idleAfterMs: 600_000,
    onError: () => {},
  });
  const setup: Setup = {
    wakes: () => wakeCount,
    setWakeHeld: (value) => (held = value),
    releaseWake: () => release(),
    readiness: { ...READY },
    startUp: { ready: true, problem: null },
    venue: over.venue ?? new MemoryVenue({ clock }),
  };
  const ctx: AppContext = {
    config,
    venue: setup.venue,
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock }),
    hub: new Hub(),
    activity,
    ...(rollupShaped
      ? {
          readiness: () => setup.readiness,
          startUp: {
            get ready() {
              return setup.startUp.ready;
            },
            get problem() {
              return setup.startUp.problem;
            },
          },
        }
      : {}),
  };
  app = await buildServer(ctx);
  return { ctx, setup, activity };
};

describe("what wakes the service", () => {
  it("wakes on a request to each public route, and not before", async () => {
    const { setup, activity } = await serviceOn(false);
    expect(activity.phase).toBe("asleep");

    await app?.inject({ method: "GET", url: "/v1/markets" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setup.wakes()).toBe(1);
    expect(activity.phase).toBe("awake");
  });

  it.each(["/v1/tape?market=NSOL-PERP", "/v1/candles?market=NSOL-PERP&interval=1m", "/v1/stats"])(
    "wakes on %s",
    async (url) => {
      const { activity } = await serviceOn(false);

      await app?.inject({ method: "GET", url });

      expect(activity.awake).toBe(true);
    },
  );

  it("does not wake on the health probe, however often it is polled", async () => {
    const { setup, activity } = await serviceOn(false);

    for (let probe = 0; probe < 20; probe += 1) {
      await app?.inject({ method: "GET", url: "/v1/health" });
    }

    expect(setup.wakes()).toBe(0);
    expect(activity.awake).toBe(false);
  });

  it("does not wake on a path that is not part of the API", async () => {
    const { setup, activity } = await serviceOn(false);

    const response = await app?.inject({ method: "GET", url: "/wp-login.php" });

    expect(response?.statusCode).toBe(404);
    expect(setup.wakes()).toBe(0);
    expect(activity.awake).toBe(false);
  });

  it("wakes on a stream socket and keeps the service awake while the socket is open", async () => {
    const { activity } = await serviceOn(false);
    await app?.ready();

    const socket = await app?.injectWS("/v1/stream?market=NSOL-PERP");
    expect(activity.awake).toBe(true);

    socket?.terminate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(activity.awake).toBe(true);
  });
});

describe("/v1/markets while the service wakes", () => {
  it("shows every market as warming up until the wake is done, and answers meanwhile", async () => {
    const { setup, activity } = await serviceOn(false);
    setup.setWakeHeld(true);

    const waking = await app?.inject({ method: "GET", url: "/v1/markets" });
    const duringWake = JSON.parse(waking?.body ?? "{}") as { markets: { warmingUp: boolean }[] };
    expect(waking?.statusCode).toBe(200);
    expect(activity.waking).toBe(true);
    expect(duringWake.markets.length).toBeGreaterThan(0);
    expect(duringWake.markets.every((market) => market.warmingUp)).toBe(true);

    setup.releaseWake();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const awake = await app?.inject({ method: "GET", url: "/v1/markets" });
    const afterWake = JSON.parse(awake?.body ?? "{}") as { markets: { warmingUp: boolean }[] };
    expect(afterWake.markets.some((market) => market.warmingUp)).toBe(false);
  });

  it("answers 503 with the reason while the venue has not connected", async () => {
    const refusing: Venue = {
      markets: async () => {
        throw new VenueNotReady("the service is still starting, try again");
      },
    } as unknown as Venue;
    await serviceOn(true, { venue: refusing });

    const response = await app?.inject({ method: "GET", url: "/v1/markets" });

    expect(response?.statusCode).toBe(503);
    expect(JSON.parse(response?.body ?? "{}")).toEqual({
      error: "the service is still starting, try again",
    });
  });
});

describe("/v1/health", () => {
  it("says whether the service is awake", async () => {
    await serviceOn(false);

    const asleep = JSON.parse((await app?.inject({ url: "/v1/health" }))?.body ?? "{}");
    await app?.inject({ url: "/v1/markets" });
    const awake = JSON.parse((await app?.inject({ url: "/v1/health" }))?.body ?? "{}");

    expect(asleep).toMatchObject({ ok: true, awake: false });
    expect(awake).toMatchObject({ ok: true, awake: true });
  });

  it("counts stale prices as healthy while asleep, since an asleep service publishes nothing", async () => {
    const { setup } = await serviceOn(true);
    setup.readiness = { ...READY, connected: false, pricesFresh: false };

    const response = await app?.inject({ url: "/v1/health" });

    expect(response?.statusCode).toBe(200);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({ ok: true, awake: false });
  });

  it("counts stale prices as unhealthy once the service is awake", async () => {
    const { setup, activity } = await serviceOn(true);
    activity.touch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activity.phase).toBe("awake");

    setup.readiness = { ...READY, pricesFresh: false };
    expect((await app?.inject({ url: "/v1/health" }))?.statusCode).toBe(503);

    setup.readiness = { ...READY, connected: false };
    expect((await app?.inject({ url: "/v1/health" }))?.statusCode).toBe(503);

    setup.readiness = { ...READY };
    expect((await app?.inject({ url: "/v1/health" }))?.statusCode).toBe(200);
  });

  it("answers 503 with the reason while the start-up work is refused, asleep or not", async () => {
    const { setup } = await serviceOn(true);
    setup.startUp = { ready: false, problem: "failed to get info about account: 403 Forbidden" };
    setup.readiness = {
      connected: false,
      pricesFresh: false,
      botsFunded: false,
      fundingUpdates: {},
    };

    const response = await app?.inject({ url: "/v1/health" });

    expect(response?.statusCode).toBe(503);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({
      ok: false,
      awake: false,
      reason: "failed to get info about account: 403 Forbidden",
    });
  });

  it("answers 503 saying it is starting before the start-up work has failed once", async () => {
    const { setup } = await serviceOn(true);
    setup.startUp = { ready: false, problem: null };

    const response = await app?.inject({ url: "/v1/health" });

    expect(response?.statusCode).toBe(503);
    expect(JSON.parse(response?.body ?? "{}")).toMatchObject({ ok: false, reason: "starting up" });
  });
});
