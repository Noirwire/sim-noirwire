import { rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../src/app.js";
import { type Config, loadConfig } from "../src/config/config.js";
import { type SimRole, roleProblems } from "../src/config/role.js";
import type { PriceSource } from "../src/prices/price-source.js";
import { loadDeployment, loadRollupSettings } from "../src/rollup/settings.js";
import { openBots } from "../src/wiring/bots.js";
import { rollupWiring } from "../src/wiring/rollup-wiring.js";

const keyOf = (keypair: Keypair): string => JSON.stringify([...keypair.secretKey]);
const gate = Keypair.generate();
const SEED = "ab".repeat(32);
const DATA_DIR = join("data-test", `entry-points-${Date.now()}`);

const deploymentFor = () =>
  JSON.stringify({
    network: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    gate: gate.publicKey.toBase58(),
    depositUrl: "http://127.0.0.1:6699",
    tokens: [
      {
        index: 0,
        symbol: "USDC",
        decimals: 6,
        mint: Keypair.generate().publicKey.toBase58(),
        custodyNonce: "3",
      },
    ],
    markets: [{ id: 0, symbol: "SOL-PERP", kind: "perp", baseDecimals: 9 }],
  });

/** What every role is given: where the chain is. Credentials are each role's own. */
const shared = (url = "http://127.0.0.1:6699"): NodeJS.ProcessEnv => ({
  VENUE: "rollup",
  HOST: "127.0.0.1",
  DATA_DIR,
  SOLANA_RPC_URL: url,
  ROLLUP_RPC_URL: url,
  ROLLUP_WS_URL: url.replace("http", "ws"),
  DEPLOYMENT_JSON: deploymentFor(),
  NOISE_TAKERS_ENABLED: "0",
  LIQUIDATOR_ENABLED: "0",
});

const OWN_CREDENTIALS: Record<Exclude<SimRole, "combined">, NodeJS.ProcessEnv> = {
  maker: { BOT_TRADER_SEEDS: SEED },
  gate: { GATE_SECRET_KEY: keyOf(gate) },
  data: {},
};

const configFor = (role: Exclude<SimRole, "combined">, extra: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({ ...shared(), ...OWN_CREDENTIALS[role], ...extra }, role);

describe("each entry point loads only its own settings", () => {
  it.each(["maker", "gate", "data"] as const)(
    "starts the %s role with its own credentials and nothing else",
    (role) => {
      expect(configFor(role).SIM_ROLE).toBe(role);
    },
  );

  it("reads each role's keys and no other: the maker has no gate key, the gate no seeds, the data API no key", () => {
    const deployment = loadDeployment({ DEPLOYMENT_JSON: deploymentFor() } as Config);
    const settings = (role: Exclude<SimRole, "combined">, botCount: number) =>
      loadRollupSettings(
        configFor(role),
        { ...deployment, gate: gate.publicKey.toBase58() },
        botCount,
        role,
      );

    expect(settings("maker", 1)).toMatchObject({ gate: null, faucet: null });
    expect(settings("maker", 1).botOwners).toHaveLength(1);
    expect(settings("gate", 0).gate?.publicKey.toBase58()).toBe(gate.publicKey.toBase58());
    expect(settings("gate", 0).botOwners).toEqual([]);
    expect(settings("data", 0)).toMatchObject({ gate: null, faucet: null, botOwners: [] });
  });

  it.each([
    ["maker", { GATE_SECRET_KEY: keyOf(gate) }, "GATE_SECRET_KEY"],
    ["maker", { GATE_SECRET_KEY_FILE: "/run/secrets/gate" }, "GATE_SECRET_KEY_FILE"],
    ["gate", { BOT_TRADER_SEEDS: SEED }, "BOT_TRADER_SEEDS"],
    ["gate", { KEEPER_HEARTBEAT_FILE: "/run/keeper" }, "KEEPER_HEARTBEAT_FILE"],
    ["data", { GATE_SECRET_KEY: keyOf(gate) }, "GATE_SECRET_KEY"],
    ["data", { BOT_TRADER_SEEDS: SEED }, "BOT_TRADER_SEEDS"],
    ["data", { FAUCET_SECRET_KEY: keyOf(gate) }, "FAUCET_SECRET_KEY"],
  ] as const)(
    "refuses to start the %s role with a credential that is not its own (%s)",
    (role, extra, name) => {
      const attempt = () => configFor(role, extra);

      expect(attempt).toThrow(name);
      expect(attempt).toThrow(`SIM_ROLE=${role} cannot start`);
      expect(attempt).not.toThrow(/BEGIN|\[\d+,/);
    },
  );

  it("refuses an environment that names another role than the entry point's, and an in-memory venue", () => {
    expect(() => loadConfig({ ...shared(), SIM_ROLE: "gate" }, "maker")).toThrow(
      "runs the maker role, but SIM_ROLE=gate",
    );
    expect(roleProblems("data", { VENUE: "memory" })).toEqual([
      "SIM_ROLE=data needs VENUE=rollup: the in-memory venue cannot be split across processes.",
    ]);
  });

  it("leaves the combined service as it was: every credential allowed, no role in the health answer", () => {
    const combined = loadConfig({
      ...shared(),
      GATE_SECRET_KEY: keyOf(gate),
      BOT_TRADER_SEEDS: SEED,
      KEEPER_HEARTBEAT_FILE: "/run/keeper",
    });

    expect(combined.SIM_ROLE).toBe("combined");
  });

  it("asks a mainnet process only for the secrets files its role holds", () => {
    const mainnet: NodeJS.ProcessEnv = {
      ...shared("https://rpc.example"),
      NETWORK: "mainnet",
      PUBLIC_SOLANA_RPC_URL: "https://public.example",
      PUBLIC_ROLLUP_RPC_URL: "https://public-rollup.example",
      PUBLIC_ROLLUP_WS_URL: "wss://public-rollup.example",
      TRUSTED_PROXY_HOPS: "1",
      DEPLOYMENT_JSON: undefined,
      DEPLOYMENT_PATH: "/deployment/mainnet.json",
      NOISE_TAKERS_ENABLED: undefined,
      LIQUIDATOR_ENABLED: undefined,
    };
    const load = (role: Exclude<SimRole, "combined">, extra: NodeJS.ProcessEnv) =>
      loadConfig({ ...mainnet, ...extra }, role);

    expect(() => load("data", {})).not.toThrow();
    expect(() => load("maker", { BOT_TRADER_SEEDS_FILE: "/run/seeds" })).not.toThrow();
    expect(() =>
      load("gate", { GATE_SECRET_KEY_FILE: "/run/gate", GATE_INVITES_FILE: "/i" }),
    ).not.toThrow();
    expect(() => load("maker", {})).toThrow("BOT_TRADER_SEEDS_FILE is not set");
    expect(() => load("gate", { GATE_INVITES_FILE: "/i" })).toThrow(
      "GATE_SECRET_KEY_FILE is not set",
    );
    expect(() => load("data", { BOT_TRADER_SEEDS_FILE: "/run/seeds" })).toThrow(
      "BOT_TRADER_SEEDS_FILE",
    );
  });
});

describe("what each role wires", () => {
  const wire = (role: Exclude<SimRole, "combined">) =>
    rollupWiring({
      config: configFor(role),
      data: {} as never,
      snapshot: null,
      onError: () => {},
      onRecovered: () => {},
      onUnreachable: () => {},
    });

  it("gives the maker its bots and no desk, the gate a desk and no bots, and the data API neither", () => {
    const [maker, desk, data] = [wire("maker"), wire("gate"), wire("data")];

    expect(maker.botMarkets.map((market) => market.id)).toEqual(["NSOL-PERP"]);
    expect(maker.rollupRoutes.fundDesk).toBeUndefined();
    expect(desk.botMarkets).toEqual([]);
    expect(desk.rollupRoutes.fundDesk).toBeDefined();
    expect(data.botMarkets).toEqual([]);
    expect(data.rollupRoutes.fundDesk).toBeUndefined();
    expect(data.rollupRoutes.openDesk).toBeUndefined();
  });

  it("makes the data API's trading readiness independent of the maker: there is no maker to be unready", async () => {
    const problems = { onError: () => {}, onRecovered: () => {} };

    const bots = await openBots(configFor("data"), wire("data"), problems);

    expect(bots.trading()).toEqual({ ready: true });
    expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
  });
});

const NGINX_403 = "<html><body>403 Forbidden</body></html>";
const quietPrices: PriceSource = {
  start: () => {},
  stop: () => {},
  setPace: () => {},
  pollNow: async () => false,
};

describe("each role's own process, against a rollup that refuses it", () => {
  let refusing: Server;
  let running: RunningApp | null = null;

  beforeEach(async () => {
    refusing = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "text/html" }).end(NGINX_403);
    });
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    await running?.close();
    running = null;
    await new Promise<void>((resolve) => refusing.close(() => resolve()));
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const started = async (role: Exclude<SimRole, "combined">) => {
    const port = (refusing.address() as AddressInfo).port;
    const config = loadConfig(
      { ...shared(`http://127.0.0.1:${port}`), ...OWN_CREDENTIALS[role] },
      role,
    );
    running = await startApp({ ...config, PORT: 0 }, { priceSource: quietPrices });
    return (path: string) => fetch(`http://127.0.0.1:${running?.port}${path}`);
  };

  it("starts the maker alone, answering its own health and none of the market data", async () => {
    const get = await started("maker");

    const health = await get("/v1/health");
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, role: "maker" });
    expect((await get("/v1/stats")).status).toBe(404);
    expect((await get("/v1/markets")).status).toBe(404);
  });

  it("starts the data API alone, serving what needs no rollup and none of the desk", async () => {
    const get = await started("data");

    expect(await (await get("/v1/health")).json()).toMatchObject({ role: "data" });
    expect((await get("/v1/stats")).status).toBe(200);
    expect((await get("/v1/tape?market=NSOL-PERP")).status).toBe(200);
    expect((await get("/v1/fund/prepare")).status).toBe(404);
  });

  it("starts the gate alone, with its desk and none of the market data", async () => {
    const get = await started("gate");

    expect(await (await get("/v1/health")).json()).toMatchObject({ role: "gate" });
    expect((await get("/v1/stats")).status).toBe(404);
    expect((await get("/v1/tape?market=NSOL-PERP")).status).toBe(404);
  });
});
