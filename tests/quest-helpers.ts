import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE, receipt } from "@noirwire/orderbook";
import { vi } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { DAY_MS } from "../src/engine/day-window.js";
import type { Fill } from "../src/engine/types.js";
import { QuestService, type BotSides } from "../src/quests/quest-service.js";
import { WEEK_MS } from "../src/quests/quest-week.js";
import { deviceConsentText, questOrdersText } from "../src/quests/signed-text.js";
import { base58Of } from "../src/rollup/base58.js";

export const MARKET = "NSOL-PERP";
export const QUEST_IDS = { getStarted: "q-start", threeDays: "q-days", streak: "q-streak" };
/** The start of a quest week: a Friday, 08:00 UTC. */
export const WEEK_START_MS = Date.UTC(2026, 10, 13, 8);
export const HOUR_MS = 3_600_000;

export interface Signer {
  key: string;
  sign(text: string): string;
}

export const newSigner = (): Signer => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return {
    key: base58Of(raw),
    sign: (text) => base58Of(sign(null, Buffer.from(text, "utf8"), privateKey)),
  };
};

export const tempFolder = (): string => mkdtempSync(join(tmpdir(), "quests-"));

export interface PushCall {
  quest: string;
  user: string;
  timestamp: number;
}

export const fakePush = () => {
  const calls: PushCall[] = [];
  let status = 200;
  const fetchFake = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { payload: PushCall };
    calls.push(body.payload);
    return new Response(null, { status });
  });
  return {
    fetch: fetchFake as unknown as typeof fetch,
    calls,
    answerWith: (next: number) => {
      status = next;
    },
    pushesOf: (quest: string) => calls.filter((call) => call.quest === quest),
  };
};

export interface Rig {
  clock: ManualClock;
  push: ReturnType<typeof fakePush>;
  errors: string[];
  folder: string;
  seatOpen: { value: boolean };
  open(): QuestService;
}

export const rig = (folder = tempFolder(), startMs = WEEK_START_MS + DAY_MS): Rig => {
  const clock = new ManualClock(startMs);
  const push = fakePush();
  const errors: string[] = [];
  const seatOpen = { value: true };
  return {
    clock,
    push,
    errors,
    folder,
    seatOpen,
    open: () =>
      new QuestService({
        folder,
        clock,
        markets: [MARKET],
        questIds: QUEST_IDS,
        seatOpened: () => seatOpen.value,
        push: { url: "https://quests.test/push", apiKey: "test-key", fetch: push.fetch },
        onError: (what) => errors.push(what),
      }),
  };
};

export interface Person {
  wallet: Signer;
  device: Signer;
}

export const newPerson = (): Person => ({ wallet: newSigner(), device: newSigner() });

export const switchOn = async (service: QuestService, clock: ManualClock, person: Person) => {
  const { challenge } = service.issueChallenge(person.wallet.key);
  const request = {
    wallet: person.wallet.key,
    deviceKey: person.device.key,
    until: new Date(clock.nowMs() + DAY_MS).toISOString(),
    challenge,
  };
  return service.registerDevice({
    ...request,
    signature: person.wallet.sign(deviceConsentText(request)),
  });
};

export const newSecret = (): Uint8Array => randomBytes(16);
export const hex = (secret: Uint8Array): string => Buffer.from(secret).toString("hex");

export const handOver = (
  service: QuestService,
  clock: ManualClock,
  person: Person,
  secrets: Uint8Array[],
  market = MARKET,
) => {
  const batch = {
    deviceKey: person.device.key,
    signedAt: clock.nowMs(),
    orders: secrets.map((secret) => ({ market, secret: hex(secret) })),
  };
  return service.registerOrders({
    ...batch,
    signature: person.device.sign(questOrdersText(batch)),
  });
};

const tagOf = (secret: Uint8Array, sequence: number, role: number): bigint =>
  Buffer.from(receipt(secret, BigInt(sequence), role)).readBigUInt64BE(0);

let nextSequence = 1;
const BOT_TAG = 7n;
const PRICE = 100_000_000n;

export interface PrintedFill {
  fill: Fill;
  botSides: BotSides;
}

/** A fill worth `dollars` at $100 a unit, printed at `atMs`, in which `secret` traded against a bot. */
export const againstBot = (
  secret: Uint8Array,
  dollars: number,
  atMs: number,
  role: "maker" | "taker" = "taker",
  sequence = nextSequence++,
): PrintedFill => ({
  fill: {
    market: MARKET,
    price: PRICE,
    size: BigInt(Math.round(dollars * 10_000)),
    takerSide: "buy",
    takerTag: role === "taker" ? tagOf(secret, sequence, ROLE.taker) : BOT_TAG,
    makerTag: role === "maker" ? tagOf(secret, sequence, ROLE.maker) : BOT_TAG,
    timestampMs: atMs,
    sequence,
  },
  botSides: { maker: role === "taker", taker: role === "maker" },
});

/** A fill in which `maker` and `taker` traded against each other: no bot on either side. */
export const betweenTraders = (
  maker: Uint8Array,
  taker: Uint8Array,
  dollars: number,
  atMs: number,
): PrintedFill => {
  const { fill } = againstBot(maker, dollars, atMs);
  return {
    fill: {
      ...fill,
      makerTag: tagOf(maker, fill.sequence, ROLE.maker),
      takerTag: tagOf(taker, fill.sequence, ROLE.taker),
    },
    botSides: { maker: false, taker: false },
  };
};

export const weekStart = (week: number): number => WEEK_START_MS + week * WEEK_MS;

/** Registers a fresh secret for `person` at `atMs` and trades `dollars` against the bot with it. */
export const trade = async (
  rigged: Rig,
  service: QuestService,
  person: Person,
  dollars: number,
  atMs: number,
): Promise<Uint8Array> => {
  rigged.clock.set(atMs);
  const secret = newSecret();
  await switchOn(service, rigged.clock, person);
  await handOver(service, rigged.clock, person, [secret]);
  const { fill, botSides } = againstBot(secret, dollars, atMs);
  service.acceptFill(fill, botSides);
  return secret;
};
