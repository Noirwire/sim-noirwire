import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server, createServer } from "node:http";
import { join } from "node:path";
import {
  Instructions,
  ROLE,
  clockOf,
  decodePriceFeed,
  receipt,
  sendAndConfirm,
} from "@noirwire/orderbook";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareRequest, submitRequest } from "../../scripts/fund-client.js";
import { type RunningApp, startApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/config.js";
import { NVDAX_MINT, SOL_MINT } from "../../src/prices/mints.js";
import { questWeekOf } from "../../src/quests/quest-week.js";
import { deviceConsentText, questOrdersText } from "../../src/quests/signed-text.js";
import { base58Of } from "../../src/rollup/base58.js";
import { connectionTo } from "../../src/rollup/connections.js";
import { newOrderSecret, Program, type ProgramTrader } from "../../src/rollup/program.js";
import type { ChainFill } from "../../src/rollup/chain-types.js";
import { dollars } from "../helpers.js";
import { type Signer, newSigner } from "../quest-helpers.js";
import { FixedPriceSource } from "./fixed-price-source.js";

const LOCALNET = process.env.ORDERBOOK_LOCALNET;
if (!LOCALNET) throw new Error("Run this suite with `make test-rollup`.");

const ROLLUP_RPC_URL = "http://127.0.0.1:6699";
const ROLLUP_WS_URL = "ws://127.0.0.1:6700";
const PERP = "NSOL-PERP";
const PERP_ID = 0;
const REAL_SOL_PRICE = 139;
const TICK = 100n;
const SMALL_LOTS = 40n;
const BIG_LOTS = 100n;
const LATE_WAIT_MS = 65_000;
const DAY_MS = 86_400_000;
const API_KEY = "test-quests-key";
const QUEST_IDS = { getStarted: "quest-start", threeDays: "quest-days", streak: "quest-streak" };
const GENERIC_ERROR = "the request is not valid";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const localFile = (name: string): string => readFileSync(join(LOCALNET, name), "utf8");
const deployment = JSON.parse(localFile("deployment.json")) as { programId: string };
const program = new Program(deployment.programId);
const chain = connectionTo(ROLLUP_RPC_URL, ROLLUP_WS_URL);
const prices = new FixedPriceSource();

const DATA_DIR = join("data-test", `quests-${Date.now()}`);
const QUESTS_DIR = join(DATA_DIR, "quests");
const botSeeds = Array.from({ length: 16 }, () => randomBytes(32).toString("hex")).join(",");

interface Push {
  method: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

const pushes: Push[] = [];
let standIn: Server;
let running: RunningApp;
let base: string;

const startStandIn = (): Promise<string> =>
  new Promise((resolve) => {
    standIn = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const headers: IncomingHttpHeaders = request.headers;
        pushes.push({
          method: request.method,
          authorization: headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
        response.writeHead(200).end();
      });
    });
    standIn.listen(0, "127.0.0.1", () => {
      const address = standIn.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/push`);
    });
  });

const post = async (path: string, payload: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const getJson = async (path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const eventually = async <T>(
  what: string,
  read: () => Promise<T | null | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await pause(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const pushPrices = (): void => {
  prices.push({ id: SOL_MINT, price: dollars(REAL_SOL_PRICE), atMs: Date.now() });
  prices.push({ id: NVDAX_MINT, price: dollars(181), atMs: Date.now() });
};

interface StoredCredit {
  wallet: string;
  market: string;
  sequence: number;
  utcDay: number;
  week: number;
  notionalAtoms: string;
  order: string;
}

const storedCredits = (): StoredCredit[] => {
  try {
    const file = JSON.parse(readFileSync(join(QUESTS_DIR, "credits.json"), "utf8")) as {
      credits: StoredCredit[];
    };
    return file.credits;
  } catch {
    return [];
  }
};

const creditsOf = (wallet: string): StoredCredit[] =>
  storedCredits().filter((credit) => credit.wallet === wallet);

const hex = (secret: Uint8Array): string => Buffer.from(secret).toString("hex");
const sha256Hex = (secret: Uint8Array): string => createHash("sha256").update(secret).digest("hex");

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  Buffer.from(left).equals(Buffer.from(right));

const walletSigner = (owner: Keypair): Signer => {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(owner.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return {
    key: owner.publicKey.toBase58(),
    sign: (text) => base58Of(sign(null, Buffer.from(text, "utf8"), key)),
  };
};

interface User {
  owner: Keypair;
  wallet: Signer;
  device: Signer;
  trader?: ProgramTrader;
}

const newUser = (): User => {
  const owner = Keypair.generate();
  return { owner, wallet: walletSigner(owner), device: newSigner() };
};

const openAndFund = async (user: User): Promise<void> => {
  const prepared = await post("/v1/fund/prepare", prepareRequest(user.owner));
  expect(prepared.status).toBe(200);
  const funded = await post(
    "/v1/fund/submit",
    submitRequest(user.owner, prepared.body.transaction as string),
  );
  expect(funded.status).toBe(200);
  user.trader = await program.newTrader(ROLLUP_RPC_URL, user.owner);
  expect(await user.trader.sync(PERP_ID)).toBe(true);
};

const registerDevice = async (user: User) => {
  const challenge = await post("/v1/quests/challenge", { wallet: user.wallet.key });
  expect(challenge.status).toBe(200);
  const consent = {
    wallet: user.wallet.key,
    deviceKey: user.device.key,
    until: new Date(Date.now() + DAY_MS).toISOString(),
    challenge: challenge.body.challenge as string,
  };
  return post("/v1/quests/device", {
    ...consent,
    signature: user.wallet.sign(deviceConsentText(consent)),
  });
};

const ordersBody = (signer: Signer, claimedKey: string, secrets: Uint8Array[]) => {
  const batch = {
    deviceKey: claimedKey,
    signedAt: Date.now(),
    orders: secrets.map((secret) => ({ market: PERP, secret: hex(secret) })),
  };
  return { ...batch, signature: signer.sign(questOrdersText(batch)) };
};

const registerOrders = (user: User, secrets: Uint8Array[]) =>
  post("/v1/quests/orders", ordersBody(user.device, user.device.key, secrets));

const trader = (user: User): ProgramTrader => user.trader!;

const markPrice = async (): Promise<bigint> => (await program.price(chain, PERP_ID)).price;

const takeFromMaker = async (user: User, lots: bigint): Promise<Uint8Array> => {
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const secret = newOrderSecret();
    const mark = await markPrice();
    const placed = await trader(user).place(PERP_ID, {
      side: "buy",
      type: "market",
      price: mark + 1_500n,
      size: lots,
      reduceOnly: false,
      secret,
    });
    if (placed.status === "filled") return secret;
    outcomes.push(placed.status);
    await pause(1_000);
  }
  throw new Error(`the house maker never filled a market buy: ${outcomes.join(", ")}`);
};

const fillWhere = async (
  matches: (fill: ChainFill) => boolean,
  timeoutMs = 30_000,
): Promise<ChainFill> =>
  eventually(
    "the order's fill on the chain tape",
    async () => {
      const { fills } = await program.tape(chain, PERP_ID);
      return fills.find(matches);
    },
    timeoutMs,
  );

const takerFillOf = (secret: Uint8Array) =>
  fillWhere((fill) => sameBytes(fill.takerReceipt, receipt(secret, fill.sequence, ROLE.taker)));

const servedByTheService = (sequence: bigint) =>
  eventually(`the service to serve fill ${sequence}`, async () => {
    const { fills } = (await getJson(`/v1/tape?market=${PERP}&limit=500`)).body;
    return (fills as { sequence: number }[]).some((fill) => fill.sequence === Number(sequence));
  });

const creditFor = (wallet: string, sequence: bigint): StoredCredit | undefined =>
  creditsOf(wallet).find((credit) => credit.sequence === Number(sequence));

const users = { a: newUser(), b: newUser(), c: newUser() };

const seedEarlierDays = (wallet: string): void => {
  const today = Math.floor(Date.now() / DAY_MS);
  const week = questWeekOf(Date.now());
  const credits = [1, 2].map((daysAgo) => ({
    wallet,
    market: PERP,
    sequence: 1_000_000 + daysAgo,
    utcDay: today - daysAgo,
    week,
    notionalAtoms: "20000000",
    order: `earlier-day-${daysAgo}`,
  }));
  mkdirSync(QUESTS_DIR, { recursive: true });
  writeFileSync(join(QUESTS_DIR, "credits.json"), JSON.stringify({ credits }));
};

const PUBLISH_EVERY_MS = 1_000;
const ROLLUP_PORT_URL = "http://127.0.0.1:7799";
const PERP_MARKET_IDS = [0, 1];
let publishing: ReturnType<typeof setInterval> | null = null;
let publishingNow = false;

const startPricePublisher = async (): Promise<void> => {
  const oracle = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(localFile("localnet-oracle.json")) as number[]),
  );
  const connection = new Connection(ROLLUP_PORT_URL, "confirmed");
  const instructions = new Instructions(new PublicKey(deployment.programId));
  const publishOnce = async (): Promise<void> => {
    const time = BigInt(await clockOf(connection));
    for (const marketId of PERP_MARKET_IDS) {
      const account = await connection.getAccountInfo(instructions.addresses.priceFeed(marketId));
      if (!account) throw new Error(`market ${marketId} has no price feed`);
      const feed = decodePriceFeed(account.data);
      if (feed.publishTime >= time || feed.acceptedAt >= time) continue;
      await sendAndConfirm(
        connection,
        [instructions.publishPrice(oracle.publicKey, marketId, feed.price, time)],
        oracle,
      );
    }
  };
  await publishOnce();
  publishing = setInterval(() => {
    if (publishingNow) return;
    publishingNow = true;
    publishOnce()
      .catch((error: unknown) => {
        process.stderr.write(`price publish failed: ${String(error).slice(0, 120)}\n`);
      })
      .finally(() => {
        publishingNow = false;
      });
  }, PUBLISH_EVERY_MS);
};

const perpOnlyDeployment = (): string => {
  const whole = JSON.parse(localFile("deployment.json")) as { markets: { kind: string }[] };
  const path = join(DATA_DIR, "deployment-perps.json");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ ...whole, markets: whole.markets.filter((market) => market.kind === "perp") }),
  );
  return path;
};

beforeAll(async () => {
  await startPricePublisher();
  const pushUrl = await startStandIn();
  seedEarlierDays(users.c.wallet.key);
  const config = loadConfig({
    VENUE: "rollup",
    HOST: "127.0.0.1",
    NETWORK: "localnet",
    DATA_DIR,
    SOLANA_RPC_URL: "http://127.0.0.1:8899",
    ROLLUP_RPC_URL,
    ROLLUP_WS_URL,
    DEPLOYMENT_PATH: perpOnlyDeployment(),
    GATE_SECRET_KEY: localFile("localnet-gate.json"),
    FAUCET_SECRET_KEY: localFile("localnet-faucet.json"),
    BOT_TRADER_SEEDS: botSeeds,
    SERVICE_LOCATION: "the test machine",
    PUBLIC_ROLLUP_RPC_URL: "https://rollup.browser.example",
    NOISE_TAKERS_ENABLED: "0",
    MAGICBLOCK_QUESTS_API_KEY: API_KEY,
    MAGICBLOCK_QUESTS_URL: pushUrl,
    QUEST_GET_STARTED_ID: QUEST_IDS.getStarted,
    QUEST_THREE_DAYS_ID: QUEST_IDS.threeDays,
    QUEST_STREAK_ID: QUEST_IDS.streak,
  } as NodeJS.ProcessEnv);
  running = await startApp({ ...config, PORT: 0 }, { priceSource: prices });
  base = `http://127.0.0.1:${running.port}`;
  pushPrices();
  await eventually("the service to report healthy", async () => {
    pushPrices();
    const { markets } = (await getJson("/v1/markets")).body as {
      markets: { id: string; warmingUp: boolean }[];
    };
    const perp = markets.find((market) => market.id === PERP);
    return perp?.warmingUp === false && (await getJson("/v1/health")).status === 200;
  });
});

afterAll(async () => {
  if (publishing) clearInterval(publishing);
  for (const user of Object.values(users)) user.trader?.close();
  await running?.close();
  await new Promise<void>((resolve) => standIn?.close(() => resolve()));
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("quest points on the real program (local network)", () => {
  it("opens and funds two traders and switches a device on for each", async () => {
    await openAndFund(users.a);
    await openAndFund(users.b);
    expect((await registerDevice(users.a)).status).toBe(200);
    expect((await registerDevice(users.b)).status).toBe(200);
  });

  it("counts a taker fill against the house maker once the order is registered in time", async () => {
    const secret = await takeFromMaker(users.a, SMALL_LOTS);
    const registered = await registerOrders(users.a, [secret]);
    expect(registered.status).toBe(200);
    expect(registered.body.accepted).toBe(1);

    const fill = await takerFillOf(secret);
    const credit = await eventually("a credit for the taker", async () =>
      creditFor(users.a.wallet.key, fill.sequence),
    );
    expect(credit.market).toBe(PERP);
    expect(credit.order).toBe(sha256Hex(secret));
    expect(BigInt(credit.notionalAtoms)).toBeGreaterThan(0n);
    expect(creditsOf(users.b.wallet.key)).toHaveLength(0);
  });

  it("does not count a fill between two users, whichever of them rests", async () => {
    let selfTrade: { sequence: bigint; secrets: Uint8Array[] } | null = null;
    for (let attempt = 0; attempt < 5 && !selfTrade; attempt += 1) {
      const resting = newOrderSecret();
      const taking = newOrderSecret();
      const mark = await markPrice();
      const bid = (mark / TICK) * TICK - TICK;
      const rested = await trader(users.a).place(PERP_ID, {
        side: "buy",
        type: "limit",
        price: bid,
        size: SMALL_LOTS,
        reduceOnly: false,
        secret: resting,
      });
      if (rested.status !== "rested") continue;
      const sold = await trader(users.b).place(PERP_ID, {
        side: "sell",
        type: "market",
        price: bid - 1_500n,
        size: SMALL_LOTS,
        reduceOnly: false,
        secret: taking,
      });
      expect(sold.status).toBe("filled");
      await trader(users.a).cancelAll(PERP_ID);
      expect((await registerOrders(users.a, [resting])).status).toBe(200);
      expect((await registerOrders(users.b, [taking])).status).toBe(200);
      const between = await eventually("the fill between the two users", async () => {
        const { fills } = await program.tape(chain, PERP_ID);
        return fills.find(
          (fill) =>
            sameBytes(fill.makerReceipt, receipt(resting, fill.sequence, ROLE.maker)) &&
            sameBytes(fill.takerReceipt, receipt(taking, fill.sequence, ROLE.taker)),
        );
      }).catch(() => null);
      if (between) selfTrade = { sequence: between.sequence, secrets: [resting, taking] };
    }
    expect(selfTrade).not.toBeNull();
    const { sequence } = selfTrade!;

    await servedByTheService(sequence);
    await pause(3_000);
    expect(creditFor(users.a.wallet.key, sequence)).toBeUndefined();
    expect(creditFor(users.b.wallet.key, sequence)).toBeUndefined();
  });

  it(
    "does not count an order registered more than a minute after its fill",
    async () => {
      const secret = await takeFromMaker(users.a, SMALL_LOTS);
      const fill = await takerFillOf(secret);
      await servedByTheService(fill.sequence);
      await pause(fill.timeSeconds * 1_000 + LATE_WAIT_MS - Date.now());

      const registered = await registerOrders(users.a, [secret]);
      expect(registered.status).toBe(200);
      await pause(3_000);
      expect(creditFor(users.a.wallet.key, fill.sequence)).toBeUndefined();
    },
    LATE_WAIT_MS + 120_000,
  );

  it("refuses an orders call signed by the wrong key with the generic answer", async () => {
    const secret = newOrderSecret();
    const forged = await post(
      "/v1/quests/orders",
      ordersBody(users.b.device, users.a.device.key, [secret]),
    );
    expect(forged.status).toBe(401);
    expect(forged.body).toEqual({ error: GENERIC_ERROR });
  });

  it("has pushed nothing: no seat record is kept here and the weekly quests need three days", async () => {
    await pause(2_000);
    expect(pushes).toHaveLength(0);
  });

  it("pushes the three days quest once, with the key, when a third trading day is credited", async () => {
    await openAndFund(users.c);
    expect((await registerDevice(users.c)).status).toBe(200);
    const secret = await takeFromMaker(users.c, BIG_LOTS);
    expect((await registerOrders(users.c, [secret])).status).toBe(200);

    const fill = await takerFillOf(secret);
    const credit = await eventually("a credit for the third day", async () =>
      creditFor(users.c.wallet.key, fill.sequence),
    );
    expect(BigInt(credit.notionalAtoms)).toBeGreaterThanOrEqual(10_000_000n);

    await eventually("the push to reach the stand-in", async () => pushes.length > 0);
    await pause(2_000);
    expect(pushes).toHaveLength(1);
    const [pushed] = pushes;
    expect(pushed!.method).toBe("POST");
    expect(pushed!.authorization).toBe(`Bearer ${API_KEY}`);
    expect(pushed!.body).toMatchObject({
      payload: { quest: QUEST_IDS.threeDays, user: users.c.wallet.key },
    });
    const { payload } = pushed!.body as { payload: { timestamp: number } };
    expect(Math.abs(Date.now() - payload.timestamp)).toBeLessThan(120_000);
  });
});
