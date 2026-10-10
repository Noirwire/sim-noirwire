import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareRequest, submitRequest } from "../../scripts/fund-client.js";
import { type RunningApp, startApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/config.js";
import { NVDAX_MINT, SOL_MINT } from "../../src/prices/mints.js";
import { connectionTo } from "../../src/rollup/connections.js";
import { Program, type ProgramTrader } from "../../src/rollup/program.js";
import type { PublicDeployment } from "../../src/rollup/public-deployment.js";
import { dollars } from "../helpers.js";
import { CuttableProxy } from "./cuttable-proxy.js";
import { FixedPriceSource } from "./fixed-price-source.js";

const LOCALNET = process.env.ORDERBOOK_LOCALNET;
if (!LOCALNET) throw new Error("Run this suite with `make test-rollup`.");

const ROLLUP_RPC_URL = "http://127.0.0.1:6699";
const ROLLUP_WS_URL = "ws://127.0.0.1:6700";
const PERP = "NSOL-PERP";
const PERP_ID = 0;
const SOL_LOT = 1_000n;
const SOL_LOTS_PER_UNIT = 1_000n;
const GRANT_ATOMS = 5_000_000_000n;
/** Far from the 150 the local set-up publishes, so every start has a walk of several publishes. */
const REAL_SOL_PRICE = 139;

const localFile = (name: string): string => readFileSync(join(LOCALNET, name), "utf8");
const deployment = JSON.parse(localFile("deployment.json")) as { programId: string };
const program = new Program(deployment.programId);
const chain = connectionTo(ROLLUP_RPC_URL, ROLLUP_WS_URL);
/**
 * The service reaches the rollup only through this proxy, so a test can cut
 * its network. The test's own reads above go to the rollup directly.
 */
const PROXY_RPC_PORT = 26_699;
const network = new CuttableProxy([
  { listen: PROXY_RPC_PORT, target: 6699 },
  { listen: PROXY_RPC_PORT + 1, target: 6700 },
]);
const prices = new FixedPriceSource();

let running: RunningApp;
let base: string;

interface Body {
  markets: {
    id: string;
    markPrice: string;
    tickSize: string;
    lotSize: string;
    warmingUp: boolean;
  }[];
  fills: { sequence: number; price: string; size: string }[] & { user: number; bot: number };
  orders: { user: number; bot: number };
  volume: { user: string; bot: string };
  latency: { sampleSize: number; measuredFrom: string };
  transaction: string;
  amount: string;
}

const getJson = async (path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as Body };
};

const postJson = async (path: string, payload: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Body };
};

const eventually = async <T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const pushPrices = (sol: number, nvda: number): void => {
  prices.push({ id: SOL_MINT, price: dollars(sol), atMs: Date.now() });
  prices.push({ id: NVDAX_MINT, price: dollars(nvda), atMs: Date.now() });
};

interface User {
  owner: Keypair;
}

const newUser = (): User => ({ owner: Keypair.generate() });

const prepare = (user: User) => postJson("/v1/fund/prepare", prepareRequest(user.owner));

const signAndSubmit = (user: User, preparedTransaction: string) =>
  postJson("/v1/fund/submit", submitRequest(user.owner, preparedTransaction));

/** A folder of its own, outside `data/`, so a run never touches a service's real snapshot. */
const DATA_DIR = join("data-test", `rollup-${Date.now()}`);
const botSeeds = Array.from({ length: 16 }, () => randomBytes(32).toString("hex")).join(",");

const startService = async (): Promise<WarmUp> => {
  const config = loadConfig({
    VENUE: "rollup",
    HOST: "127.0.0.1",
    NETWORK: "localnet",
    DATA_DIR,
    SOLANA_RPC_URL: "http://127.0.0.1:8899",
    ROLLUP_RPC_URL: `http://127.0.0.1:${PROXY_RPC_PORT}`,
    ROLLUP_WS_URL: `ws://127.0.0.1:${PROXY_RPC_PORT + 1}`,
    DEPLOYMENT_PATH: join(LOCALNET, "deployment.json"),
    ORACLE_SECRET_KEY: localFile("localnet-oracle.json"),
    GATE_SECRET_KEY: localFile("localnet-gate.json"),
    FAUCET_SECRET_KEY: localFile("localnet-faucet.json"),
    BOT_TRADER_SEEDS: botSeeds,
    SERVICE_LOCATION: "the test machine",
    PUBLIC_ROLLUP_RPC_URL: "https://rollup.browser.example",
    NOISE_TAKER_MIN_INTERVAL_MS: "300",
    NOISE_TAKER_MAX_INTERVAL_MS: "900",
  } as NodeJS.ProcessEnv);
  running = await startApp({ ...config, PORT: 0 }, { priceSource: prices });
  base = `http://127.0.0.1:${running.port}`;
  pushPrices(REAL_SOL_PRICE, 181);
  const seen: WarmUp = { warmingUp: false, healthyMeanwhile: false, fillsMeanwhile: 0 };
  await eventually("the service to report healthy", async () => {
    pushPrices(REAL_SOL_PRICE, 181);
    const market = (await getJson("/v1/markets")).body.markets.find((entry) => entry.id === PERP);
    const healthy = (await getJson("/v1/health")).status === 200;
    if (market?.warmingUp) {
      seen.warmingUp = true;
      seen.healthyMeanwhile ||= healthy;
      seen.fillsMeanwhile += (await getJson(`/v1/tape?market=${PERP}&limit=500`)).body.fills.length;
    }
    return healthy;
  });
  return seen;
};

interface WarmUp {
  warmingUp: boolean;
  healthyMeanwhile: boolean;
  fillsMeanwhile: number;
}

let firstStart: WarmUp;

beforeAll(async () => {
  await network.start();
  firstStart = await startService();
});

afterAll(async () => {
  network.restore();
  await running?.close();
  await network.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("the service on the real program (local network)", () => {
  it("keeps the walk from the set-up price to the real one out of the chart, the tape and its health", async () => {
    expect(firstStart.warmingUp).toBe(true);
    expect(firstStart.healthyMeanwhile).toBe(false);
    expect(firstStart.fillsMeanwhile).toBe(0);

    const market = (await getJson("/v1/markets")).body.markets.find((entry) => entry.id === PERP);
    expect(market?.warmingUp).toBe(false);
    const candles = await eventually("a candle from the first real fills", async () => {
      const response = await fetch(`${base}/v1/candles?market=${PERP}&interval=1m`);
      const body = (await response.json()) as { candles: { high: string; low: string }[] };
      return body.candles.length > 0 && body.candles;
    });
    for (const candle of candles) {
      expect(Number(candle.high)).toBeLessThan(REAL_SOL_PRICE * 1.01);
      expect(Number(candle.low)).toBeGreaterThan(REAL_SOL_PRICE * 0.99);
    }
  });

  it("walks a new price onto the chain and reports the chain's mark in /v1/markets", async () => {
    pushPrices(152.3, 181);
    const onChain = await eventually("the feed to reach 152.3", async () => {
      const feed = await program.price(chain, PERP_ID);
      return feed.price === 152_300n && feed;
    });
    expect(onChain.price * SOL_LOTS_PER_UNIT).toBe(dollars(152.3));

    const reported = await eventually("/v1/markets to show 152.3", async () => {
      const market = (await getJson("/v1/markets")).body.markets.find(
        (entry: { id: string }) => entry.id === PERP,
      );
      return market?.markPrice === "152.300000" && market;
    });
    expect(reported.tickSize).toBe("0.100000");
    expect(reported.lotSize).toBe("0.001000");
  });

  it("reports the fills the bots produce in /v1/tape exactly as the chain's tape holds them", async () => {
    const reported = await eventually("a fill in /v1/tape", async () => {
      const { fills } = (await getJson(`/v1/tape?market=${PERP}&limit=500`)).body;
      return fills.length > 0 && fills;
    });
    const tape = await program.tape(chain, PERP_ID);
    const first = reported[0] as {
      sequence: number;
      price: string;
      size: string;
      makerTag: string;
      takerTag: string;
    };
    const onChain = tape.fills.find((fill) => Number(fill.sequence) === first.sequence)!;
    expect(BigInt(Math.round(Number(first.price) * 1e6))).toBe(onChain.price * SOL_LOTS_PER_UNIT);
    expect(BigInt(Math.round(Number(first.size) * 1e6))).toBe(onChain.size * SOL_LOT);
    const asBigEndianDecimal = (receipt: Uint8Array) =>
      Buffer.from(receipt).readBigUInt64BE(0).toString();
    expect(first.makerTag).toBe(asBigEndianDecimal(onChain.makerReceipt));
    expect(first.takerTag).toBe(asBigEndianDecimal(onChain.takerReceipt));
  });

  describe("a user funded through the two-step endpoint", () => {
    const user = newUser();
    let trader: ProgramTrader;

    afterAll(() => trader?.close());

    it("ends with the 5,000 nUSD grant as collateral in their own private view", async () => {
      const prepared = await prepare(user);
      expect(prepared.status).toBe(200);
      const funded = await signAndSubmit(user, prepared.body.transaction);
      expect(funded.status).toBe(200);
      expect(funded.body.amount).toBe("5000.000000");

      trader = await program.newTrader(ROLLUP_RPC_URL, user.owner);
      expect(await trader.sync(PERP_ID)).toBe(true);
      expect((await trader.view()).collateral).toBe(GRANT_ATOMS);
    });

    it("is refused a second grant for the same address", async () => {
      expect((await prepare(user)).status).toBe(409);
    });

    it("fills a market order against the house maker, and the websocket delivers that market's fills", async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${running.port}/v1/stream?market=${PERP}`);
      const fillMessage = new Promise<Record<string, unknown>>((resolve) => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data as string) as Record<string, unknown>;
          if (message.type === "fill") resolve(message);
        });
      });
      await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));

      const mark = (await program.price(chain, PERP_ID)).price;
      const lots = 40n;
      const placed = await trader.place(
        PERP_ID,
        {
          side: "buy",
          type: "market",
          price: mark + 1_500n,
          size: lots,
          reduceOnly: false,
          secret: new Uint8Array(randomBytes(16)),
        },
        [0, 1],
      );
      expect(placed.status).toBe("filled");
      expect(placed.filled).toBe(lots);
      expect((await trader.view()).perp[PERP_ID]!.base).toBe(lots);

      const message = await fillMessage;
      expect(message.market).toBe(PERP);
      socket.close();
    });

    it("is counted apart from the bots: user fills and bot fills each in their own bucket", async () => {
      // The user order count follows the chain's public counter, which trails the bots' own by a moment.
      const stats = await eventually("a user's fill and order beside the bots'", async () => {
        const { body } = await getJson("/v1/stats");
        return body.fills.user >= 1 && body.fills.bot >= 1 && body.orders.user >= 1 && body;
      });
      expect(Number(stats.volume.user)).toBeGreaterThan(0);
      expect(stats.orders.user).toBeGreaterThanOrEqual(1);
      expect(stats.latency.sampleSize).toBeGreaterThan(0);
      expect(stats.latency.measuredFrom).toContain("the test machine");
    });
  });

  it("describes the deployment to a browser: market ids and addresses that are the chain's own, the browser's URLs, and no key", async () => {
    const response = await fetch(`${base}/v1/deployment`);
    expect(response.headers.get("cache-control")).toContain("public");
    const text = await response.text();
    const described = JSON.parse(text) as PublicDeployment;

    expect(described.rollupRpcUrl).toBe("https://rollup.browser.example");
    expect(described.markets.map((market) => market.symbol).sort()).toEqual(
      ["NNVDA-PERP", "NSOL-NUSD", "NSOL-PERP"].sort(),
    );
    for (const market of described.markets) {
      const onChain = await program.market(chain, market.marketId);
      expect(onChain.marketId).toBe(market.marketId);
      expect(onChain.kind).toBe(market.kind);
      expect(program.publicAddresses(market.marketId)).toMatchObject({
        market: market.market,
        tape: market.tape,
        priceFeed: market.priceFeed,
        exchange: described.exchange,
        stats: described.stats,
      });
      expect(await chain.getAccountInfo(new PublicKey(market.tape))).not.toBeNull();
    }

    const deployed = JSON.parse(localFile("deployment.json")) as Record<string, string>;
    const secrets = ["oracle", "gate", "faucet"].map((role) => localFile(`localnet-${role}.json`));
    for (const hidden of [
      deployed.gate!,
      deployed.oracle!,
      deployed.faucet!,
      ...botSeeds.split(","),
    ]) {
      expect(text).not.toContain(hidden);
    }
    for (const secret of secrets) {
      const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
      expect(text).not.toContain(key.publicKey.toBase58());
      expect(text).not.toContain(secret.trim().slice(1, 40));
    }
  });

  it("refuses a prepared transaction that comes back changed, and opens nothing", async () => {
    const user = newUser();
    const other = newUser();
    const prepared = await prepare(user);
    const forOther = await prepare(other);
    const refused = await postJson("/v1/fund/submit", {
      ...submitRequest(other.owner, forOther.body.transaction),
      owner: user.owner.publicKey.toBase58(),
    });
    expect(refused.status).toBe(400);
    expect((await signAndSubmit(user, prepared.body.transaction)).status).toBe(200);
  });

  it("picks its bots' one-time order keys up from the saved checkpoint after a restart, and trades on", async () => {
    await running.close();
    const saved = JSON.parse(readFileSync(join(DATA_DIR, "snapshot.json"), "utf8")) as {
      orderKeyCheckpoints: Record<string, { nextIndex: number }>;
    };
    const checkpoints = Object.values(saved.orderKeyCheckpoints);
    expect(checkpoints).toHaveLength(10);
    expect(Math.max(...checkpoints.map((checkpoint) => checkpoint.nextIndex))).toBeGreaterThan(8);

    await startService();
    const stats = await eventually("the restarted bots to have orders executed", async () => {
      const { body } = await getJson("/v1/stats");
      return body.orders.bot >= 5 && body;
    });
    expect(stats.latency.sampleSize).toBeGreaterThan(0);
  });

  it("says it is not healthy while its network fails and then hangs, and heals by itself when it returns", async () => {
    const healthNow = async () => (await getJson("/v1/health")).status;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const keepPricing = setInterval(() => pushPrices(REAL_SOL_PRICE, 181), 1_000);
    try {
      network.cut("refuse");
      await eventually("health to turn 503 once the network refuses", async () => {
        return (await healthNow()) === 503;
      });
      await pause(10_000);
      network.cut("hang");
      await pause(20_000);
      expect(await healthNow()).toBe(503);

      const cutUntil = Date.now();
      const fillsBefore = (await program.tape(chain, PERP_ID)).lastSequence;
      const priceBefore = (await program.price(chain, PERP_ID)).publishTimeSeconds;
      network.restore();
      await eventually("health to turn 200 again", async () => (await healthNow()) === 200, 60_000);
      expect(Date.now() - cutUntil).toBeLessThan(30_000);

      expect((await program.price(chain, PERP_ID)).publishTimeSeconds).toBeGreaterThan(priceBefore);
      await eventually("the bots to fill again", async () => {
        return (await program.tape(chain, PERP_ID)).lastSequence > fillsBefore;
      });
      const served = (await getJson(`/v1/tape?market=${PERP}&limit=1`)).body.fills[0]!;
      await eventually("the service's tape to follow the chain again", async () => {
        const latest = (await getJson(`/v1/tape?market=${PERP}&limit=1`)).body.fills[0]!;
        return latest.sequence > Number(fillsBefore) || latest.sequence > served.sequence;
      });
    } finally {
      clearInterval(keepPricing);
      network.restore();
    }
  });
});
