import { mkdir, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type Config, loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import { MARKETS } from "../src/engine/markets.js";
import type { Venue } from "../src/engine/types.js";
import { placingOrdersThrough } from "../src/engine/venue-orders.js";
import { openBots } from "../src/wiring/bots.js";
import { KEEPER_NOT_READ_YET } from "../src/wiring/keeper-heartbeat.js";
import {
  type Fetcher,
  KEEPER_NONCE_PARAMETER,
  KEEPER_SIGNATURE_HEADER,
  type KeeperStatus,
  NetworkKeeperHeartbeat,
  keeperSources,
  parseKeeperSecrets,
  parseKeeperUrls,
  signKeeperStatus,
} from "../src/wiring/keeper-network-heartbeat.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { dollars, makeVenue } from "./helpers.js";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const START_MS = Date.parse("2026-11-13T12:00:00Z");
const MAX_AGE_MS = 30_000;

/** A keeper's answer to a challenge, as the contract describes it, unless a test bends it. */
interface Behaviour {
  down?: boolean;
  httpStatus?: number;
  secret?: string;
  healthy?: boolean;
  failedSteps?: number;
  network?: string;
  keeper?: string;
  /** How long before it answered the sweep ended. */
  sweepAgeMs?: number;
  nonce?: (asked: string) => string;
}

const answer = (id: string, asked: string, nowMs: number, over: Behaviour) => {
  const status: KeeperStatus = {
    v: 1,
    keeper: over.keeper ?? id,
    network: over.network ?? "devnet",
    nonce: over.nonce ? over.nonce(asked) : asked,
    issuedAtMs: nowMs,
    healthy: over.healthy ?? true,
    sweepSeq: 7,
    sweepCompletedAtMs: nowMs - (over.sweepAgeMs ?? 1_000),
    failedSteps: over.failedSteps ?? 0,
  };
  const body = JSON.stringify(status);
  return { body, signature: signKeeperStatus(Buffer.from(over.secret ?? SECRET_A), body) };
};

/** A fetcher standing in for the network: one behaviour per keeper id, on the test's clock. */
const standIn = (clock: ManualClock, behaviours: Record<string, Behaviour>): Fetcher => {
  return async (url) => {
    const parsed = new URL(url);
    const id = parsed.hostname.split(".")[0] ?? "";
    const behaviour = behaviours[id] ?? {};
    if (behaviour.down) throw new Error("connect ECONNREFUSED");
    const { body, signature } = answer(
      id,
      parsed.searchParams.get(KEEPER_NONCE_PARAMETER) ?? "",
      clock.nowMs(),
      behaviour,
    );
    return {
      status: behaviour.httpStatus ?? 200,
      text: async () => body,
      headers: { get: (name) => (name === KEEPER_SIGNATURE_HEADER ? signature : null) },
    };
  };
};

const heartbeatOf = (
  ids: string[],
  behaviours: Record<string, Behaviour>,
  extra: { minHealthy?: number } = {},
) => {
  const clock = new ManualClock(START_MS);
  const heartbeat = new NetworkKeeperHeartbeat({
    sources: ids.map((id) => ({
      id,
      url: `http://${id}.keeper/status`,
      secret: Buffer.from(SECRET_A),
    })),
    network: "devnet",
    minHealthy: extra.minHealthy ?? 1,
    maxAgeMs: MAX_AGE_MS,
    pollEveryMs: 2_000,
    clock,
    fetcher: standIn(clock, behaviours),
  });
  return { clock, heartbeat, behaviours };
};

describe("the keeper's heartbeat over the network", () => {
  it("is not ready before the first answer, quietly", () => {
    const { heartbeat } = heartbeatOf(["k1"], {});

    expect(heartbeat.problem()).toBe(KEEPER_NOT_READ_YET);
  });

  it("counts a signed, healthy, fresh status, and not before it is read", async () => {
    const { heartbeat } = heartbeatOf(["k1"], {});

    await heartbeat.poll();

    expect(heartbeat.problem()).toBeUndefined();
  });

  it("goes stale as the sweep ages, exactly as a stale file does", async () => {
    const { clock, heartbeat } = heartbeatOf(["k1"], {});
    await heartbeat.poll();

    clock.advance(MAX_AGE_MS);
    expect(heartbeat.problem()).toMatch(/keeper k1 has not completed a healthy sweep for 3\ds/);
  });

  it("goes dark when the transport is lost, once the last healthy sweep is too old, and not before", async () => {
    const { clock, heartbeat, behaviours } = heartbeatOf(["k1"], {});
    await heartbeat.poll();

    behaviours.k1 = { down: true };
    clock.advance(5_000);
    await heartbeat.poll();
    expect(heartbeat.problem()).toBeUndefined();

    clock.advance(MAX_AGE_MS);
    await heartbeat.poll();
    expect(heartbeat.problem()).toMatch(/keeper k1 is unreachable and has not completed/);
  });

  it("reports a keeper that was never reachable as unreachable", async () => {
    const { heartbeat } = heartbeatOf(["k1"], { k1: { down: true } });

    await heartbeat.poll();

    expect(heartbeat.problem()).toBe("keeper k1 is unreachable");
  });

  it("treats a 5xx like a lost transport and a 403 as an answer that voids the keeper at once", async () => {
    const { clock, heartbeat, behaviours } = heartbeatOf(["k1"], {});
    await heartbeat.poll();

    behaviours.k1 = { httpStatus: 503 };
    clock.advance(3_000);
    await heartbeat.poll();
    expect(heartbeat.problem()).toBeUndefined();

    behaviours.k1 = { httpStatus: 403 };
    clock.advance(3_000);
    await heartbeat.poll();
    expect(heartbeat.problem()).toBe("keeper k1 refused the request");
  });

  it.each<[string, Behaviour, string]>([
    ["signed with another secret", { secret: SECRET_B }, "not signed with its secret"],
    ["unhealthy", { healthy: false }, "was not healthy"],
    ["with a failed step", { failedSteps: 1 }, "was not healthy"],
    ["for another network", { network: "mainnet" }, "for the network mainnet"],
    ["as another keeper", { keeper: "k2" }, "as another keeper"],
    [
      "to another challenge (a replay)",
      { nonce: () => "00".repeat(16) },
      "another request's challenge",
    ],
    ["with a sweep that ends after the answer", { sweepAgeMs: -5 }, "ends after its answer"],
  ])("voids the keeper at once when its status is %s", async (_what, behaviour, reason) => {
    const { heartbeat, behaviours } = heartbeatOf(["k1"], {});
    await heartbeat.poll();
    expect(heartbeat.problem()).toBeUndefined();

    behaviours.k1 = behaviour;
    heartbeat.reset();
    await heartbeat.poll();

    expect(heartbeat.problem()).toContain(reason);
  });

  it("does not let a wrong answer pass for a healthy one that came before it", async () => {
    const { clock, heartbeat, behaviours } = heartbeatOf(["k1"], {});
    await heartbeat.poll();

    behaviours.k1 = { secret: SECRET_B };
    clock.advance(3_000);
    await heartbeat.poll();

    expect(heartbeat.problem()).toContain("not signed with its secret");
  });

  it("does not ask again before the poll interval, however often it is called", async () => {
    const fetcher = vi.fn<Fetcher>();
    const clock = new ManualClock(START_MS);
    const heartbeat = new NetworkKeeperHeartbeat({
      sources: [{ id: "k1", url: "http://k1.keeper/status", secret: Buffer.from(SECRET_A) }],
      network: "devnet",
      minHealthy: 1,
      maxAgeMs: MAX_AGE_MS,
      pollEveryMs: 2_000,
      clock,
      fetcher: fetcher.mockRejectedValue(new Error("down")),
    });

    await heartbeat.poll();
    await heartbeat.poll();
    clock.advance(1_999);
    await heartbeat.poll();
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await heartbeat.poll();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  describe("with two keepers", () => {
    it("is ready on one healthy copy, and a dead copy does not hide behind it or block it", async () => {
      const { heartbeat } = heartbeatOf(["k1", "k2"], { k2: { down: true } });

      await heartbeat.poll();

      expect(heartbeat.problem()).toBeUndefined();
    });

    it("is not ready when the only fresh copy turns unhealthy, and names both", async () => {
      const { heartbeat } = heartbeatOf(["k1", "k2"], {
        k1: { healthy: false },
        k2: { down: true },
      });

      await heartbeat.poll();

      expect(heartbeat.problem()).toContain("keeper k1 says its last sweep was not healthy");
      expect(heartbeat.problem()).toContain("keeper k2 is unreachable");
    });

    it("needs both when told to", async () => {
      const { heartbeat } = heartbeatOf(
        ["k1", "k2"],
        { k2: { healthy: false } },
        { minHealthy: 2 },
      );

      await heartbeat.poll();

      expect(heartbeat.problem()).toContain("keeper k2");
    });

    it("refuses more required keepers than are named", () => {
      expect(() => heartbeatOf(["k1"], {}, { minHealthy: 2 })).toThrow("only 1 keepers");
    });
  });
});

describe("the keeper settings", () => {
  it("reads id=url entries and id=secret lines, and joins each keeper to its own secret", () => {
    const sources = keeperSources(
      "k1=http://a.example/status, k2=https://b.example/status",
      `# comment\nk1=${SECRET_A}\n\nk2=${SECRET_B}\n`,
    );

    expect(sources.map(({ id }) => id)).toEqual(["k1", "k2"]);
    expect(sources[1]?.secret.toString()).toBe(SECRET_B);
  });

  it("stops on a keeper with no secret, a short secret or a repeated id, and never repeats a value", () => {
    expect(() => keeperSources("k1=http://a.example", SECRET_A)).toThrow("line 1");
    expect(() => keeperSources("k1=http://a.example", `k2=${SECRET_A}`)).toThrow(
      "no secret for keeper k1",
    );
    expect(() => parseKeeperSecrets("k1=short")).toThrow("32 or more");
    expect(() => parseKeeperUrls("k1=http://a.example,k1=http://b.example")).toThrow("repeats");
    expect(() => parseKeeperUrls("k1=ftp://secret.example")).not.toThrow("secret.example");
    expect(() => parseKeeperUrls("k1=ftp://secret.example")).toThrow("http or https");
  });

  const base = { VENUE: "memory" } as NodeJS.ProcessEnv;

  it("refuses both transports at once, and the network one without secrets", () => {
    expect(() =>
      loadConfig({
        ...base,
        KEEPER_HEARTBEAT_FILE: "/hb",
        KEEPER_HEARTBEAT_URLS: "k1=http://a.example",
      }),
    ).toThrow("Pick one transport");
    expect(() => loadConfig({ ...base, KEEPER_HEARTBEAT_URLS: "k1=http://a.example" })).toThrow(
      "without KEEPER_HEARTBEAT_SECRETS_FILE",
    );
  });
});

const ROOT = join("data-test", `keeper-network-${Date.now()}`);
afterAll(() => rm(ROOT, { recursive: true, force: true }));

describe("the maker's trading readiness, with the keeper reached over a real connection", () => {
  let server: Server | null = null;
  let behaviour: Behaviour = {};

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
    behaviour = {};
  });

  const startKeeper = async (): Promise<string> => {
    server = createServer((request, response) => {
      if (behaviour.down) return request.socket.destroy();
      const asked = new URL(request.url ?? "/", "http://x").searchParams.get(
        KEEPER_NONCE_PARAMETER,
      );
      const { body, signature } = answer("k1", asked ?? "", Date.now(), behaviour);
      response
        .writeHead(behaviour.httpStatus ?? 200, { [KEEPER_SIGNATURE_HEADER]: signature })
        .end(body);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/status`;
  };

  const maker = async (name: string, url: string, extra: Partial<Config> = {}) => {
    const dir = join(ROOT, name);
    await mkdir(dir, { recursive: true });
    const secrets = join(dir, "keeper-secrets");
    await writeFile(secrets, `k1=${SECRET_A}\n`);
    const { venue } = makeVenue();
    const counting: Venue = placingOrdersThrough(venue, (trader, order) =>
      venue.placeOrder(trader, order),
    );
    const wiring = {
      venue: counting,
      botVenue: counting,
      botMarkets: [MARKETS[0]],
      botSizes: async () => ({
        makerLevel: dollars(0.3),
        takerMin: 0n,
        takerMax: 0n,
        lotSize: dollars(0.001),
        takerStartingBase: 0n,
      }),
      afterMakersOpen: async () => {},
      needsFundingUpdater: false,
      liquidationTargets: () => [],
    } as unknown as VenueWiring;
    const config = {
      ...loadConfig({
        VENUE: "memory",
        NOISE_TAKERS_ENABLED: "0",
        LIQUIDATOR_ENABLED: "0",
        HOUSE_MAKER_RISK_RULES: "1",
        DATA_DIR: dir,
      }),
      KEEPER_HEARTBEAT_URLS: `k1=${url}`,
      KEEPER_HEARTBEAT_SECRETS_FILE: secrets,
      KEEPER_HEARTBEAT_POLL_MS: 20,
      HOUSE_MAKER_TICK_MS: 20,
      ...extra,
    };
    const problems = { onError: () => {}, onRecovered: () => {} };
    return openBots(config, wiring, problems);
  };

  /** Runs the readiness loop on real time until the keeper has been heard from, then answers what it settled on. */
  const settled = async (
    bots: Awaited<ReturnType<typeof maker>>,
    until: (reason: string) => boolean,
  ) => {
    const loops = bots.start();
    try {
      await vi.waitFor(() => expect(until(bots.trading().reason ?? "")).toBe(true), {
        timeout: 3_000,
      });
      return bots.trading();
    } finally {
      for (const loop of loops) loop.stop();
    }
  };
  const heardFrom = (reason: string) =>
    !reason.includes("has not been read yet") &&
    !reason.includes("the market has not been read yet");

  it("is ready on a signed, healthy status", async () => {
    const bots = await maker("ready", await startKeeper());

    expect(await settled(bots, heardFrom)).toEqual({ ready: true });
  });

  it("is not ready when the keeper's status is stale", async () => {
    behaviour = { sweepAgeMs: 60_000 };
    const bots = await maker("stale", await startKeeper());

    const trading = await settled(bots, (reason) => reason.includes("healthy sweep for"));

    expect(trading.ready).toBe(false);
  });

  it("is not ready when the keeper is missing", async () => {
    behaviour = { down: true };
    const bots = await maker("missing", await startKeeper());

    const trading = await settled(bots, (reason) => reason.includes("keeper k1 is unreachable"));

    expect(trading.ready).toBe(false);
  });

  it("is not ready when the keeper's answer is not signed with its secret", async () => {
    behaviour = { secret: SECRET_B };
    const bots = await maker("unauthenticated", await startKeeper());

    const trading = await settled(bots, (reason) => reason.includes("not signed with its secret"));

    expect(trading.ready).toBe(false);
  });

  it("is not ready when the keeper says its sweep was unhealthy", async () => {
    behaviour = { healthy: false };
    const bots = await maker("unhealthy", await startKeeper());

    const trading = await settled(bots, (reason) => reason.includes("was not healthy"));

    expect(trading.ready).toBe(false);
  });

  it("goes not ready after the keeper is lost, once its last healthy sweep is too old", async () => {
    behaviour = { sweepAgeMs: 0 };
    const bots = await maker("lost", await startKeeper(), { KEEPER_HEARTBEAT_MAX_AGE_MS: 300 });
    const loops = bots.start();
    try {
      await vi.waitFor(() => expect(bots.trading()).toEqual({ ready: true }), { timeout: 3_000 });

      behaviour = { down: true, sweepAgeMs: 0 };

      await vi.waitFor(
        () => expect(bots.trading().reason ?? "").toContain("keeper k1 is unreachable and has not"),
        { timeout: 3_000 },
      );
    } finally {
      for (const loop of loops) loop.stop();
    }
  });
});
