import { z } from "zod";
import { MAKER_LIMITS } from "../bots/maker-limits.js";
import type { Clock } from "../engine/clock.js";
import { DECIMAL_TEXT, SCALE, absBigInt, fromDecimalString } from "../engine/money.js";

export interface PriceReading {
  source: string;
  /** A large exchange, as opposed to the oracle. */
  exchange: boolean;
  /** Dollars per SOL, scaled. */
  price: bigint;
  /** When the source says the price was set; the arrival time where it says nothing. */
  atMs: number;
}

export interface ReferenceSource {
  name: string;
  exchange: boolean;
  read(): Promise<PriceReading>;
}

export type Reference = { ok: true; price: bigint } | { ok: false; reason: string };

export type FetchJson = (url: string) => Promise<unknown>;

/** The data of Pyth's SOL/USD price account on Solana mainnet, or null when the account does not exist. */
export type ReadPythAccount = () => Promise<Uint8Array | null>;

const REQUEST_TIMEOUT_MS = 3_000;

const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
};

/** A source answered, but with something the maker must not use. The text goes into its pull reason. */
export class SourceRefused extends Error {}

/** The SOL/USD feed id of Pyth, as hex. The price account must carry this id. */
export const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const MS_PER_SECOND = 1_000;
const MAX_PYTH_EXPONENT = 18;

/**
 * A PriceUpdateV2 account of the Pyth receiver: an 8 byte discriminator, the
 * 32 byte write authority, the verification level (tag 0 is Partial and
 * followed by a signature count, tag 1 is Full), then the price message: the
 * 32 byte feed id, the price (i64), the confidence (u64), the exponent (i32)
 * and the publish time (i64), all little endian. Later fields are not read.
 */
const PYTH_AUTHORITY_END = 8 + 32;
const PYTH_FULL_TAG = 1;
const PYTH_MESSAGE_LEN = 32 + 8 + 8 + 4 + 8;

/** The oracle reading in a Pyth price account, or the reason it is not to be believed. */
export const readPythAccount = (data: Uint8Array): PriceReading => {
  const refused = (why: string): SourceRefused =>
    new SourceRefused(`the Pyth price account ${why}`);
  if (data.length <= PYTH_AUTHORITY_END) throw refused("is too short to read");
  const level = data[PYTH_AUTHORITY_END];
  if (level !== PYTH_FULL_TAG) throw refused("is not fully verified");
  const start = PYTH_AUTHORITY_END + 1;
  if (data.length < start + PYTH_MESSAGE_LEN) throw refused("is too short to read");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const feed = Buffer.from(data.subarray(start, start + 32)).toString("hex");
  if (feed !== SOL_USD_FEED_ID) throw refused("is not the SOL/USD feed");
  const price = view.getBigInt64(start + 32, true);
  const expo = view.getInt32(start + 32 + 8 + 8, true);
  const publishTime = view.getBigInt64(start + 32 + 8 + 8 + 4, true);
  if (expo < -MAX_PYTH_EXPONENT || expo > 0) throw refused("has an exponent out of range");
  const scaled = (price * SCALE) / 10n ** BigInt(-expo);
  if (scaled <= 0n) throw refused("holds a price that is not above zero");
  return {
    source: "Pyth",
    exchange: false,
    price: scaled,
    atMs: Number(publishTime) * MS_PER_SECOND,
  };
};

const dollars = (text: string): bigint => {
  if (!DECIMAL_TEXT.test(text)) throw new Error(`"${text}" is not a plain decimal price`);
  const price = fromDecimalString(text);
  if (price <= 0n) throw new Error("the price is not above zero");
  return price;
};

const coinbaseBody = z.object({ price: z.string(), time: z.string() });
/** The answer holds the pair's trades as a list, beside a plain-text `last` cursor. */
const krakenBody = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.unknown()),
});
/** A trade: price, volume, then the time it happened in seconds, then fields this does not read. */
const krakenTrade = z.tuple([z.string(), z.string(), z.number()]).rest(z.unknown());
const okxBody = z.object({
  data: z.array(z.object({ last: z.string(), ts: z.string().regex(/^\d+$/) })).min(1),
});

/**
 * Pyth's SOL/USD price, read from its price account on Solana mainnet (free,
 * through the Solana RPC connection; the account is the one the exchange's SOL
 * market is bound to). It is pushed every few seconds, so it may be up to
 * `maxOracleAgeMs` old. The exchanges are the public SOL tickers of Coinbase,
 * Kraken and OKX, and no call carries a key.
 */
export const referenceSources = (
  readAccount: ReadPythAccount,
  getJson: FetchJson = fetchJson,
): ReferenceSource[] => [
  {
    name: "Pyth",
    exchange: false,
    read: async () => {
      const data = await readAccount();
      if (!data) throw new SourceRefused("the Pyth price account does not exist");
      return readPythAccount(data);
    },
  },
  {
    name: "Coinbase",
    exchange: true,
    read: async () => {
      const body = coinbaseBody.parse(
        await getJson("https://api.exchange.coinbase.com/products/SOL-USD/ticker"),
      );
      const atMs = Date.parse(body.time);
      if (Number.isNaN(atMs)) throw new Error(`"${body.time}" is not a time`);
      return { source: "Coinbase", exchange: true, price: dollars(body.price), atMs };
    },
  },
  {
    name: "Kraken",
    exchange: true,
    read: async () => {
      const body = krakenBody.parse(
        await getJson("https://api.kraken.com/0/public/Trades?pair=SOLUSD&count=1"),
      );
      if (body.error.length > 0) throw new Error(body.error.join(", "));
      const trades = Object.values(body.result).find(Array.isArray);
      const trade = trades ? krakenTrade.safeParse(trades[trades.length - 1]) : null;
      if (!trade?.success) throw new Error("no trade in the answer");
      const [price, , seconds] = trade.data;
      return {
        source: "Kraken",
        exchange: true,
        price: dollars(price),
        atMs: Math.round(seconds * MS_PER_SECOND),
      };
    },
  },
  {
    name: "OKX",
    exchange: true,
    read: async () => {
      const body = okxBody.parse(
        await getJson("https://www.okx.com/api/v5/market/ticker?instId=SOL-USDC"),
      );
      return {
        source: "OKX",
        exchange: true,
        price: dollars(body.data[0].last),
        atMs: Number(body.data[0].ts),
      };
    },
  },
];

const BPS = 10_000n;

const median = (prices: bigint[]): bigint => {
  const sorted = [...prices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2n;
};

/**
 * The reference price: the median of the oracle and the exchanges, or the
 * reason there is none. There is none when the oracle or too few exchanges
 * answered, when an exchange reading is more than ten seconds old or the oracle
 * reading more than thirty (or dated that far ahead), or when the highest and
 * lowest are more than 30 bps apart.
 */
export const referenceOf = (
  readings: PriceReading[],
  silent: string[],
  nowMs: number,
  refusals: string[] = [],
): Reference => {
  const exchanges = readings.filter((reading) => reading.exchange).length;
  const notes = [
    ...(silent.length > 0 ? [`no answer from ${silent.join(", ")}`] : []),
    ...refusals,
  ];
  const silentNote = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  if (!readings.some((reading) => !reading.exchange)) {
    return { ok: false, reason: `the oracle price is missing${silentNote}` };
  }
  if (exchanges < MAKER_LIMITS.minExchanges) {
    return {
      ok: false,
      reason: `only ${exchanges} exchange prices came in, ${MAKER_LIMITS.minExchanges} are needed${silentNote}`,
    };
  }
  const stale = readings.find(
    (reading) =>
      Math.abs(nowMs - reading.atMs) >
      (reading.exchange ? MAKER_LIMITS.maxSourceAgeMs : MAKER_LIMITS.maxOracleAgeMs),
  );
  if (stale) {
    const seconds = Math.round((nowMs - stale.atMs) / MS_PER_SECOND);
    return { ok: false, reason: `the ${stale.source} price is ${seconds} s old` };
  }
  const prices = readings.map((reading) => reading.price);
  const middle = median(prices);
  const widest = absBigInt(
    prices.reduce((a, b) => (a > b ? a : b)) - prices.reduce((a, b) => (a < b ? a : b)),
  );
  if (widest * BPS > middle * BigInt(MAKER_LIMITS.maxSourceDisagreementBps)) {
    const bps = Number((widest * BPS * 10n) / middle) / 10;
    return { ok: false, reason: `the price sources are ${bps} bps apart` };
  }
  return { ok: true, price: middle };
};

/** Reads every source at once, and hands what came back to `referenceOf`. */
export class ReferencePrice {
  constructor(
    private readonly sources: ReferenceSource[],
    private readonly clock: Clock,
  ) {}

  async read(): Promise<Reference> {
    const answers = await Promise.allSettled(this.sources.map((source) => source.read()));
    const readings: PriceReading[] = [];
    const silent: string[] = [];
    const refusals: string[] = [];
    answers.forEach((answer, at) => {
      if (answer.status === "fulfilled") readings.push(answer.value);
      else if (answer.reason instanceof SourceRefused) refusals.push(answer.reason.message);
      else silent.push(this.sources[at].name);
    });
    return referenceOf(readings, silent, this.clock.nowMs(), refusals);
  }
}
