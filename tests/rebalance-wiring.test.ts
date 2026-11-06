import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import { FlowFence } from "../src/rebalance/flow-adjust.js";
import { DEFAULT_BANDS } from "../src/rebalance/planner.js";
import { Rebalancer, type RebalanceChain } from "../src/rebalance/rebalancer.js";
import { RequestSender } from "../src/rebalance/request-sender.js";
import { rebalanceSettings } from "../src/rebalance/settings.js";

const ROOT = join("data-test", `rebalance-wiring-${Date.now()}`);
afterAll(() => rm(ROOT, { recursive: true, force: true }));
const USDC = 1_000_000n;
const BRIDGE = "A".repeat(44);

describe("rebalancing is off unless REBALANCE_URL is set", () => {
  it("has no settings by default", () => {
    expect(rebalanceSettings(loadConfig({}))).toBeNull();
  });

  it("names what is missing, and the bands that are out of order", () => {
    const url = { REBALANCE_URL: "http://bridge.test" };
    expect(() => rebalanceSettings(loadConfig(url))).toThrow(
      /REBALANCE_TOKEN, REBALANCE_BRIDGE_ATA/,
    );
    const full = {
      ...url,
      REBALANCE_TOKEN: "t",
      REBALANCE_BRIDGE_ATA: "A".repeat(44),
      REBALANCE_VALIDATOR: "B".repeat(44),
    };
    expect(rebalanceSettings(loadConfig(full))?.planner.bands).toEqual(DEFAULT_BANDS);
    expect(() => rebalanceSettings(loadConfig({ ...full, REBALANCE_LOW_BPS: "30000" }))).toThrow(
      /rise in that order/,
    );
  });
});

const BASE_MAINNET = {
  NETWORK: "mainnet",
  VENUE: "rollup",
  GATE_SECRET_KEY_FILE: "/g",
  BOT_TRADER_SEEDS_FILE: "/b",
  DEPLOYMENT_PATH: "/d",
  PUBLIC_SOLANA_RPC_URL: "https://a.example",
  PUBLIC_ROLLUP_RPC_URL: "https://b.example",
  PUBLIC_ROLLUP_WS_URL: "wss://c.example",
  TRUSTED_PROXY_HOPS: "0",
  GATE_OPEN: "on",
};

describe("mainnet", () => {
  it("starts as before without the variables", () => {
    expect(() => loadConfig(BASE_MAINNET)).not.toThrow();
  });

  it("refuses to start with any rebalance variable set", () => {
    expect(() => loadConfig({ ...BASE_MAINNET, REBALANCE_URL: "http://x.test" })).toThrow(
      /REBALANCE_URL is set/,
    );
  });
});

describe("the rebalancer end to end", () => {
  const build = async (name: string, reading: Partial<{ equity: bigint; collateral: bigint }>) => {
    await mkdir(ROOT, { recursive: true });
    const clock = new ManualClock(Date.parse("1970-01-01T12:00:00Z"));
    const ledger = await MakerLedger.open(makerStatePath(ROOT, name));
    await ledger.update({
      day: "1970-01-01",
      dayStartEquity: 3_000n * USDC,
      peakEquity: 3_000n * USDC,
    });
    const requested: unknown[] = [];
    let status = "accepted";
    const fetchStub = (async (url: string, init: RequestInit) => {
      if (init.method === "POST" && url.endsWith("/requests")) {
        requested.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ bridgeAta: BRIDGE }), { status: 202 });
      }
      if (init.method === "POST") return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ state: status }), { status: 200 });
    }) as unknown as typeof fetch;
    const sender = await RequestSender.open({
      path: join(ROOT, `${name}-requests.json`),
      url: "http://bridge.test",
      token: "t",
      label: name,
      clock,
      fetch: fetchStub,
      cooldownMs: 1_800_000,
      refusedBackoffMs: 60_000,
    });
    const balances = { rollup: 0n, solana: 0n, bridge: 0n };
    const equity = reading.equity ?? 3_000n * USDC;
    const chain: RebalanceChain = {
      read: async () => ({
        collateral: reading.collateral ?? equity,
        equity,
        initialMargin: 0n,
        withdrawable: reading.collateral ?? equity,
        requirement: 1_000n * USDC,
      }),
      rollupBalance: async () => balances.rollup,
      solanaBalance: async () => balances.solana,
      withdrawFromBook: async (a) => ((balances.rollup += a), "w"),
      shuttleToSolana: async (a) => ((balances.rollup -= a), (balances.solana += a), "s"),
      transferToBridge: async (a) => ((balances.solana -= a), (balances.bridge += a), "t"),
    };
    const settings = rebalanceSettings(
      loadConfig({
        REBALANCE_URL: "http://bridge.test",
        REBALANCE_TOKEN: "t",
        REBALANCE_BRIDGE_ATA: BRIDGE,
        REBALANCE_VALIDATOR: "V".repeat(44),
      }),
    );
    if (!settings) throw new Error("settings");
    const rebalancer = new Rebalancer({
      settings,
      sender,
      chain,
      journalPath: join(ROOT, `${name}-out.json`),
      flowTimings: { landWaitMs: 0 },
      ledger,
      fence: new FlowFence(),
      clock,
      voice: { alert: () => {}, notice: () => {} },
      market: name,
    });
    return {
      rebalancer,
      ledger,
      balances,
      requested,
      sender,
      setStatus: (s: string) => (status = s),
    };
  };

  it("asks for surplus out, moves it, and takes it off the loss limits", async () => {
    const h = await build("out", { equity: 4_000n * USDC });
    await h.rebalancer.tick();
    expect(h.requested).toHaveLength(1);
    expect(Object.keys(h.requested[0] as object)).toHaveLength(6);
    await h.rebalancer.tick();

    expect(h.balances.bridge).toBe(500n * USDC);
    expect(h.sender.open).toBeNull();
    expect(h.ledger.state.dayStartEquity).toBe(2_500n * USDC);
    expect(h.ledger.state.peakEquity).toBe(2_500n * USDC);
  });

  it("asks for collateral in and counts it only once the bridge says it arrived", async () => {
    const h = await build("in", { equity: 1_000n * USDC });
    await h.rebalancer.tick();
    await h.rebalancer.tick();
    expect(h.sender.open?.direction).toBe("in");
    expect(h.ledger.state.dayStartEquity).toBe(3_000n * USDC);

    h.setStatus("credited");
    await h.rebalancer.tick();
    expect(h.sender.open).toBeNull();
    expect(h.ledger.state.lastFlowId).toBeDefined();
  });

  it("asks for nothing inside the dead zone", async () => {
    const h = await build("quiet", { equity: 2_000n * USDC });
    await h.rebalancer.tick();
    expect(h.requested).toHaveLength(0);
  });
});
