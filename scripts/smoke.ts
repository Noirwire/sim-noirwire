/**
 * A short check of a running service with VENUE=rollup, over its published
 * port only: every market has a price, the tape moves within a minute, and
 * the two-step fund flow opens and funds a fresh key once and only once.
 *
 *   npx tsx scripts/smoke.ts --url http://127.0.0.1:4100
 */
import { Keypair } from "@solana/web3.js";
import { prepareRequest, submitRequest } from "./fund-client.js";
import { flag } from "./report.js";

const base = flag("--url", "http://127.0.0.1:4100");
const TAPE_MOVES_WITHIN_MS = 60_000;
const TAPE_POLL_MS = 1_000;

interface Market {
  id: string;
  markPrice: string | null;
}

const call = async (path: string, payload?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const check = (what: string, passed: boolean): void => {
  console.log(`${passed ? "ok  " : "FAIL"} ${what}`);
  if (!passed) process.exit(1);
};

const newestSequence = async (market: string): Promise<number> => {
  const fills = (await call(`/v1/tape?market=${market}&limit=1`)).body.fills as {
    sequence: number;
  }[];
  return fills[0]?.sequence ?? 0;
};

/** The first market whose tape gains a fill, or null when none does in time. */
const marketWhoseTapeMoves = async (markets: Market[]): Promise<string | null> => {
  const before = new Map<string, number>();
  for (const market of markets) before.set(market.id, await newestSequence(market.id));
  const deadline = Date.now() + TAPE_MOVES_WITHIN_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, TAPE_POLL_MS));
    for (const { id } of markets) {
      if ((await newestSequence(id)) > (before.get(id) ?? 0)) return id;
    }
  }
  return null;
};

const main = async (): Promise<void> => {
  const health = await call("/v1/health");
  check(`health is ready: ${JSON.stringify(health.body)}`, health.status === 200);

  const markets = (await call("/v1/markets")).body.markets as Market[];
  check(
    `every market has a price: ${markets.map((m) => `${m.id} ${m.markPrice}`).join(", ")}`,
    markets.length > 0 && markets.every((market) => Number(market.markPrice) > 0),
  );

  const moved = await marketWhoseTapeMoves(markets);
  check(`the tape moved within 60 seconds${moved ? ` (${moved})` : ""}`, moved !== null);

  const owner = Keypair.generate();
  const prepared = await call("/v1/fund/prepare", prepareRequest(owner));
  check("a fresh key is offered its open-and-fund transaction", prepared.status === 200);
  const funded = await call(
    "/v1/fund/submit",
    submitRequest(owner, prepared.body.transaction as string),
  );
  check(
    `the signed transaction is accepted: ${JSON.stringify(funded.body)}`,
    funded.status === 200,
  );
  check(
    "the same key is refused a second grant",
    (await call("/v1/fund/prepare", prepareRequest(owner))).status === 409,
  );
  console.log("Smoke check passed.");
};

void main();
