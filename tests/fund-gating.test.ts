import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { loadConfig } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { ManualClock } from "../src/engine/clock.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import type { FundRequests } from "../src/rollup/fund-desk.js";
import type { Readiness } from "../src/rollup/rollup-venue.js";

const READY: Readiness = {
  connected: true,
  pricesFresh: true,
  botsFunded: true,
  fundingUpdates: {},
};
const KEY_COUNT = 4;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const newRequest = () => ({
  owner: Keypair.generate().publicKey.toBase58(),
  orderKeys: Array.from({ length: KEY_COUNT }, () => Keypair.generate().publicKey.toBase58()),
});

const deskServiceOn = async (desk: FundRequests, perIpLimit = 20) => {
  const config = loadConfig({
    ALLOWED_ORIGINS: "http://localhost:9999",
    FUND_IP_RATE_LIMIT: String(perIpLimit),
  } as NodeJS.ProcessEnv);
  const clock = new ManualClock(1_000_000);
  const state = { readiness: { ...READY }, wakes: 0, wakeTakes: Promise.resolve() };
  const activity = new Activity({
    lifecycle: {
      wake: async () => {
        state.wakes += 1;
        await state.wakeTakes;
      },
      sleep: async () => {},
    },
    idleAfterMs: 600_000,
    onError: () => {},
  });
  app = await buildServer({
    config,
    venue: new MemoryVenue({ clock }),
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit, perIpWindowMs: 60_000, clock }),
    hub: new Hub(),
    activity,
    fundDesk: desk,
    readiness: () => state.readiness,
    deployment: () => null,
  });
  const prepare = async () =>
    app!.inject({ method: "POST", url: "/v1/fund/prepare", payload: newRequest() });
  const submit = async () =>
    app!.inject({
      method: "POST",
      url: "/v1/fund/submit",
      payload: { owner: Keypair.generate().publicKey.toBase58(), transaction: "AAAA" },
    });
  return { state, activity, prepare, submit };
};

const okDesk = (): FundRequests & { prepared: number } => {
  const desk = {
    prepared: 0,
    prepare: async () => {
      desk.prepared += 1;
      return { ok: true as const, transaction: "dHg=", expiresAtMs: 2_000_000 };
    },
    submit: async () => ({ ok: true as const, signature: "sig" }),
  };
  return desk;
};

describe("the pace at which the desk is asked", () => {
  it("takes one call at a time: a second request while one is under way is told the desk is busy", async () => {
    let release: () => void = () => {};
    let asked = 0;
    const desk: FundRequests = {
      prepare: async () => {
        asked += 1;
        if (asked === 1) await new Promise<void>((resolve) => (release = resolve));
        return { ok: true, transaction: "dHg=", expiresAtMs: 2_000_000 };
      },
      submit: async () => ({ ok: true, signature: "sig" }),
    };
    const { activity, prepare } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));

    const first = prepare();
    await vi.waitFor(() => expect(asked).toBe(1));
    const second = await prepare();
    release();

    expect(second.statusCode).toBe(503);
    expect(JSON.parse(second.body).error).toContain("busy");
    expect((await first).statusCode).toBe(200);
    expect(asked).toBe(1);
    expect((await prepare()).statusCode).toBe(200);
    expect(asked).toBe(2);
  });

  it("starts the cooldown when the desk answers that the rollup refused or could not be reached, not for a user's mistake", async () => {
    let answer: { ok: false; status: 400 | 503; reason: string } = {
      ok: false,
      status: 503,
      reason: "daily limit reached",
    };
    const desk: FundRequests = {
      prepare: async () => answer,
      submit: async () => ({ ok: true, signature: "sig" }),
    };
    const { activity, prepare } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect((await prepare()).statusCode).toBe(503);
      const cooling = await prepare();
      expect(cooling.statusCode).toBe(503);
      expect(JSON.parse(cooling.body).error).toContain("a moment ago");

      vi.setSystemTime(Date.now() + 5_001);
      answer = { ok: false, status: 400, reason: "not a public key" };
      expect((await prepare()).statusCode).toBe(400);
      expect((await prepare()).statusCode).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the fund desk while the service cannot reach the rollup", () => {
  it("answers 503 and does not ask the desk while the service is asleep, and wakes it", async () => {
    const desk = okDesk();
    const { state, activity, prepare } = await deskServiceOn(desk);
    state.wakeTakes = new Promise(() => {});

    const response = await prepare();
    await vi.waitFor(() => expect(state.wakes).toBe(1));

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toContain("waking up");
    expect(desk.prepared).toBe(0);
    expect(activity.awake).toBe(true);
  });

  it("asks the desk once the service is awake and connected", async () => {
    const desk = okDesk();
    const { activity, prepare } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));

    const response = await prepare();

    expect(response.statusCode).toBe(200);
    expect(desk.prepared).toBe(1);
  });

  it("answers 503 with the reason and does not ask the desk when the rollup stopped answering", async () => {
    const desk = okDesk();
    const { state, activity, prepare, submit } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    state.readiness = { ...READY, connected: false };

    for (const response of [await prepare(), await submit()]) {
      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).error).toContain("cannot be reached");
    }
    expect(desk.prepared).toBe(0);
  });

  it("answers 503 while the bots are not funded yet", async () => {
    const desk = okDesk();
    const { state, activity, prepare } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    state.readiness = { ...READY, botsFunded: false };

    const response = await prepare();

    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error).toContain("still starting");
  });
});

describe("failed fund attempts", () => {
  it("answer 502 when the desk throws, send nobody to it for 5 s, and count each try against the IP's limit", async () => {
    let asked = 0;
    const desk: FundRequests = {
      prepare: async () => {
        asked += 1;
        throw new Error("403 Forbidden");
      },
      submit: async () => ({ ok: true, signature: "sig" }),
    };
    const { activity, prepare } = await deskServiceOn(desk, 2);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      expect((await prepare()).statusCode).toBe(502);
      const cooling = await prepare();
      expect(cooling.statusCode).toBe(503);
      expect(JSON.parse(cooling.body).error).toContain("a moment ago");
      expect(asked).toBe(1);

      vi.setSystemTime(Date.now() + 5_001);
      expect((await prepare()).statusCode).toBe(502);
      vi.setSystemTime(Date.now() + 5_001);
      expect((await prepare()).statusCode).toBe(429);
      expect(asked).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("count when the desk refuses, on prepare and on submit", async () => {
    const desk: FundRequests = {
      prepare: async () => ({ ok: false, status: 400, reason: "not a public key" }),
      submit: async () => ({ ok: false, status: 409, reason: "the account exists" }),
    };
    const { activity, prepare, submit } = await deskServiceOn(desk, 2);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));

    expect((await prepare()).statusCode).toBe(400);
    expect((await submit()).statusCode).toBe(409);

    expect((await prepare()).statusCode).toBe(429);
  });

  it("cost a normal user one try in all: prepare, and a submit that gets the grant", async () => {
    const desk = okDesk();
    const { activity, prepare, submit } = await deskServiceOn(desk, 2);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));

    expect((await prepare()).statusCode).toBe(200);
    expect((await submit()).statusCode).toBe(200);
    expect((await prepare()).statusCode).toBe(200);
    expect((await prepare()).statusCode).toBe(429);
  });

  it("never turn a submit away by the limit its own prepare used up, even at a limit of 1", async () => {
    const desk = okDesk();
    const { activity } = await deskServiceOn(desk, 1);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));
    const request = newRequest();

    const prepared = await app!.inject({
      method: "POST",
      url: "/v1/fund/prepare",
      payload: request,
    });
    const submitted = await app!.inject({
      method: "POST",
      url: "/v1/fund/submit",
      payload: { owner: request.owner, transaction: "AAAA" },
    });
    const another = await app!.inject({
      method: "POST",
      url: "/v1/fund/prepare",
      payload: newRequest(),
    });
    const again = await app!.inject({
      method: "POST",
      url: "/v1/fund/submit",
      payload: { owner: request.owner, transaction: "AAAA" },
    });

    expect(prepared.statusCode).toBe(200);
    expect(submitted.statusCode).toBe(200);
    expect(another.statusCode).toBe(429);
    expect(again.statusCode).toBe(409);
  });

  it("leave room, at the default limit, for a user's prepare and submit and a couple of retries", async () => {
    const desk = okDesk();
    const { activity, prepare, submit } = await deskServiceOn(desk);
    activity.touch();
    await vi.waitFor(() => expect(activity.phase).toBe("awake"));

    for (let attempt = 0; attempt < 3; attempt += 1) expect((await prepare()).statusCode).toBe(200);
    expect((await submit()).statusCode).toBe(200);
    expect((await prepare()).statusCode).toBe(200);
  });
});
