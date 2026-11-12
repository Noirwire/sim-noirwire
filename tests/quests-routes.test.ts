import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Activity } from "../src/activity/activity.js";
import { loadConfig, questSettings } from "../src/config/config.js";
import { CandleAggregator } from "../src/data/candles.js";
import { FundLedger } from "../src/data/fund-ledger.js";
import { StatsTracker } from "../src/data/stats.js";
import { TapeStore } from "../src/data/tape-store.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import type { AppContext } from "../src/http/context.js";
import { Hub } from "../src/http/hub.js";
import { buildServer } from "../src/http/server.js";
import { deviceConsentText, deviceOffText, questOrdersText } from "../src/quests/signed-text.js";
import { MARKET, type Person, type Rig, hex, newPerson, newSecret, rig } from "./quest-helpers.js";
import { DAY_MS } from "../src/engine/day-window.js";

let app: FastifyInstance | null = null;
let wakes = 0;

afterEach(async () => {
  await app?.close();
  app = null;
});

const serve = async (r: Rig, withQuests = true): Promise<void> => {
  wakes = 0;
  const activity = new Activity({
    lifecycle: {
      wake: async () => {
        wakes += 1;
      },
      sleep: async () => {},
    },
    idleAfterMs: 600_000,
    idleAfterLastSocketMs: 15_000,
    onError: () => {},
  });
  const ctx: AppContext = {
    config: loadConfig({ ALLOWED_ORIGINS: "http://localhost:9999" } as NodeJS.ProcessEnv),
    venue: new MemoryVenue({ clock: r.clock }),
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(),
    fundLedger: new FundLedger({ perIpLimit: 20, perIpWindowMs: 60_000, clock: r.clock }),
    hub: new Hub(),
    activity,
    ...(withQuests ? { quests: r.open() } : {}),
  };
  app = await buildServer(ctx);
};

const post = (url: string, payload: unknown) =>
  app!.inject({ method: "POST", url, payload: payload as object });

const challengeFor = async (person: Person): Promise<string> => {
  const response = await post("/v1/quests/challenge", { wallet: person.wallet.key });
  return (response.json() as { challenge: string }).challenge;
};

const deviceRequest = async (
  r: Rig,
  person: Person,
  over: { until?: string; challenge?: string; text?: (text: string) => string } = {},
) => {
  const base = {
    wallet: person.wallet.key,
    deviceKey: person.device.key,
    until: over.until ?? new Date(r.clock.nowMs() + DAY_MS).toISOString(),
    challenge: over.challenge ?? (await challengeFor(person)),
  };
  const text = deviceConsentText(base);
  return { ...base, signature: person.wallet.sign(over.text ? over.text(text) : text) };
};

const ordersRequest = (
  r: Rig,
  person: Person,
  over: { signedAt?: number; markets?: string[]; count?: number } = {},
) => {
  const batch = {
    deviceKey: person.device.key,
    signedAt: over.signedAt ?? r.clock.nowMs(),
    orders: Array.from({ length: over.count ?? 1 }, (_, at) => ({
      market: over.markets?.[at] ?? MARKET,
      secret: hex(newSecret()),
    })),
  };
  return { ...batch, signature: person.device.sign(questOrdersText(batch)) };
};

const switchOn = async (r: Rig, person: Person) =>
  post("/v1/quests/device", await deviceRequest(r, person));

describe("switching a device on", () => {
  it("takes a wallet's signature over the exact text, then the device's orders", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    expect((await switchOn(r, person)).statusCode).toBe(200);
    const orders = await post("/v1/quests/orders", ordersRequest(r, person, { count: 3 }));
    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toEqual({ accepted: 3 });
  });

  it("refuses a bad wallet signature, a signature over other text, and a reused or expired code", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    const stranger = newPerson();
    const forged = await deviceRequest(r, person);
    forged.signature = stranger.wallet.sign(deviceConsentText(forged));
    const otherText = await deviceRequest(r, person, { text: (text) => `${text}\nExtra` });
    expect((await post("/v1/quests/device", forged)).statusCode).toBe(401);
    expect((await post("/v1/quests/device", otherText)).statusCode).toBe(401);

    const good = await deviceRequest(r, person);
    expect((await post("/v1/quests/device", good)).statusCode).toBe(200);
    expect((await post("/v1/quests/device", good)).statusCode).toBe(401);

    const late = await deviceRequest(r, newPerson());
    r.clock.advance(6 * 60_000);
    expect((await post("/v1/quests/device", late)).statusCode).toBe(401);
  });

  it("refuses a code that was issued to another wallet", async () => {
    const r = rig();
    await serve(r);
    const [person, other] = [newPerson(), newPerson()];
    const request = await deviceRequest(r, person, { challenge: await challengeFor(other) });
    expect((await post("/v1/quests/device", request)).statusCode).toBe(401);
  });

  it("refuses an until in the past or more than 30 days ahead", async () => {
    const r = rig();
    await serve(r);
    for (const offsetMs of [-1_000, 31 * DAY_MS]) {
      const until = new Date(r.clock.nowMs() + offsetMs).toISOString();
      const request = await deviceRequest(r, newPerson(), { until });
      expect((await post("/v1/quests/device", request)).statusCode).toBe(400);
    }
  });

  it("gives every wallet a code, however many are outstanding", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    for (let asked = 0; asked < 8; asked += 1) {
      expect((await post("/v1/quests/challenge", { wallet: person.wallet.key })).statusCode).toBe(
        200,
      );
    }
  });

  it("keeps five devices per wallet and replaces the oldest", async () => {
    const r = rig();
    await serve(r);
    const wallet = newPerson();
    const devices = Array.from({ length: 6 }, () => ({ ...wallet, device: newPerson().device }));
    for (const person of devices) expect((await switchOn(r, person)).statusCode).toBe(200);
    const oldest = await post("/v1/quests/orders", ordersRequest(r, devices[0]));
    const newest = await post("/v1/quests/orders", ordersRequest(r, devices[5]));
    expect(oldest.statusCode).toBe(401);
    expect(newest.statusCode).toBe(200);
  });

  it("switches a device off with its own signature, and answers the same when it was never on", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    await switchOn(r, person);
    const off = { deviceKey: person.device.key, signedAt: r.clock.nowMs() };
    const signature = person.device.sign(deviceOffText(off));
    expect((await post("/v1/quests/device/revoke", { ...off, signature })).statusCode).toBe(200);
    expect((await post("/v1/quests/orders", ordersRequest(r, person))).statusCode).toBe(401);

    const again = await post("/v1/quests/device/revoke", { ...off, signature });
    expect(again.statusCode).toBe(200);
    const forged = await post("/v1/quests/device/revoke", {
      ...off,
      signature: newPerson().device.sign(deviceOffText(off)),
    });
    expect(forged.statusCode).toBe(401);
  });
});

describe("handing over orders", () => {
  it("refuses an unknown device, a stale signedAt and a bad signature the same way", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    const unknown = await post("/v1/quests/orders", ordersRequest(r, person));
    await switchOn(r, person);
    const stale = await post(
      "/v1/quests/orders",
      ordersRequest(r, person, { signedAt: r.clock.nowMs() - 6 * 60_000 }),
    );
    const forged = ordersRequest(r, person);
    forged.signature = newPerson().device.sign(questOrdersText(forged));
    const bad = await post("/v1/quests/orders", forged);
    expect([unknown.statusCode, stale.statusCode, bad.statusCode]).toEqual([401, 401, 401]);
    expect(stale.json()).toEqual(unknown.json());
    expect(bad.json()).toEqual(unknown.json());
  });

  it("refuses an expired device", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    await switchOn(r, person);
    r.clock.advance(2 * DAY_MS);
    expect((await post("/v1/quests/orders", ordersRequest(r, person))).statusCode).toBe(401);
  });

  it("refuses more than 20 orders and a market the service does not have", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    await switchOn(r, person);
    expect(
      (await post("/v1/quests/orders", ordersRequest(r, person, { count: 21 }))).statusCode,
    ).toBe(400);
    expect(
      (await post("/v1/quests/orders", ordersRequest(r, person, { markets: ["NOPE-PERP"] })))
        .statusCode,
    ).toBe(400);
  });

  it("takes the same batch twice without recording it twice", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    await switchOn(r, person);
    const batch = ordersRequest(r, person, { count: 20 });
    expect((await post("/v1/quests/orders", batch)).statusCode).toBe(200);
    expect((await post("/v1/quests/orders", batch)).statusCode).toBe(200);
    for (let batches = 0; batches < 24; batches += 1) {
      expect(
        (await post("/v1/quests/orders", ordersRequest(r, person, { count: 20 }))).statusCode,
      ).toBe(200);
    }
    const over = await post("/v1/quests/orders", ordersRequest(r, person, { count: 1 }));
    expect(over.statusCode).toBe(429);
  });

  it("refuses a body over the size limit", async () => {
    const r = rig();
    await serve(r);
    const response = await post("/v1/quests/orders", { filler: "x".repeat(9_000) });
    expect(response.statusCode).toBe(413);
  });
});

describe("when the quest routes exist", () => {
  it("are absent without a service, which needs the key and all three quest ids", async () => {
    const r = rig();
    await serve(r, false);
    expect((await post("/v1/quests/challenge", { wallet: "x" })).statusCode).toBe(404);

    const ids: Record<string, string> = {
      MAGICBLOCK_QUESTS_API_KEY: "key",
      QUEST_GET_STARTED_ID: "a",
      QUEST_THREE_DAYS_ID: "b",
      QUEST_STREAK_ID: "c",
    };
    const settingsFor = (env: Record<string, string>) =>
      questSettings(loadConfig(env as NodeJS.ProcessEnv));
    expect(settingsFor(ids)).not.toBeNull();
    for (const missing of Object.keys(ids)) {
      const { [missing]: _left, ...rest } = ids;
      expect(settingsFor(rest)).toBeNull();
    }
  });

  it("send the key only over https, or over http on this machine", () => {
    const urlFor = (url: string) => () =>
      loadConfig({ MAGICBLOCK_QUESTS_URL: url } as NodeJS.ProcessEnv);
    expect(urlFor("https://quests.example/push")).not.toThrow();
    expect(urlFor("http://127.0.0.1:9000/push")).not.toThrow();
    expect(urlFor("http://localhost:9000/push")).not.toThrow();
    expect(urlFor("http://quests.example/push")).toThrow();
    expect(urlFor("ftp://quests.example/push")).toThrow();
  });

  it("do not wake the service", async () => {
    const r = rig();
    await serve(r);
    const person = newPerson();
    await switchOn(r, person);
    await post("/v1/quests/orders", ordersRequest(r, person));
    await post("/v1/quests/device/revoke", {
      deviceKey: person.device.key,
      signedAt: 1,
      signature: "x",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wakes).toBe(0);
  });
});
