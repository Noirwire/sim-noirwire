import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningApp, startApp } from "../src/app.js";
import { loadConfig } from "../src/config/config.js";
import { MARKETS } from "../src/engine/markets.js";
import type { PriceSource } from "../src/prices/price-source.js";

const NGINX_403 =
  "<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>";

const BOT_COUNT = 10;
const DATA_DIR = join("data-test", `refused-${Date.now()}`);

/** A price source that never fetches anything. */
const quietPrices: PriceSource = {
  start: () => {},
  stop: () => {},
  setPace: () => {},
  pollNow: async () => false,
};

let refusing: Server;
let requests = 0;
let running: RunningApp | null = null;

beforeEach(async () => {
  requests = 0;
  refusing = createServer((_request, response) => {
    requests += 1;
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

const keyOf = (keypair: Keypair): string => JSON.stringify([...keypair.secretKey]);

const configRefusedBy = (port: number) => {
  const [oracle, gate, faucet] = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const deployment = {
    network: "devnet",
    programId: Keypair.generate().publicKey.toBase58(),
    oracle: oracle.publicKey.toBase58(),
    gate: gate.publicKey.toBase58(),
    faucet: faucet.publicKey.toBase58(),
    depositUrl: `http://127.0.0.1:${port}`,
    tokens: [],
    markets: MARKETS.map((market, id) => ({
      id,
      symbol: market.id,
      kind: market.kind,
      baseDecimals: 9,
    })),
  };
  return {
    ...loadConfig({
      VENUE: "rollup",
      HOST: "127.0.0.1",
      DATA_DIR,
      SOLANA_RPC_URL: `http://127.0.0.1:${port}`,
      ROLLUP_RPC_URL: `http://127.0.0.1:${port}`,
      ROLLUP_WS_URL: `ws://127.0.0.1:${port}`,
      DEPLOYMENT_JSON: JSON.stringify(deployment),
      ORACLE_SECRET_KEY: keyOf(oracle),
      GATE_SECRET_KEY: keyOf(gate),
      FAUCET_SECRET_KEY: keyOf(faucet),
      BOT_TRADER_SEEDS: Array.from({ length: BOT_COUNT }, () =>
        randomBytes(32).toString("hex"),
      ).join(","),
    } as NodeJS.ProcessEnv),
    PORT: 0,
  };
};

const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${running?.port}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

describe("a rollup that refuses the service at start-up", () => {
  it("still starts the API, answers health 503 with the reason, serves what needs no rollup and does not hammer", async () => {
    const address = refusing.address() as AddressInfo;

    running = await startApp(configRefusedBy(address.port), { priceSource: quietPrices });

    const health = await get("/v1/health");
    expect(health.status).toBe(503);
    expect(health.body.ok).toBe(false);
    expect(health.body.awake).toBe(false);
    expect(health.body.reason).toBeTypeOf("string");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await get("/v1/health");
    expect(String(refused.body.reason)).toContain("403");

    expect((await get("/v1/markets")).status).toBe(503);
    expect((await get("/v1/deployment")).status).toBe(503);
    expect((await get("/v1/stats")).status).toBe(200);
    expect((await get("/v1/tape?market=NSOL-PERP")).status).toBe(200);

    // The first try is refused; the next waits 5 s. Asking the API for things meanwhile sends nothing.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(requests).toBe(1);

    const stillPending = await Promise.race([
      running.botsStarted.then(() => "done"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(stillPending).toBe("pending");
  });
});
