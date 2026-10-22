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

const REQUEST_TIMEOUT_MS = 3_000;

const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
};

const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const MS_PER_SECOND = 1_000;
const MAX_PYTH_EXPONENT = 18;

const dollars = (text: string): bigint => {
  if (!DECIMAL_TEXT.test(text)) throw new Error(`"${text}" is not a plain decimal price`);
  const price = fromDecimalString(text);
  if (price <= 0n) throw new Error("the price is not above zero");
  return price;
};

const pythBody = z.object({
  parsed: z
    .array(
      z.object({
        price: z.object({
          price: z.string().regex(/^\d+$/),
          expo: z.number().int().min(-MAX_PYTH_EXPONENT).max(0),
          publish_time: z.number(),
        }),
      }),
    )
    .min(1),
});

const coinbaseBody = z.object({ price: z.string(), time: z.string() });
const krakenBody = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.object({ c: z.array(z.string()).min(1) })),
});
const okxBody = z.object({
  data: z.array(z.object({ last: z.string(), ts: z.string().regex(/^\d+$/) })).min(1),
});

/**
 * Pyth's latest SOL/USD price from its public Hermes service, which is newer
 * than the price the chain holds (the chain's moves only on a push). The
 * exchanges are the public SOL tickers of Coinbase, Kraken and OKX. No call
 * carries a key.
 */
export const referenceSources = (
  clock: Clock,
  getJson: FetchJson = fetchJson,
): ReferenceSource[] => [
  {
    name: "Pyth",
    exchange: false,
    read: async () => {
      const body = pythBody.parse(
        await getJson(
          `https://hermes.pyth.network/v2/updates/price/latest?ids[]=0x${SOL_USD_FEED_ID}&parsed=true`,
        ),
      );
      const { price, expo, publish_time } = body.parsed[0].price;
      const scaled = (BigInt(price) * SCALE) / 10n ** BigInt(-expo);
      if (scaled <= 0n) throw new Error("the price is not above zero");
      return { source: "Pyth", exchange: false, price: scaled, atMs: publish_time * MS_PER_SECOND };
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
        await getJson("https://api.kraken.com/0/public/Ticker?pair=SOLUSD"),
      );
      if (body.error.length > 0) throw new Error(body.error.join(", "));
      const ticker = Object.values(body.result)[0];
      if (!ticker) throw new Error("no ticker in the answer");
      return {
        source: "Kraken",
        exchange: true,
        price: dollars(ticker.c[0]),
        atMs: clock.nowMs(),
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
 * answered, when any reading is more than ten seconds old (or dated that far
 * ahead), or when the highest and lowest are more than 30 bps apart.
 */
export const referenceOf = (
  readings: PriceReading[],
  silent: string[],
  nowMs: number,
): Reference => {
  const exchanges = readings.filter((reading) => reading.exchange).length;
  const silentNote = silent.length > 0 ? ` (no answer from ${silent.join(", ")})` : "";
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
    (reading) => Math.abs(nowMs - reading.atMs) > MAKER_LIMITS.maxSourceAgeMs,
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
    answers.forEach((answer, at) => {
      if (answer.status === "fulfilled") readings.push(answer.value);
      else silent.push(this.sources[at].name);
    });
    return referenceOf(readings, silent, this.clock.nowMs());
  }
}
