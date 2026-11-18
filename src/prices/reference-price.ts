import { z } from "zod";
import { MAKER_LIMITS } from "../bots/maker-limits.js";
import type { Clock } from "../engine/clock.js";
import { DECIMAL_TEXT, absBigInt, fromDecimalString } from "../engine/money.js";

export interface PriceReading {
  source: string;
  /** Dollars per SOL, scaled. */
  price: bigint;
  /** When the source says the price was set; the arrival time where it says nothing. */
  atMs: number;
}

export interface ReferenceSource {
  name: string;
  /** The least time between two calls to `read`; a source without it is read every time. */
  minIntervalMs?: number;
  read(): Promise<PriceReading>;
}

export type Reference =
  /** `leftOut` names the stale exchange readings that were dropped from the median, with their age. */
  { ok: true; price: bigint; leftOut?: string[] } | { ok: false; reason: string };

/** What the maker's risk rules and the hedge read the reference price from. */
export interface ReferenceReader {
  read(): Promise<Reference>;
}

export type FetchJson = (url: string) => Promise<unknown>;

const REQUEST_TIMEOUT_MS = 3_000;

const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
};

/** A source answered, but with something the maker must not use. The text goes into its pull reason. */
export class SourceRefused extends Error {}

const MS_PER_SECOND = 1_000;
/**
 * How often each exchange is called, however often the price is asked for. An
 * exchange reading may be 10 s old, and Kraken allows about one call a second
 * per address, so every 2 s keeps each well inside both.
 */
export const EXCHANGE_MIN_INTERVAL_MS = 2_000;

const dollars = (text: string): bigint => {
  if (!DECIMAL_TEXT.test(text)) throw new Error(`"${text}" is not a plain decimal price`);
  const price = fromDecimalString(text);
  if (price <= 0n) throw new Error("the price is not above zero");
  return price;
};

/** The middle of the best bid and ask, rounded down; a missing, zero or crossed quote is refused. */
const midpoint = (bid: string, ask: string): bigint => {
  const low = dollars(bid);
  const high = dollars(ask);
  if (high < low) throw new Error("the ask is below the bid");
  return (low + high) / 2n;
};

const coinbaseBody = z.object({ bid: z.string(), ask: z.string() });
/** The answer holds the pair's ticker, keyed by the exchange's own name for the pair. */
const krakenBody = z.object({
  error: z.array(z.string()),
  result: z.record(z.string(), z.unknown()),
});
/** A ticker: `a` is the best ask and `b` the best bid, each led by its price, then fields this does not read. */
const krakenTicker = z.object({
  a: z.tuple([z.string()]).rest(z.unknown()),
  b: z.tuple([z.string()]).rest(z.unknown()),
});
const okxBody = z.object({
  data: z
    .array(z.object({ bidPx: z.string(), askPx: z.string(), ts: z.string().regex(/^\d+$/) }))
    .min(1),
});

/**
 * The public SOL tickers of Coinbase, Kraken and OKX, where no call
 * carries a key. Each exchange price is the middle
 * of its best bid and ask, which is its quote now rather than its last trade,
 * so a quiet market does not read as a stale one. Coinbase and Kraken say
 * nothing of when the quote was set, so their reading is dated at the moment
 * the answer arrived (`nowMs`); OKX dates its own snapshot.
 */
export const referenceSources = (
  getJson: FetchJson = fetchJson,
  nowMs: () => number = Date.now,
): ReferenceSource[] => [
  {
    name: "Coinbase",
    minIntervalMs: EXCHANGE_MIN_INTERVAL_MS,
    read: async () => {
      const body = coinbaseBody.parse(
        await getJson("https://api.exchange.coinbase.com/products/SOL-USD/ticker"),
      );
      const price = midpoint(body.bid, body.ask);
      return { source: "Coinbase", price, atMs: nowMs() };
    },
  },
  {
    name: "Kraken",
    minIntervalMs: EXCHANGE_MIN_INTERVAL_MS,
    read: async () => {
      const body = krakenBody.parse(
        await getJson("https://api.kraken.com/0/public/Ticker?pair=SOLUSD"),
      );
      if (body.error.length > 0) throw new Error(body.error.join(", "));
      const ticker = krakenTicker.safeParse(Object.values(body.result)[0]);
      if (!ticker.success) throw new Error("no ticker in the answer");
      const price = midpoint(ticker.data.b[0], ticker.data.a[0]);
      return { source: "Kraken", price, atMs: nowMs() };
    },
  },
  {
    name: "OKX",
    minIntervalMs: EXCHANGE_MIN_INTERVAL_MS,
    read: async () => {
      const body = okxBody.parse(
        await getJson("https://www.okx.com/api/v5/market/ticker?instId=SOL-USDC"),
      );
      return {
        source: "OKX",
        price: midpoint(body.data[0].bidPx, body.data[0].askPx),
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
 * The reference price: the median of the exchanges, or the reason there is
 * none. There is none when too few exchanges answered, when fewer than the
 * needed exchanges are fresh (an exchange reading more than ten seconds old or
 * dated that far ahead is dropped from the median, not fatal in itself), or
 * when the highest and lowest of the readings kept are more than 30 bps apart.
 */
export const referenceOf = (
  readings: PriceReading[],
  silent: string[],
  nowMs: number,
  refusals: string[] = [],
): Reference => {
  const exchanges = readings.length;
  const ageMs = (reading: PriceReading): number => Math.abs(nowMs - reading.atMs);
  const notes = [
    ...(silent.length > 0 ? [`no answer from ${silent.join(", ")}`] : []),
    ...refusals,
  ];
  const silentNote = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  if (exchanges < MAKER_LIMITS.minExchanges) {
    return {
      ok: false,
      reason: `only ${exchanges} exchange prices came in, ${MAKER_LIMITS.minExchanges} are needed${silentNote}`,
    };
  }
  const seconds = (reading: PriceReading): number =>
    Math.round((nowMs - reading.atMs) / MS_PER_SECOND);
  const staleExchanges = readings.filter((reading) => ageMs(reading) > MAKER_LIMITS.maxSourceAgeMs);
  const kept = readings.filter((reading) => !staleExchanges.includes(reading));
  if (exchanges - staleExchanges.length < MAKER_LIMITS.minExchanges) {
    const named = staleExchanges.map((reading) => `${reading.source} is ${seconds(reading)} s old`);
    return {
      ok: false,
      reason:
        `only ${exchanges - staleExchanges.length} fresh exchange prices, ` +
        `${MAKER_LIMITS.minExchanges} are needed (${named.join(", ")})`,
    };
  }
  const prices = kept.map((reading) => reading.price);
  const middle = median(prices);
  const widest = absBigInt(
    prices.reduce((a, b) => (a > b ? a : b)) - prices.reduce((a, b) => (a < b ? a : b)),
  );
  if (widest * BPS > middle * BigInt(MAKER_LIMITS.maxSourceDisagreementBps)) {
    const bps = Number((widest * BPS * 10n) / middle) / 10;
    return { ok: false, reason: `the price sources are ${bps} bps apart` };
  }
  if (staleExchanges.length === 0) return { ok: true, price: middle };
  return {
    ok: true,
    price: middle,
    leftOut: staleExchanges.map(
      (reading) => `${reading.source} left out, ${seconds(reading)} s old`,
    ),
  };
};

/**
 * Calls a source at most once per its `minIntervalMs`; in between, its last
 * answer is used again as it was, a reading keeping its own time (so it ages
 * and goes stale when it would have) and a failure failing the same way (so a
 * source that is down is not called every time either). `monotonicMs` times the
 * gap between calls and nothing else: the wall clock can be corrected backward
 * or forward, which must neither bring a source's next call early nor push it late.
 */
class Throttle {
  private readonly lastCalls = new Map<
    ReferenceSource,
    { monotonicAtMs: number; answer: Promise<PriceReading> }
  >();

  constructor(private readonly monotonicMs: () => number = () => performance.now()) {}

  read(source: ReferenceSource): Promise<PriceReading> {
    const monotonicNowMs = this.monotonicMs();
    const last = this.lastCalls.get(source);
    if (last && monotonicNowMs - last.monotonicAtMs < (source.minIntervalMs ?? 0)) {
      return last.answer;
    }
    const answer = source.read();
    this.lastCalls.set(source, { monotonicAtMs: monotonicNowMs, answer });
    return answer;
  }
}

/** Reads every source at once, throttled, and hands what came back to `referenceOf`. Readings are dated, and aged, by `clock`. */
export class ReferencePrice implements ReferenceReader {
  private readonly throttle: Throttle;

  constructor(
    private readonly sources: ReferenceSource[],
    private readonly clock: Clock,
    monotonicMs?: () => number,
  ) {
    this.throttle = new Throttle(monotonicMs);
  }

  async read(): Promise<Reference> {
    const answers = await Promise.allSettled(
      this.sources.map((source) => this.throttle.read(source)),
    );
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
