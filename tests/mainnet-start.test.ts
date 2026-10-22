import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import { hideAddresses, firstLine } from "../src/logging/first-line.js";
import { NetworkMismatch, requireNetwork } from "../src/rollup/connections.js";
import { MAINNET_USDC_MINT, requireMainnetDeployment } from "../src/rollup/mainnet-deployment.js";
import { browserUrlsFor } from "../src/rollup/public-deployment.js";
import { type Deployment, loadRollupSettings } from "../src/rollup/settings.js";
import type { PriceSource } from "../src/prices/price-source.js";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DIR = join("data-test", `mainnet-${Date.now()}`);

const keyOf = (keypair: Keypair): string => JSON.stringify([...keypair.secretKey]);

/** A Solana RPC that answers every call with one genesis hash. */
let rpc: Server;
let genesis = DEVNET_GENESIS;
let rpcUrl = "";

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  rpc = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id } = JSON.parse(body || "{}") as { id?: number };
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id, result: genesis }));
    });
  });
  await new Promise<void>((resolve) => rpc.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => rpc.close(() => resolve()));
  rmSync(DIR, { recursive: true, force: true });
});

describe("the check that Solana is the network the service was told to run on", () => {
  it("lets NETWORK=mainnet run on mainnet, and stops it anywhere else", async () => {
    genesis = MAINNET_GENESIS;
    await expect(requireNetwork(true, rpcUrl)).resolves.toBeUndefined();

    genesis = DEVNET_GENESIS;
    const error = await requireNetwork(true, rpcUrl).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkMismatch);
    expect((error as Error).message).toContain("NETWORK=mainnet, but SOLANA_RPC_URL is not");
    expect((error as Error).message).toContain(DEVNET_GENESIS);
  });

  it("still keeps any other NETWORK off mainnet, and says how to run there", async () => {
    genesis = DEVNET_GENESIS;
    await expect(requireNetwork(false, rpcUrl)).resolves.toBeUndefined();

    genesis = MAINNET_GENESIS;
    const error = await requireNetwork(false, rpcUrl).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NetworkMismatch);
    expect((error as Error).message).toContain("Set NETWORK=mainnet");
  });
});

const description = (over: Partial<Deployment> = {}): Deployment => ({
  network: "mainnet",
  programId: Keypair.generate().publicKey.toBase58(),
  gate: Keypair.generate().publicKey.toBase58(),
  depositUrl: "https://rollup.example",
  tokens: [{ index: 0, symbol: "USDC", decimals: 6, mint: MAINNET_USDC_MINT, custodyNonce: "3" }],
  markets: [{ id: 0, symbol: "SOL-PERP", kind: "perp", baseDecimals: 9 }],
  ...over,
});

describe("the deployment description on mainnet", () => {
  it("takes a mainnet description with the real USDC and no faucet", () => {
    expect(() => requireMainnetDeployment(description())).not.toThrow();
  });

  it("refuses another network's description, a faucet and a test mint, naming each", () => {
    let message = "";
    try {
      requireMainnetDeployment(
        description({
          network: "devnet",
          faucet: Keypair.generate().publicKey.toBase58(),
          tokens: [
            {
              index: 0,
              symbol: "USDC",
              decimals: 6,
              mint: Keypair.generate().publicKey.toBase58(),
              custodyNonce: "3",
            },
          ],
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('for the network "devnet", not mainnet');
    expect(message).toContain("names a faucet");
    expect(message).toContain("not the real USDC mint");
  });

  it("refuses a description with no quote token at all", () => {
    expect(() => requireMainnetDeployment(description({ tokens: [] }))).toThrow("real USDC mint");
  });
});

describe("the addresses a browser is told", () => {
  const own = {
    solanaRpcUrl: "https://private.example/?api-key=SECRETKEY1",
    rollupRpcUrl: "https://private-rollup.example/SECRETKEY1",
    rollupWsUrl: "wss://private-rollup.example/SECRETKEY1",
  };

  it("are the public ones on mainnet", () => {
    const urls = browserUrlsFor(
      {
        NETWORK: "mainnet",
        PUBLIC_SOLANA_RPC_URL: "https://public.example",
        PUBLIC_ROLLUP_RPC_URL: "https://public-rollup.example",
        PUBLIC_ROLLUP_WS_URL: "wss://public-rollup.example",
      },
      own,
    );

    expect(urls).toEqual({
      solanaRpcUrl: "https://public.example",
      rollupRpcUrl: "https://public-rollup.example",
      rollupWsUrl: "wss://public-rollup.example",
    });
  });

  it("never fall back to the private ones on mainnet: a missing one is an error", () => {
    expect(() => browserUrlsFor({ NETWORK: "mainnet" }, own)).toThrow(
      "PUBLIC_SOLANA_RPC_URL is not set",
    );
  });

  it("fall back to the service's own off mainnet, as before", () => {
    expect(browserUrlsFor({ NETWORK: "devnet" }, own)).toEqual(own);
  });
});

describe("an error that quotes a private address", () => {
  afterEach(() => hideAddresses([]));

  it("is logged and served with the address, and any key in it, left out", () => {
    hideAddresses([
      "https://solana.example/?api-key=SECRETKEY1",
      "wss://rollup.example/SECRETKEY2",
    ]);

    const line = firstLine(
      new Error("fetch failed: https://solana.example/?api-key=SECRETKEY1 (api-key=SECRETKEY1 )"),
    );
    expect(line).not.toContain("SECRETKEY1");
    expect(line).toContain("[private address]");

    const ws = firstLine(new Error("connect wss://rollup.example/SECRETKEY2 refused\nsecond line"));
    expect(ws).toBe("connect [private address] refused");
  });

  it("is left as it is when nothing is hidden, as on devnet", () => {
    expect(firstLine(new Error("fetch failed: https://devnet.example/?api-key=abc"))).toContain(
      "api-key=abc",
    );
  });
});

describe("the maker seeds from a mounted file", () => {
  const seeds = [`${"11".repeat(32)}`, `${"22".repeat(32)}`];
  const settingsFrom = (path: string, bots = 2) => {
    const gate = Keypair.generate();
    const deployment = description({ gate: gate.publicKey.toBase58() });
    return loadRollupSettings(
      {
        SOLANA_RPC_URL: "http://127.0.0.1:8899",
        ROLLUP_RPC_URL: "http://127.0.0.1:6699",
        ROLLUP_WS_URL: "ws://127.0.0.1:6700",
        GATE_SECRET_KEY: keyOf(gate),
        BOT_TRADER_SEEDS_FILE: path,
      } as never,
      deployment,
      bots,
    );
  };

  it("reads the seeds from the file, one per line or comma separated", () => {
    const lines = join(DIR, "seeds-lines");
    writeFileSync(lines, `${seeds.join("\n")}\n`);
    const commas = join(DIR, "seeds-commas");
    writeFileSync(commas, seeds.join(","));

    expect(settingsFrom(lines).botOwners).toHaveLength(2);
    expect(settingsFrom(commas).botOwners.map((owner) => owner.publicKey.toBase58())).toEqual(
      settingsFrom(lines).botOwners.map((owner) => owner.publicKey.toBase58()),
    );
  });

  it("says a file it cannot read is the problem, without echoing a seed", () => {
    const bad = join(DIR, "seeds-bad");
    writeFileSync(bad, "not hex");

    expect(() => settingsFrom(join(DIR, "no-such-file"))).toThrow("BOT_TRADER_SEEDS_FILE must be");
    expect(() => settingsFrom(bad)).toThrow("BOT_TRADER_SEEDS must be 32-byte seeds in hex");
  });
});

describe("the service started on mainnet", () => {
  let running: RunningApp | null = null;
  afterEach(async () => {
    await running?.close();
    running = null;
  });

  const quietPrices: PriceSource = {
    start: () => {},
    stop: () => {},
    setPace: () => {},
    pollNow: async () => false,
  };

  const files = (name: string) => {
    const dir = join(DIR, name);
    mkdirSync(dir, { recursive: true });
    const gate = Keypair.generate();
    const deploymentPath = join(dir, "deployment.json");
    writeFileSync(
      deploymentPath,
      JSON.stringify(description({ gate: gate.publicKey.toBase58(), depositUrl: rpcUrl })),
    );
    const gatePath = join(dir, "gate.json");
    writeFileSync(gatePath, keyOf(gate));
    const seedsPath = join(dir, "seeds");
    writeFileSync(seedsPath, "33".repeat(32));
    return { dir, deploymentPath, gatePath, seedsPath };
  };

  const configFor = (name: string) => {
    const { dir, deploymentPath, gatePath, seedsPath } = files(name);
    return {
      ...loadConfig({
        NETWORK: "mainnet",
        VENUE: "rollup",
        HOST: "127.0.0.1",
        TRUSTED_PROXY_HOPS: "0",
        DATA_DIR: join(dir, "data"),
        SOLANA_RPC_URL: `${rpcUrl}/?api-key=SECRETKEY1`,
        ROLLUP_RPC_URL: rpcUrl,
        ROLLUP_WS_URL: rpcUrl.replace("http", "ws"),
        PUBLIC_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
        PUBLIC_ROLLUP_RPC_URL: "https://rollup-public.example",
        PUBLIC_ROLLUP_WS_URL: "wss://rollup-public.example",
        DEPLOYMENT_PATH: deploymentPath,
        GATE_SECRET_KEY_FILE: gatePath,
        BOT_TRADER_SEEDS_FILE: seedsPath,
      } as NodeJS.ProcessEnv),
      PORT: 0,
    };
  };

  it("ends its start-up for good when Solana is not mainnet, instead of retrying", async () => {
    genesis = DEVNET_GENESIS;
    running = await startApp(configFor("wrong-chain"), { priceSource: quietPrices });

    await expect(running.botsStarted).rejects.toBeInstanceOf(NetworkMismatch);
  });

  it("is held awake and reports its network on the health probe, but serves no fund route", async () => {
    genesis = DEVNET_GENESIS;
    running = await startApp(configFor("awake"), { priceSource: quietPrices });
    running.botsStarted.catch(() => {});

    const health = await fetch(`http://127.0.0.1:${running.port}/v1/health`);
    const body = (await health.json()) as Record<string, unknown>;
    const fund = await fetch(`http://127.0.0.1:${running.port}/v1/fund/prepare`, {
      method: "POST",
    });

    expect(body.network).toBe("mainnet");
    expect(body.awake).toBe(true);
    expect(fund.status).toBe(404);
  });

  it("refuses a snapshot left by another network in its data folder", async () => {
    const config = configFor("old-snapshot");
    mkdirSync(config.DATA_DIR, { recursive: true });
    writeFileSync(
      join(config.DATA_DIR, "snapshot.json"),
      JSON.stringify({ savedAtMs: 1, network: "devnet", candles: [], fundedAddresses: [] }),
    );

    await expect(startApp(config, { priceSource: quietPrices })).rejects.toThrow(
      "Point DATA_DIR at an empty folder",
    );
  });
});
