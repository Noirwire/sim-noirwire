import { access, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/** While `fails` is set, removing a recovery marker is refused, as a failing disk would. */
const removal = vi.hoisted(() => ({ fails: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) =>
      removal.fails && String(path).endsWith(".failed")
        ? Promise.reject(new Error("EBUSY: the disk refused the removal"))
        : actual.rm(path, options),
  };
});
import {
  HouseMaker,
  type HouseMakerOptions,
  QuotesHeld,
  flattenOrders,
  holdLapsesAtMs,
  ladderOrders,
  onlyReducing,
} from "../src/bots/house-maker.js";
import {
  CONFIRM_STOP_FLAG,
  MakerControl,
  controlPath,
  killSwitchRequest,
  requestMode,
} from "../src/bots/maker-control.js";
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerSafety, worstEquity } from "../src/bots/maker-safety.js";
import { MakerLedger, StatePersistenceError, makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import type { MarketInfo, NewOrder, TraderState, Venue } from "../src/engine/types.js";
import { VenueNotReady } from "../src/engine/venue-not-ready.js";
import type { HedgeVenue } from "../src/hedge/hedge-venue.js";
import {
  type PriceReading,
  type Reference,
  ReferencePrice,
  referenceOf,
  referenceSources,
} from "../src/prices/reference-price.js";
import { MARKETS } from "../src/engine/markets.js";
import { ORDER_EXPIRY_TOO_NEAR, placingOrdersThrough } from "../src/engine/venue-orders.js";
import { openBots } from "../src/wiring/bots.js";
import { TradingWatch } from "../src/wiring/trading-watch.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { FakeHedgeVenue } from "./fake-hedge-venue.js";
import { dollars, makeVenue } from "./helpers.js";

const PERP = "NSOL-PERP";
const SPOT = "NSOL-NUSD";
const START_MS = Date.parse("2026-11-02T12:00:00Z");
const ROOT = join("data-test", `maker-rules-${Date.now()}`);

afterAll(() => rm(ROOT, { recursive: true, force: true }));

const reading = (source: string, price: number, atMs: number, exchange = true): PriceReading => ({
  source,
  exchange,
  price: dollars(price),
  atMs,
});

describe("the reference price", () => {
  const now = START_MS;
  const pyth = reading("Pyth", 150, now - 1_000, false);

  it("is the median of the oracle and the exchanges", () => {
    const three = [pyth, reading("Coinbase", 150.1, now), reading("Kraken", 150.3, now)];
    expect(referenceOf(three, [], now)).toEqual({ ok: true, price: dollars(150.1) });

    const four = [...three, reading("OKX", 150.2, now)];
    expect(referenceOf(four, [], now)).toEqual({ ok: true, price: dollars(150.15) });
  });

  it("needs the oracle and two exchanges, and names the sources that did not answer", () => {
    const noOracle = referenceOf(
      [reading("Coinbase", 150, now), reading("Kraken", 150, now)],
      ["Pyth"],
      now,
    );
    expect(noOracle).toEqual({
      ok: false,
      reason: expect.stringContaining("oracle price is missing"),
    });

    const oneExchange = referenceOf([pyth, reading("Coinbase", 150, now)], ["Kraken", "OKX"], now);
    expect(oneExchange).toEqual({
      ok: false,
      reason: expect.stringContaining(
        "only 1 exchange prices came in, 2 are needed (no answer from Kraken, OKX)",
      ),
    });
  });

  it("gives none when any reading is more than 10 s old, or dated more than 10 s ahead", () => {
    const fresh = [pyth, reading("Coinbase", 150, now)];
    const old = referenceOf([...fresh, reading("Kraken", 150, now - 11_000)], [], now);
    expect(old).toEqual({ ok: false, reason: "the Kraken price is 11 s old" });

    const ahead = referenceOf([...fresh, reading("Kraken", 150, now + 11_000)], [], now);
    expect(ahead.ok).toBe(false);

    const tenSeconds = referenceOf([...fresh, reading("Kraken", 150, now - 10_000)], [], now);
    expect(tenSeconds.ok).toBe(true);
  });

  it("gives none when the sources are more than 30 bps apart, and one when they are 30 bps apart", () => {
    const apart = (high: number) =>
      referenceOf([pyth, reading("Coinbase", 150, now), reading("Kraken", high, now)], [], now);

    expect(apart(150.46)).toEqual({ ok: false, reason: "the price sources are 30.6 bps apart" });
    expect(apart(150.45).ok).toBe(true);
  });

  it("reads every source at once and treats one that fails as silent", async () => {
    const clock = new ManualClock(now);
    const sources = [
      { name: "Pyth", exchange: false, read: async () => pyth },
      { name: "Coinbase", exchange: true, read: async () => reading("Coinbase", 150, now) },
      { name: "Kraken", exchange: true, read: async () => reading("Kraken", 150, now) },
      {
        name: "OKX",
        exchange: true,
        read: async (): Promise<PriceReading> => {
          throw new Error("timed out");
        },
      },
    ];

    expect(await new ReferencePrice(sources, clock).read()).toEqual({
      ok: true,
      price: dollars(150),
    });
    expect(await new ReferencePrice(sources.slice(1), clock).read()).toEqual({
      ok: false,
      reason: expect.stringContaining("the oracle price is missing"),
    });
  });

  it("reads the public answers of Pyth, Coinbase, Kraken and OKX", async () => {
    const answers: Record<string, unknown> = {
      "hermes.pyth.network": {
        parsed: [{ price: { price: "15012345678", expo: -8, publish_time: now / 1_000 - 2 } }],
      },
      "api.exchange.coinbase.com": { price: "150.11", time: new Date(now - 500).toISOString() },
      "api.kraken.com": {
        error: [],
        result: {
          SOLUSD: [["150.12", "0.4", now / 1_000 - 1.5, "b", "l", "", 1234]],
          last: "1790000000000000000",
        },
      },
      "www.okx.com": { data: [{ last: "150.13", ts: String(now - 300) }] },
    };
    const sources = referenceSources(async (url) => answers[new URL(url).host]);

    const readings = await Promise.all(sources.map((source) => source.read()));

    expect(readings).toEqual([
      { source: "Pyth", exchange: false, price: dollars(150.123456), atMs: now - 2_000 },
      { source: "Coinbase", exchange: true, price: dollars(150.11), atMs: now - 500 },
      { source: "Kraken", exchange: true, price: dollars(150.12), atMs: now - 1_500 },
      { source: "OKX", exchange: true, price: dollars(150.13), atMs: now - 300 },
    ]);
  });
});

/** A venue the maker can be driven against, with every order and cancel written down. */
class Book {
  mark = dollars(150);
  position = 0n;
  equity = dollars(1_000);
  spotBase = 0n;
  orders: NewOrder[] = [];
  cancels = 0;
  failPlacing: Error | null = null;
  failCancelling: Error | null = null;
  /** The venue never answers a cancel. */
  hangCancelling = false;
  /** The cancels that were left unanswered, to answer later. */
  hungCancels: (() => void)[] = [];
  releaseCancels(): void {
    for (const answer of this.hungCancels.splice(0)) answer();
  }
  /** Order calls the venue gave up on that may still land. */
  unsettled = 0;
  /** The venue answers every order with a refusal, giving this reason. */
  rejecting: string | null = null;
  rejectedCount = 0;
  /** Once this many orders stand, the venue refuses a resting order as too near its expiry, sending nothing. */
  refusesTooLateAfter: number | null = null;
  /** The venue answers every order as rejected but possibly executed, giving this reason. */
  unknownBecause: string | null = null;
  beforePlacing: (() => Promise<void>) | null = null;
  /** Why the market would refuse a resting order, and whether it still takes reduce-only ones. */
  refusedBecause: string | null = null;
  takesReduceOnly = false;
  /** Like the venue: a reduce-only order is refused while the position is flat. */
  refusesReduceOnlyWhenFlat = false;
  markMissing = false;

  asVenue(): Venue {
    return {
      markets: async () => [this.info()],
      unsettledPlaces: () => this.unsettled,
      cancelAll: async () => {
        if (this.hangCancelling) {
          return new Promise<number>((resolve) => this.hungCancels.push(() => resolve(0)));
        }
        if (this.failCancelling) throw this.failCancelling;
        this.cancels += 1;
        return 0;
      },
      placeOrder: async (_trader: string, order: NewOrder) => {
        await this.beforePlacing?.();
        if (this.failPlacing) throw this.failPlacing;
        if (this.unknownBecause !== null) {
          return {
            orderId: "",
            tag: 0n,
            status: "rejected",
            filledSize: 0n,
            remainingSize: order.size,
            reason: this.unknownBecause,
            outcomeUnknown: true,
          };
        }
        if (this.refusesReduceOnlyWhenFlat && order.reduceOnly === true && this.position === 0n) {
          this.rejectedCount += 1;
          return {
            orderId: "",
            tag: 0n,
            status: "rejected",
            filledSize: 0n,
            remainingSize: order.size,
            reason: "ReduceOnlyWouldIncrease",
          };
        }
        if (
          this.refusesTooLateAfter !== null &&
          order.reduceOnly !== true &&
          this.orders.length >= this.refusesTooLateAfter
        ) {
          return {
            orderId: "",
            tag: 0n,
            status: "rejected",
            filledSize: 0n,
            remainingSize: order.size,
            reason: ORDER_EXPIRY_TOO_NEAR,
          };
        }
        if (this.rejecting !== null) {
          this.rejectedCount += 1;
          return {
            orderId: "",
            tag: 0n,
            status: "rejected",
            filledSize: 0n,
            remainingSize: order.size,
            reason: this.rejecting,
          };
        }
        this.orders.push(order);
        return { orderId: "", tag: 0n, status: "open", filledSize: 0n, remainingSize: order.size };
      },
      traderState: async (): Promise<TraderState> => ({
        trader: "maker",
        balances: { SOL: { balance: this.spotBase, locked: 0n } },
        positions: { [PERP]: { size: this.position, entryPrice: this.mark } },
        openOrders: [],
        equity: this.equity,
      }),
    } as unknown as Venue;
  }

  private info(): MarketInfo {
    return {
      id: PERP,
      kind: "perp",
      base: "SOL",
      quote: "nUSD",
      tickSize: dollars(0.01),
      lotSize: dollars(0.001),
      maxLeverage: 5,
      markPrice: this.markMissing ? null : this.mark,
      markPriceUpdatedAtMs: 0,
      change24h: null,
      volume24h: 0n,
      openInterest: null,
      ...(this.refusedBecause === null ? {} : { quotesRefusedBecause: this.refusedBecause }),
      ...(this.takesReduceOnly ? { takesReduceOnlyOrders: true } : {}),
    };
  }

  /** The orders placed since the last call. */
  take(): NewOrder[] {
    return this.orders.splice(0);
  }
}

const pricesOf = (orders: NewOrder[], side: NewOrder["side"]): bigint[] =>
  orders.filter((order) => order.side === side).map((order) => order.price ?? 0n);

const bpsBelow = (reference: number, price: bigint): number =>
  ((reference - Number(price) / 1e6) / reference) * 10_000;

/** How far the highest bid sits under the reference, in bps. */
const nearestBidBps = (orders: NewOrder[], reference = 150): number =>
  bpsBelow(
    reference,
    pricesOf(orders, "buy").reduce((a, b) => (a > b ? a : b)),
  );

const voiceOf = (said: { alerts: string[]; notices: string[] }) => ({
  alert: (message: string) => said.alerts.push(message),
  notice: (message: string) => said.notices.push(message),
});

/** One maker under the risk rules, its venue, its clock, and everything it said. */
const rig = async (
  name: string,
  over: Partial<HouseMakerOptions> = {},
  { equityAtStart = dollars(1_000) } = {},
) => {
  const dir = join(ROOT, name);
  await mkdir(dir, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  const clock = new ManualClock(START_MS);
  const book = new Book();
  book.equity = equityAtStart;
  const said = { alerts: [] as string[], notices: [] as string[] };
  const voice = {
    alert: (message: string) => said.alerts.push(message),
    notice: (message: string) => said.notices.push(message),
  };
  const feed = { reference: { ok: true, price: dollars(150) } as Reference };
  const open = async () => {
    const ledger = await MakerLedger.open(makerStatePath(dir, PERP));
    const safety = new MakerSafety({
      reference: { read: async () => feed.reference },
      risk: new MakerRisk(ledger, clock, PERP, voice),
      control: new MakerControl(controlPath(dir)),
      clock,
      voice,
      market: PERP,
    });
    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 3,
      spreadBps: 15,
      levelStepBps: 5,
      baseSizePerLevel: dollars(0.3),
      requoteThresholdBps: 6,
      requoteIntervalMs: 10_000,
      positionLimitNotional: dollars(250),
      maxSkewBps: 20,
      lotSize: dollars(0.001),
      startingQuoteBalance: dollars(1_000),
      startingBaseBalance: 0n,
      clock,
      safety,
      ledger,
      ...over,
    });
    return { maker, ledger };
  };
  const { maker, ledger } = await open();
  const venue = book.asVenue();
  const tick = async (seconds = 1) => {
    clock.advance(seconds * 1_000);
    await maker.tick(venue);
  };
  /** Ten quiet seconds of prices, which is how long the maker watches before it quotes. */
  const warmUp = async () => {
    await maker.tick(venue);
    for (let second = 0; second < 10; second += 1) await tick();
  };
  return { dir, clock, book, said, feed, maker, ledger, venue, tick, warmUp, open };
};

describe("a house maker's quotes expire by themselves", () => {
  it("gives every resting order an expiry of the requote interval plus 10 s", async () => {
    const { warmUp, book } = await rig("expiry");

    await warmUp();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => order.expiresInSeconds === 20)).toBe(true);
  });

  it("does so without the risk rules too, so a maker that dies leaves no quote standing", async () => {
    const book = new Book();
    const clock = new ManualClock(START_MS);
    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 1,
      spreadBps: 15,
      levelStepBps: 5,
      baseSizePerLevel: dollars(0.3),
      requoteThresholdBps: 6,
      requoteIntervalMs: 5_000,
      positionLimitNotional: dollars(250),
      maxSkewBps: 20,
      lotSize: dollars(0.001),
      startingQuoteBalance: dollars(1_000),
      startingBaseBalance: 0n,
      clock,
    });

    await maker.tick(book.asVenue());

    expect(book.orders.map((order) => order.expiresInSeconds)).toEqual([15, 15]);
  });
});

describe("a house maker's reference price", () => {
  it("quotes around the reference price, not around the mark", async () => {
    const { warmUp, book, feed } = await rig("centre");
    feed.reference = { ok: true, price: dollars(150.1) };
    await warmUp();

    const orders = book.take();
    const nearestBid = Number(pricesOf(orders, "buy").reduce((a, b) => (a > b ? a : b))) / 1e6;
    const nearestAsk = Number(pricesOf(orders, "sell").reduce((a, b) => (a < b ? a : b))) / 1e6;
    expect((nearestBid + nearestAsk) / 2).toBeCloseTo(150.1, 1);
    expect(nearestBid).toBeLessThan(150.1 - 0.2);
  });

  it("watches the price for 10 s before it first quotes", async () => {
    const { maker, venue, tick, book, said } = await rig("warm-up");

    await maker.tick(venue);
    await tick(5);
    expect(book.orders).toHaveLength(0);
    expect(said.notices.join()).toContain("watching the price for 10 s");

    await tick(5);
    expect(book.orders.length).toBeGreaterThan(0);
  });

  it("pulls its quotes when the sources disagree or one is stale, and quotes again after 10 quiet seconds", async () => {
    const { warmUp, book, feed, tick, said } = await rig("pull-on-sources");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    feed.reference = { ok: false, reason: "the price sources are 41.0 bps apart" };
    await tick();
    await tick();

    expect(book.cancels).toBe(cancelsBefore + 1);
    expect(book.orders).toHaveLength(0);
    expect(said.notices.filter((line) => line.includes("41.0 bps apart"))).toHaveLength(1);

    feed.reference = { ok: true, price: dollars(150) };
    await tick(5);
    await tick(5);
    expect(book.orders).toHaveLength(0);
    await tick(6);
    expect(book.orders.length).toBeGreaterThan(0);
    expect(said.notices.join()).toContain("quoting again");
  });

  it("widens by the gap when the NoirWire mark lags the reference by more than 10 bps", async () => {
    const lagging = await rig("lag");
    lagging.book.mark = dollars(150 * (1 - 0.004));
    await lagging.warmUp();
    const normal = await rig("no-lag");
    await normal.warmUp();

    const laggingBid = nearestBidBps(lagging.book.take());
    const normalBid = nearestBidBps(normal.book.take());

    expect(laggingBid - normalBid).toBeGreaterThan(39);
  });

  it("pulls its quotes when the mark lags the reference by more than 100 bps", async () => {
    const { book, warmUp, said } = await rig("lag-pull");
    book.mark = dollars(150 * (1 - 0.012));

    await warmUp();

    expect(book.orders).toHaveLength(0);
    expect(said.notices.join()).toContain("check that the price crank is running");
  });

  it("widens by half the price range of the last minute", async () => {
    const calm = await rig("calm");
    await calm.warmUp();
    expect(nearestBidBps(calm.book.take())).toBeLessThan(16);

    const choppy = await rig("choppy");
    for (let second = 0; second < 20; second += 1) {
      choppy.feed.reference = { ok: true, price: dollars(second % 2 === 0 ? 150 : 150.3) };
      await choppy.tick();
    }
    choppy.book.take();
    choppy.feed.reference = { ok: true, price: dollars(150.15) };
    await choppy.tick(6);

    // A range of 20 bps adds 10 bps to the 15 bps half-spread.
    const bid = nearestBidBps(choppy.book.take(), 150.15);
    expect(bid).toBeGreaterThanOrEqual(25);
    expect(bid).toBeLessThan(26);
  });

  it("pulls on a move of more than 0.5% in 10 s, and quotes again once it has settled", async () => {
    const { warmUp, book, feed, tick, said } = await rig("sudden-move");
    await warmUp();
    book.take();

    feed.reference = { ok: true, price: dollars(151) };
    await tick(2);
    expect(book.orders).toHaveLength(0);
    expect(said.notices.join()).toContain("moved 66.7 bps in 10 s");

    await tick(5);
    expect(book.orders).toHaveLength(0);
    await tick(6);
    await tick();
    expect(book.orders.length).toBeGreaterThan(0);
  });
});

describe("a house maker's spread and sizes", () => {
  it("never quotes closer than 15 bps to the reference, whatever its spread is set to", async () => {
    const { warmUp, book } = await rig("floor", { spreadBps: 3, levelStepBps: 5 });

    await warmUp();

    const orders = book.take();
    const nearestAsk = pricesOf(orders, "sell").reduce((a, b) => (a < b ? a : b));
    expect(nearestBidBps(orders)).toBeGreaterThanOrEqual(15);
    expect(-bpsBelow(150, nearestAsk)).toBeGreaterThanOrEqual(15);
  });

  it("quotes every level at the same size", async () => {
    const { warmUp, book } = await rig("levels");

    await warmUp();

    const orders = book.take();
    expect(orders).toHaveLength(6);
    expect(new Set(orders.map((order) => order.size))).toEqual(new Set([dollars(0.3)]));
  });
});

describe("the mainnet settings of the maker", () => {
  const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    NETWORK: "mainnet",
    VENUE: "rollup",
    TRUSTED_PROXY_HOPS: "1",
    SOLANA_RPC_URL: "https://solana.example/key",
    ROLLUP_RPC_URL: "https://rollup.example/key",
    ROLLUP_WS_URL: "wss://rollup.example/key",
    PUBLIC_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
    PUBLIC_ROLLUP_RPC_URL: "https://rollup-public.example",
    PUBLIC_ROLLUP_WS_URL: "wss://rollup-public.example",
    DEPLOYMENT_PATH: "/run/secrets/deployment.json",
    GATE_SECRET_KEY_FILE: "/run/secrets/gate.json",
    GATE_INVITES_FILE: "/run/gate/invites.txt",
    BOT_TRADER_SEEDS_FILE: "/run/secrets/maker-seeds",
    ...over,
  });
  const refusals = (over: Record<string, string>): string[] => {
    try {
      loadConfig(env(over));
    } catch (error) {
      return (error as Error).message.split("\n").slice(1);
    }
    return [];
  };

  it("defaults to sizes for a maker of about 1,000 USDC, with the risk rules on", () => {
    const config = loadConfig(env());

    expect(config.HOUSE_MAKER_RISK_RULES).toBe(true);
    expect(config.ROLLUP_MAKER_LEVEL_NUSD).toBe(dollars(50));
    expect(config.HOUSE_MAKER_POSITION_LIMIT_NUSD).toBe(dollars(250));
    expect(config.HOUSE_MAKER_LEVELS).toBe(3);
    expect(config.HOUSE_MAKER_REQUOTE_INTERVAL_MS).toBe(10_000);
    expect(config.HOUSE_MAKER_SPREAD_BPS).toBe(15);
  });

  it("takes the sizes it is given, within the limits", () => {
    const config = loadConfig(
      env({ ROLLUP_MAKER_LEVEL_NUSD: "120", HOUSE_MAKER_POSITION_LIMIT_NUSD: "200" }),
    );

    expect(config.ROLLUP_MAKER_LEVEL_NUSD).toBe(dollars(120));
    expect(config.HOUSE_MAKER_POSITION_LIMIT_NUSD).toBe(dollars(200));
  });

  it("refuses to start with a value outside the limits, and says which and what to do", () => {
    expect(refusals({ HOUSE_MAKER_SPREAD_BPS: "10" })).toEqual([
      expect.stringContaining("HOUSE_MAKER_SPREAD_BPS is under the 15 bps floor"),
    ]);
    expect(refusals({ ROLLUP_MAKER_LEVEL_NUSD: "600" })).toEqual([
      expect.stringContaining("ROLLUP_MAKER_LEVEL_NUSD is over 500 nUSD"),
    ]);
    expect(refusals({ HOUSE_MAKER_POSITION_LIMIT_NUSD: "300" })).toEqual([
      expect.stringContaining("HOUSE_MAKER_POSITION_LIMIT_NUSD is over 250 nUSD"),
    ]);
    expect(refusals({ HOUSE_MAKER_REQUOTE_INTERVAL_MS: "90000" })).toEqual([
      expect.stringContaining("HOUSE_MAKER_REQUOTE_INTERVAL_MS is over 30000 ms"),
    ]);
    expect(refusals({ HOUSE_MAKER_RISK_RULES: "0" })).toEqual([
      expect.stringContaining("HOUSE_MAKER_RISK_RULES=0 turns the maker's risk rules off"),
    ]);
  });

  it("leaves the rules off elsewhere unless asked", () => {
    expect(loadConfig({ NETWORK: "devnet" }).HOUSE_MAKER_RISK_RULES).toBe(false);
    expect(loadConfig({ HOUSE_MAKER_RISK_RULES: "1" }).HOUSE_MAKER_RISK_RULES).toBe(true);
  });
});

describe("a house maker's loss limits", () => {
  it("stops growing after losing 3% of the day's starting equity, and says so", async () => {
    const { warmUp, book, tick, said, maker, venue } = await rig("daily-loss");
    book.position = dollars(0.5);
    await warmUp();
    book.take();

    book.equity = dollars(969);
    await tick(11);

    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("it lost 31.00 nUSD today, 3% of the 1000.00");
    expect(said.alerts[0]).toContain("run the kill switch");
    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(new Set(orders.map((order) => order.side))).toEqual(new Set(["sell"]));
    await maker.tick(venue);
    expect(said.alerts).toHaveLength(1);
  });

  it("does not stop at a loss just under 3%", async () => {
    const { warmUp, book, tick, said } = await rig("under-the-limit");
    await warmUp();
    book.take();

    book.equity = dollars(970.01);
    await tick(11);

    expect(said.alerts).toHaveLength(0);
    expect(new Set(book.take().map((order) => order.side))).toEqual(new Set(["buy", "sell"]));
  });

  it("stops growing after a 5% drawdown from the peak, even on a day that is in profit", async () => {
    const { warmUp, book, tick, said } = await rig("drawdown");
    await warmUp();
    book.equity = dollars(1_100);
    await tick();
    book.take();

    book.equity = dollars(1_044);
    await tick(11);

    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("it is 56.00 nUSD below its peak of 1100.00, 5% or more");
  });

  it("keeps the stop across a restart, and across the turn of the day", async () => {
    const first = await rig("restart");
    first.book.position = dollars(0.5);
    await first.warmUp();
    first.book.equity = dollars(960);
    await first.tick();
    expect(first.ledger.state.mode).toBe("flatten");

    const { maker, ledger } = await first.open();
    expect(ledger.state.mode).toBe("flatten");
    expect(ledger.state.dayStartEquity).toBe(dollars(1_000));
    expect(ledger.state.peakEquity).toBe(dollars(1_000));
    expect(ledger.state.reason).toContain("it lost 40.00 nUSD today");

    first.book.position = 0n;
    first.clock.advance(24 * 3_600_000);
    first.book.take();
    await maker.tick(first.venue);
    for (let second = 0; second < 11; second += 1) {
      first.clock.advance(1_000);
      await maker.tick(first.venue);
    }
    expect(ledger.state.mode).toBe("flatten");
    expect(ledger.state.day).toBe("2026-11-03");
    expect(ledger.state.dayStartEquity).toBe(dollars(960));
    expect(first.book.take()).toEqual([]);
  });

  it("refuses to start from a state file it cannot read, instead of starting the limits over", async () => {
    const dir = join(ROOT, "damaged");
    await mkdir(dir, { recursive: true });
    await writeFile(makerStatePath(dir, PERP), "{ not json");

    await expect(MakerLedger.open(makerStatePath(dir, PERP))).rejects.toThrow(
      "cannot be read, so its loss limits cannot be trusted",
    );
  });

  it("quotes nothing while its seat holds no equity", async () => {
    const { warmUp, book } = await rig("no-equity", {}, { equityAtStart: 0n });

    await warmUp();

    expect(book.orders).toHaveLength(0);
  });
});

describe("the kill switch", () => {
  it("cancels the quotes that would grow the position and keeps the reducing side, up to the position", async () => {
    const { warmUp, book, dir, clock, tick, said } = await rig("kill-reduce");
    book.position = dollars(0.5);
    await warmUp();
    expect(new Set(book.take().map((order) => order.side))).toEqual(new Set(["buy", "sell"]));

    await requestMode(dir, "reduce", clock.nowMs() + 1);
    await tick();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(new Set(orders.map((order) => order.side))).toEqual(new Set(["sell"]));
    expect(orders.reduce((sum, order) => sum + order.size, 0n)).toBeLessThanOrEqual(dollars(0.5));
    expect(said.alerts[0]).toContain("users can still close");
  });

  it("keeps the buying side of a short position, and quotes nothing flat", () => {
    const quote = (side: NewOrder["side"], size: number): NewOrder => ({
      market: PERP,
      side,
      type: "postOnly",
      price: dollars(150),
      size: dollars(size),
    });
    const ladder = [quote("buy", 0.3), quote("sell", 0.3), quote("buy", 0.3), quote("sell", 0.3)];

    expect(
      onlyReducing(ladder, -dollars(0.4), dollars(0.001)).map((o) => [o.side, o.size]),
    ).toEqual([
      ["buy", dollars(0.3)],
      ["buy", dollars(0.1)],
    ]);
    expect(onlyReducing(ladder, 0n, dollars(0.001))).toEqual([]);
  });

  it("stops everything: cancels the quotes and places none, until it is resumed", async () => {
    const { warmUp, book, dir, clock, tick, said } = await rig("kill-stop");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    await requestMode(dir, "stopped", clock.nowMs() + 1);
    await tick();
    await tick(30);

    expect(book.cancels).toBe(cancelsBefore + 1);
    expect(book.orders).toHaveLength(0);
    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("the kill switch stopped it");
    expect(said.alerts[0]).toContain("nobody can close a position against it");
    expect(said.alerts[0]).toContain("The exchange admin can pause the market");

    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick();
    for (let second = 0; second < 10; second += 1) await tick();
    expect(book.orders.length).toBeGreaterThan(0);
  });

  it("follows a command once, so a resume is not undone by the old stop file", async () => {
    const { warmUp, dir, clock, tick, ledger } = await rig("kill-once");
    await warmUp();

    await requestMode(dir, "stopped", clock.nowMs() + 1);
    await tick();
    expect(ledger.state.mode).toBe("stopped");
    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick();
    expect(ledger.state.mode).toBe("run");
    await tick(30);
    expect(ledger.state.mode).toBe("run");
  });

  it("is still stopped after a restart", async () => {
    const first = await rig("kill-restart");
    await first.warmUp();
    await requestMode(first.dir, "stopped", first.clock.nowMs() + 1);
    await first.tick();

    const { maker } = await first.open();
    first.book.take();
    for (let second = 0; second < 15; second += 1) {
      first.clock.advance(1_000);
      await maker.tick(first.venue);
    }

    expect(first.book.orders).toHaveLength(0);
  });

  it("resumes with its loss limits counting from the equity it has now", async () => {
    const { warmUp, book, dir, clock, tick, ledger } = await rig("kill-resume");
    await warmUp();
    book.equity = dollars(900);
    await tick();
    expect(ledger.state.mode).toBe("flatten");

    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick();

    expect(ledger.state.mode).toBe("run");
    expect(ledger.state.dayStartEquity).toBe(dollars(900));
    expect(ledger.state.peakEquity).toBe(dollars(900));
  });
});

describe("a spot house maker's starting base", () => {
  const spotMaker = async (dir: string, startingBase: bigint) => {
    await mkdir(dir, { recursive: true });
    const ledger = await MakerLedger.open(makerStatePath(dir, SPOT));
    const maker = new HouseMaker({
      market: SPOT,
      kind: "spot",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 1,
      spreadBps: 15,
      levelStepBps: 5,
      baseSizePerLevel: dollars(0.3),
      requoteThresholdBps: 6,
      requoteIntervalMs: 10_000,
      positionLimitNotional: dollars(100),
      maxSkewBps: 20,
      lotSize: dollars(0.001),
      startingQuoteBalance: dollars(1_000),
      startingBaseBalance: startingBase,
      clock: new ManualClock(START_MS),
      ledger,
    });
    return { maker, ledger };
  };

  const spotVenue = (held: bigint) => {
    const book = new Book();
    book.spotBase = held;
    book.mark = dollars(10);
    const venue = book.asVenue();
    const deposits: bigint[] = [];
    const spot = {
      ...venue,
      openTrader: async () => {},
      deposit: async (_trader: string, token: string, amount: bigint) => {
        if (token === "SOL") deposits.push(amount);
      },
      markets: async () => [{ ...(await venue.markets())[0], id: SPOT, kind: "spot" as const }],
    } as unknown as Venue;
    return { book, spot, deposits };
  };

  it("keeps the base it first started with, so a restart does not take today's balance for it", async () => {
    const dir = join(ROOT, "spot-base");
    await rm(dir, { recursive: true, force: true });
    const start = dollars(100);

    const first = await spotMaker(dir, start);
    await first.maker.ensureOpen(spotVenue(start).spot);
    expect(first.ledger.state.spotBaseAtStart).toBe(start);

    const restarted = await spotMaker(dir, dollars(110));
    expect(restarted.ledger.state.spotBaseAtStart).toBe(start);
    const { book, spot } = spotVenue(dollars(110));
    await restarted.maker.ensureOpen(spot);
    await restarted.maker.tick(spot);

    // 10 SOL (about $100) over its start is at its limit: it quotes no more buying.
    expect(new Set(book.orders.map((order) => order.side))).toEqual(new Set(["sell"]));
  });

  it("without a saved start, takes the base it holds at start as its start", async () => {
    const dir = join(ROOT, "spot-base-fresh");
    await rm(dir, { recursive: true, force: true });
    const { maker } = await spotMaker(dir, dollars(110));
    const { book, spot } = spotVenue(dollars(110));

    await maker.ensureOpen(spot);
    await maker.tick(spot);

    expect(new Set(book.orders.map((order) => order.side))).toEqual(new Set(["buy", "sell"]));
  });
});

describe("the makers opened by the service", () => {
  const openedWith = async (
    market: (typeof MARKETS)[number],
    over: Record<string, string>,
    marketsOf?: (real: Venue["markets"]) => Venue["markets"],
    hedgeVenue?: HedgeVenue,
  ) => {
    const { venue } = makeVenue();
    const sent = { cancels: 0 };
    const counting: Venue = {
      ...placingOrdersThrough(venue, (trader, order) => venue.placeOrder(trader, order)),
      cancelAll: async () => (sent.cancels += 1),
      ...(marketsOf ? { markets: marketsOf(() => venue.markets()) } : {}),
    };
    const wiring = {
      venue: counting,
      botVenue: counting,
      botMarkets: [market],
      botSizes: async () => ({
        makerLevel: dollars(0.3),
        takerMin: 0n,
        takerMax: 0n,
        lotSize: dollars(0.001),
        takerStartingBase: 0n,
      }),
      afterMakersOpen: async () => {},
      needsFundingUpdater: false,
      liquidationTargets: () => [],
    } as unknown as VenueWiring;
    const config = loadConfig({
      VENUE: "memory",
      NOISE_TAKERS_ENABLED: "0",
      LIQUIDATOR_ENABLED: "0",
      DATA_DIR: join(ROOT, "opened"),
      ...over,
    });
    const problems = { onError: () => {}, onRecovered: () => {} };
    return { opened: openBots(config, wiring, problems, hedgeVenue), sent };
  };

  it("takes every maker's quotes off the venue when asked, and starts its loops after", async () => {
    const { opened, sent } = await openedWith(MARKETS[0], { HOUSE_MAKER_RISK_RULES: "1" });
    const bots = await opened;

    await bots.withdrawQuotes();
    expect(sent.cancels).toBe(1);

    const loops = bots.start();
    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) loop.stop();
  });

  it("is not ready to trade while the venue would refuse the maker's quotes, and ready again once it takes them", async () => {
    const stale = { why: "its mark is 90 s old (StalePrice, 6038): is the price crank running?" };
    const { opened } = await openedWith(
      MARKETS[0],
      { HOUSE_MAKER_RISK_RULES: "1", HOUSE_MAKER_TICK_MS: "20" },
      (real) => async () =>
        (await real()).map((info) =>
          stale.why ? { ...info, quotesRefusedBecause: stale.why } : info,
        ),
    );
    const bots = await opened;

    const loops = bots.start();
    try {
      await vi.waitFor(() => expect(bots.trading().reason).toContain("StalePrice"));

      stale.why = "";
      await vi.waitFor(() => expect(bots.trading()).toEqual({ ready: true }));
    } finally {
      for (const loop of loops) loop.stop();
    }
  });

  it("is not ready before any read of the markets has succeeded, and again after each wake", async () => {
    const { opened } = await openedWith(MARKETS[0], {
      HOUSE_MAKER_RISK_RULES: "1",
      HOUSE_MAKER_TICK_MS: "20",
    });
    const bots = await opened;
    expect(bots.trading().ready).toBe(false);
    expect(bots.trading().reason).toContain("has not been read yet");

    const first = bots.start();
    try {
      await vi.waitFor(() => expect(bots.trading()).toEqual({ ready: true }));
    } finally {
      for (const loop of first) loop.stop();
    }

    const second = bots.start();
    try {
      expect(bots.trading().reason).toContain("has not been read yet");
      await vi.waitFor(() => expect(bots.trading()).toEqual({ ready: true }));
    } finally {
      for (const loop of second) loop.stop();
    }
  });

  it("is not ready while a read of the markets never answers, and recovers once one does", async () => {
    vi.useFakeTimers();
    try {
      const hung = { on: true };
      const { opened } = await openedWith(
        MARKETS[0],
        { HOUSE_MAKER_RISK_RULES: "1", HOUSE_MAKER_TICK_MS: "20" },
        (real) => () => (hung.on ? new Promise<never>(() => {}) : real()),
      );
      const bots = await opened;
      const loops = bots.start();
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bots.trading().ready).toBe(false);
        expect(bots.trading().reason).toContain("could not be read");

        hung.on = false;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(bots.trading()).toEqual({ ready: true });
      } finally {
        for (const loop of loops) loop.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads trading readiness with no risk rules and so no maker ledger", async () => {
    const { opened } = await openedWith(MARKETS[0], { HOUSE_MAKER_TICK_MS: "20" });
    const bots = await opened;
    expect(bots.trading().ready).toBe(false);

    const loops = bots.start();
    try {
      await vi.waitFor(() => expect(bots.trading()).toEqual({ ready: true }));
    } finally {
      for (const loop of loops) loop.stop();
    }
  });

  it("reports nothing wrong asleep when no hedge position is open", async () => {
    const { opened } = await openedWith(MARKETS[0], { HOUSE_MAKER_RISK_RULES: "1" });
    const bots = await opened;
    expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
  });

  it("stays not ready asleep while an unmanaged hedge position is open", async () => {
    const dir = join(ROOT, "unmanaged");
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await (await MakerLedger.open(makerStatePath(dir, MARKETS[0].id))).update({ mode: "stopped" });
    const hedgeVenue = new FakeHedgeVenue();
    hedgeVenue.position = dollars(-1);
    const { opened } = await openedWith(
      MARKETS[0],
      {
        HOUSE_MAKER_RISK_RULES: "1",
        HEDGE_ENABLED: "1",
        HOUSE_MAKER_TICK_MS: "20",
        DATA_DIR: dir,
      },
      undefined,
      hedgeVenue,
    );
    const bots = await opened;
    expect(bots.tradingWhileAsleep().ready).toBe(false);

    const loops = bots.start();
    try {
      await vi.waitFor(() =>
        expect(bots.tradingWhileAsleep().reason).toContain("open hedge position"),
      );
    } finally {
      for (const loop of loops) loop.stop();
    }
    expect(bots.tradingWhileAsleep().reason).toContain("open hedge position");
  });

  describe("the last look at the hedge before sleep", () => {
    const hedgedBots = async (
      name: string,
      mode: "stopped" | "run",
      hedgeVenue: FakeHedgeVenue,
    ) => {
      const dir = join(ROOT, name);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await (await MakerLedger.open(makerStatePath(dir, MARKETS[0].id))).update({ mode });
      const { opened } = await openedWith(
        MARKETS[0],
        { HOUSE_MAKER_RISK_RULES: "1", HEDGE_ENABLED: "1", DATA_DIR: dir },
        undefined,
        hedgeVenue,
      );
      return opened;
    };

    it("is not ready asleep when the maker stopped with an open hedge that no tick has seen", async () => {
      const hedgeVenue = new FakeHedgeVenue();
      hedgeVenue.position = dollars(-1);
      const bots = await hedgedBots("sleep-open", "stopped", hedgeVenue);

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep().ready).toBe(false);
      expect(bots.tradingWhileAsleep().reason).toContain("open hedge position");
    });

    it("is not ready asleep when the last read of the hedge fails", async () => {
      const hedgeVenue = new FakeHedgeVenue();
      hedgeVenue.down = true;
      const bots = await hedgedBots("sleep-down", "stopped", hedgeVenue);

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep().ready).toBe(false);
      expect(bots.tradingWhileAsleep().reason).toContain("could not be confirmed");

      hedgeVenue.down = false;
      await bots.confirmHedgesBeforeSleep();
      expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
    });

    it("is ready asleep when the last read shows a flat hedge", async () => {
      const bots = await hedgedBots("sleep-flat", "stopped", new FakeHedgeVenue());

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
    });

    it("is not ready on a boot into sleep until the startup read has shown the hedge", async () => {
      const hedgeVenue = new FakeHedgeVenue();
      hedgeVenue.position = dollars(-1);
      const bots = await hedgedBots("boot-open", "stopped", hedgeVenue);
      expect(bots.tradingWhileAsleep().ready).toBe(false);

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep().reason).toContain("open hedge position");
    });

    it("is ready on a boot into sleep once the startup read shows a flat hedge", async () => {
      const bots = await hedgedBots("boot-flat", "stopped", new FakeHedgeVenue());
      expect(bots.tradingWhileAsleep().ready).toBe(false);

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
    });

    it("stays not ready on a boot into sleep while the hedge venue is down", async () => {
      const hedgeVenue = new FakeHedgeVenue();
      hedgeVenue.down = true;
      const bots = await hedgedBots("boot-down", "stopped", hedgeVenue);

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep().reason).toContain("could not be confirmed");
    });

    it("is ready asleep with no hedge configured, and reads nothing", async () => {
      const { opened } = await openedWith(MARKETS[0], { HOUSE_MAKER_RISK_RULES: "1" });
      const bots = await opened;

      await bots.confirmHedgesBeforeSleep();

      expect(bots.tradingWhileAsleep()).toEqual({ ready: true });
    });
  });

  it("refuses the risk rules on a market it has no reference price for", async () => {
    const { opened } = await openedWith(MARKETS[1], { HOUSE_MAKER_RISK_RULES: "1" });

    await expect(opened).rejects.toThrow("cannot cover NNVDA-PERP");
  });
});

describe("a house maker that stops or fails", () => {
  it("takes its quotes off, and a tick that was running places no more", async () => {
    const { warmUp, book, maker, venue, tick } = await rig("withdraw");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    book.beforePlacing = async () => {
      book.beforePlacing = null;
      await held;
    };
    const running = tick(11);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await maker.withdraw(venue);
    release();
    await running;

    expect(book.cancels).toBe(cancelsBefore + 2);
    expect(book.orders.length).toBeLessThanOrEqual(1);
  });

  it("falls back to the soft stop on an error it does not understand, cancels, and never retries the order", async () => {
    const { warmUp, book, tick, said, ledger } = await rig("unknown-error");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.failPlacing = new Error("the program answered something new");
    await expect(tick(11)).rejects.toThrow("something new");
    book.failPlacing = null;
    await tick(30);
    await tick(30);

    expect(ledger.state.mode).toBe("reduce");
    expect(ledger.state.reason).toBe("the program answered something new");
    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("does not understand");
    expect(said.alerts[0]).toContain("soft stop");
    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBeGreaterThanOrEqual(cancelsBefore + 2);
  });

  it("keeps quoting the side that shrinks its position after such an error, so users can still close", async () => {
    const { warmUp, book, tick, ledger } = await rig("unknown-error-position");
    book.position = dollars(0.5);
    await warmUp();
    book.take();

    book.failPlacing = new Error("the program answered something new");
    await expect(tick(11)).rejects.toThrow("something new");
    book.failPlacing = null;
    await tick();

    expect(ledger.state.mode).toBe("reduce");
    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(new Set(orders.map((order) => order.side))).toEqual(new Set(["sell"]));
  });

  describe("at the soft stop", () => {
    const failure = new Error("the program answered something new");

    /** A maker holding a position, at the soft stop after its first unknown error. */
    const softStopped = async (name: string) => {
      const made = await rig(name);
      made.book.position = dollars(0.5);
      await made.warmUp();
      made.book.take();
      made.book.failPlacing = failure;
      await expect(made.tick(11)).rejects.toThrow("something new");
      expect(made.ledger.state.mode).toBe("reduce");
      return made;
    };

    it("stays there when the error comes a second time, and keeps trying the reducing side", async () => {
      const { book, tick, said, ledger } = await softStopped("unknown-error-twice");

      await expect(tick()).rejects.toThrow("something new");
      await expect(tick()).rejects.toThrow("something new");
      book.failPlacing = null;
      await tick();

      expect(ledger.state.mode).toBe("reduce");
      expect(said.alerts).toHaveLength(1);
      expect(said.notices.join("\n")).toContain("2 in a row. It stops quoting altogether at 5.");
      expect(sidesOf(book.take())).toEqual(new Set(["sell"]));
    });

    it("stops altogether at the fifth error in a row, and says users cannot close", async () => {
      const { book, tick, said, ledger } = await softStopped("unknown-error-five");

      for (let error = 1; error <= 4; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
        expect(ledger.state.mode).toBe("reduce");
      }
      await expect(tick()).rejects.toThrow("something new");
      book.failPlacing = null;
      await tick(30);
      await tick(30);

      expect(ledger.state.mode).toBe("stopped");
      expect(said.alerts).toHaveLength(2);
      expect(said.alerts[1]).toContain("nobody can close a position against it");
      expect(book.orders).toHaveLength(0);
    });

    it("starts the count again after a good requote", async () => {
      const { book, tick, ledger } = await softStopped("unknown-error-reset");
      for (let error = 1; error <= 4; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
      }

      book.failPlacing = null;
      await tick();
      expect(book.take().length).toBeGreaterThan(0);
      book.failPlacing = failure;
      await expect(tick(11)).rejects.toThrow("something new");
      for (let error = 1; error <= 3; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
      }

      expect(ledger.state.mode).toBe("reduce");
    });

    it("counts the same way when an operator put it there with the kill switch", async () => {
      const { warmUp, book, dir, clock, tick, ledger } = await rig("unknown-error-kill-switch");
      book.position = dollars(0.5);
      await warmUp();
      await requestMode(dir, "reduce", clock.nowMs() + 1);
      await tick();
      book.take();

      book.failPlacing = failure;
      await expect(tick(11)).rejects.toThrow("something new");
      for (let error = 1; error <= 3; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
      }

      expect(ledger.state.mode).toBe("reduce");
      await expect(tick()).rejects.toThrow("something new");
      expect(ledger.state.mode).toBe("stopped");
    });

    it("forgets the count when an operator resumes it", async () => {
      const { book, dir, clock, tick, ledger } = await softStopped("unknown-error-resume");
      for (let error = 1; error <= 4; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
      }

      await requestMode(dir, "run", clock.nowMs() + 1);
      book.failPlacing = null;
      await tick(60);
      book.failPlacing = failure;
      await expect(tick(11)).rejects.toThrow("something new");
      for (let error = 1; error <= 4; error += 1) {
        await expect(tick()).rejects.toThrow("something new");
      }

      expect(ledger.state.mode).toBe("reduce");
    });
  });

  it("does not stop when the venue is only still starting", async () => {
    const { warmUp, book, tick, ledger } = await rig("venue-starting");
    await warmUp();
    book.take();

    book.failPlacing = new VenueNotReady("the service is still starting, try again");
    await expect(tick(11)).rejects.toThrow("still starting");

    expect(ledger.state.mode).toBe("run");
  });

  it("does not stop for a post-only order that would have crossed, but sends no heartbeat and tries again", async () => {
    let beats = 0;
    const { warmUp, book, tick, ledger } = await rig("refused-crossing", {
      afterRequote: () => (beats += 1),
    });
    book.rejecting = "post-only order would match";
    await warmUp();

    await tick(11);

    expect(book.rejectedCount).toBeGreaterThan(0);
    expect(ledger.state.mode).toBe("run");
    expect(beats).toBe(0);

    book.rejecting = null;
    await tick();
    expect(book.orders.length).toBeGreaterThan(0);
    expect(beats).toBe(1);
  });

  it("falls back to the soft stop when the venue refuses an order for a reason it does not know, and sends no heartbeat", async () => {
    let beats = 0;
    const { warmUp, book, tick, ledger, said } = await rig("refused-unknown", {
      afterRequote: () => (beats += 1),
    });
    await warmUp();
    book.take();
    const beatsBefore = beats;
    const cancelsBefore = book.cancels;

    book.rejecting = "the program answered something new";
    await expect(tick(11)).rejects.toThrow("order refused by the venue");
    book.rejecting = null;
    await tick(30);
    await tick(30);

    expect(ledger.state.mode).toBe("reduce");
    expect(ledger.state.reason).toContain("something new");
    expect(said.alerts).toHaveLength(1);
    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBeGreaterThanOrEqual(cancelsBefore + 2);
    expect(beats).toBe(beatsBefore);
  });

  it("falls back to the soft stop when the venue gives no reason for a refusal", async () => {
    const { warmUp, book, tick, ledger } = await rig("refused-no-reason");
    await warmUp();

    book.rejecting = "";
    await expect(tick(11)).rejects.toThrow("order refused by the venue");

    expect(ledger.state.mode).toBe("reduce");
  });

  it("tries a failed cancel again on the next tick instead of stopping, since a cancel only removes risk", async () => {
    const { warmUp, book, tick, ledger } = await rig("cancel-fails");
    await warmUp();
    book.take();

    book.failCancelling = new Error("the rollup did not answer");
    await expect(tick(11)).rejects.toThrow("did not answer");
    expect(book.orders).toHaveLength(0);
    expect(ledger.state.mode).toBe("run");

    book.failCancelling = null;
    await tick();
    expect(book.orders.length).toBeGreaterThan(0);
  });
});

const SKEW_SHAPE = {
  market: PERP,
  levels: 1,
  spreadBps: 15,
  levelStepBps: 5,
  baseSizePerLevel: 1n,
  maxSkewBps: 20,
  lotSize: 1n,
};

const sidesOf = (orders: NewOrder[]): Set<string> => new Set(orders.map((order) => order.side));

describe("a house maker past a loss limit flattens its position", () => {
  /** A maker holding `position`, whose equity has just dropped 3.1% on the day. */
  const breached = async (
    name: string,
    position: bigint,
    over: Partial<HouseMakerOptions> = {},
  ) => {
    const made = await rig(name, over);
    made.book.position = position;
    await made.warmUp();
    made.book.take();
    made.book.equity = dollars(969);
    await made.tick(11);
    return made;
  };

  it("sells a long position with one reduce-only order, a bounded 25 bps through the reference", async () => {
    const { book, ledger, said } = await breached("flatten-long", dollars(0.5));

    expect(ledger.state.mode).toBe("flatten");
    expect(book.take()).toEqual([
      {
        market: PERP,
        side: "sell",
        type: "limit",
        price: dollars(149.63),
        size: dollars(0.5),
        reduceOnly: true,
        expiresInSeconds: 20,
        expiresAtMs: expect.any(Number),
      },
    ]);
    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("reduces it toward flat with reduce-only orders");
    expect(said.alerts[0]).toContain("it stops quoting altogether and users cannot close");
  });

  it("buys back a short position the same way", async () => {
    const { book } = await breached("flatten-short", -dollars(0.5));

    expect(book.take()).toEqual([
      expect.objectContaining({
        side: "buy",
        type: "limit",
        price: dollars(150.37),
        size: dollars(0.5),
        reduceOnly: true,
      }),
    ]);
  });

  it("builds the order from the whole position and never from a price further than the bound", () => {
    const shape = { market: PERP, lotSize: dollars(0.001) };
    const flat = { centre: dollars(150), tickSize: dollars(0.01), giveBps: 25 };

    expect(flattenOrders(shape, { ...flat, position: 0n })).toEqual([]);
    expect(flattenOrders(shape, { ...flat, position: dollars(0.0004) })).toEqual([]);
    const [sell] = flattenOrders(shape, { ...flat, position: dollars(1.2345678) });
    expect(sell.size).toBe(dollars(1.234));
    expect(sell.price ?? 0n).toBeGreaterThanOrEqual(dollars(150 * (1 - 0.0025)));
    const [buy] = flattenOrders(shape, { ...flat, position: -dollars(1) });
    expect(buy.price ?? 0n).toBeLessThanOrEqual(dollars(150 * (1 + 0.0025)));
  });

  it("follows the fresh reference with each requote", async () => {
    const { book, feed, tick } = await breached("flatten-follows", dollars(0.5));
    book.take();

    feed.reference = { ok: true, price: dollars(150.5) };
    await tick(11);

    expect(book.take()).toEqual([
      expect.objectContaining({ side: "sell", price: dollars(150.13), reduceOnly: true }),
    ]);
  });

  it("never chases a stale reference, disagreeing sources or a market that has run away", async () => {
    const { book, feed, tick, said } = await breached("flatten-no-chase", dollars(0.5));
    book.take();
    const cancelsBefore = book.cancels;

    feed.reference = { ok: false, reason: "the price sources are 41.0 bps apart" };
    await tick(11);
    await tick(11);
    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBe(cancelsBefore + 1);
    expect(said.notices.join()).toContain("41.0 bps apart");

    feed.reference = { ok: true, price: dollars(150) };
    book.mark = dollars(150 * (1 - 0.012));
    await tick(11);
    await tick(11);
    expect(book.orders).toHaveLength(0);

    book.mark = dollars(150);
    await tick(11);
    expect(book.take()).toHaveLength(1);
  });

  it("stops altogether when the loss passes the second limit, and says users cannot close", async () => {
    const { book, ledger, said, tick } = await breached("flatten-second-limit", dollars(0.5));
    book.take();
    const cancelsBefore = book.cancels;

    book.equity = dollars(939);
    await tick();
    await tick(30);

    expect(ledger.state.mode).toBe("stopped");
    expect(said.alerts).toHaveLength(2);
    expect(said.alerts[1]).toContain(
      "while it was reducing its position, it lost 61.00 nUSD today, 6% of the 1000.00",
    );
    expect(said.alerts[1]).toContain("nobody can close a position against it");
    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBe(cancelsBefore + 1);
  });

  it("stops altogether on a 10% drawdown from the peak while it is flattening", async () => {
    const { warmUp, book, ledger, said, tick } = await rig("flatten-drawdown");
    book.position = dollars(0.5);
    await warmUp();
    book.equity = dollars(1_100);
    await tick();

    book.equity = dollars(1_040);
    await tick();
    expect(ledger.state.mode).toBe("flatten");

    book.equity = dollars(989);
    await tick();
    expect(ledger.state.mode).toBe("stopped");
    expect(said.alerts[1]).toContain("it is 111.00 nUSD below its peak of 1100.00, 10% or more");
  });

  it("stops altogether when it still holds a position ten minutes after it began", async () => {
    const { ledger, said, tick, book } = await breached("flatten-deadline", dollars(0.5));
    book.take();

    await tick(300);
    expect(ledger.state.mode).toBe("flatten");
    await tick(301);

    expect(ledger.state.mode).toBe("stopped");
    expect(said.alerts[1]).toContain("it still held a position 10 minutes after it began");
    expect(said.alerts[1]).toContain("nobody can close a position against it");
  });

  it("does not stop for the deadline once the position is flat", async () => {
    const { ledger, tick, book } = await breached("flatten-flat", dollars(0.5));
    book.take();
    book.position = 0n;

    await tick(700);

    expect(ledger.state.mode).toBe("flatten");
    expect(book.take()).toEqual([]);
  });

  it("stops altogether when its order fails, which is a flattening that is not working", async () => {
    const made = await rig("flatten-fails");
    made.book.position = dollars(0.5);
    await made.warmUp();
    made.book.take();

    made.book.equity = dollars(969);
    made.book.failPlacing = new Error("the program answered something new");
    await expect(made.tick(11)).rejects.toThrow("something new");

    expect(made.ledger.state.mode).toBe("stopped");
    expect(made.said.alerts).toHaveLength(2);
    expect(made.said.alerts[1]).toContain("nobody can close a position against it");
  });

  it("carries on when a user filled the position first and the order has nothing left to reduce", async () => {
    const made = await rig("flatten-race");
    made.book.position = dollars(0.5);
    await made.warmUp();
    made.book.take();

    made.book.equity = dollars(969);
    made.book.rejecting = "reduce-only: no position to reduce";
    await made.tick(11);

    expect(made.ledger.state.mode).toBe("flatten");
    expect(made.book.rejectedCount).toBe(1);
  });

  it("counts a loss at the reference price when the venue's mark lags behind it", async () => {
    const { warmUp, book, feed, tick, ledger, said } = await rig("loss-at-reference");
    book.position = dollars(20);
    await warmUp();

    feed.reference = { ok: true, price: dollars(148.4) };
    await tick(11);

    expect(ledger.state.mode).toBe("flatten");
    expect(said.alerts[0]).toContain("it lost 32.00 nUSD today");
  });

  it("values the seat at the worse of the mark and the reference price", () => {
    const equity = dollars(1_000);
    const mark = dollars(150);

    expect(worstEquity(equity, dollars(20), mark, dollars(148.4))).toBe(dollars(968));
    expect(worstEquity(equity, dollars(20), mark, dollars(152))).toBe(equity);
    expect(worstEquity(equity, -dollars(20), mark, dollars(151))).toBe(dollars(980));
    expect(worstEquity(equity, 0n, mark, dollars(100))).toBe(equity);
  });

  it("is not stopped by the loss limit alone, so users can still trade against what it quotes", async () => {
    const { ledger, book, tick } = await breached("flatten-not-stopped", dollars(0.5));
    book.take();

    await tick(11);

    expect(ledger.state.mode).toBe("flatten");
    expect(book.take().length).toBe(1);
  });

  describe("while the reference price is down", () => {
    const DOWN: Reference = { ok: false, reason: "the price sources are 41.0 bps apart" };

    it("counts the escalation rails at the last good reference price, not at the stale mark", async () => {
      const { warmUp, book, feed, tick, ledger, said } = await rig("blind-last-good");
      book.position = dollars(20);
      await warmUp();
      feed.reference = { ok: true, price: dollars(148.4) };
      await tick(11);
      expect(ledger.state.mode).toBe("flatten");

      feed.reference = DOWN;
      book.equity = dollars(950);
      await tick();

      expect(ledger.state.mode).toBe("stopped");
      expect(said.alerts[1]).toContain(
        "while it was reducing its position, it lost 82.00 nUSD today, 6% of the 1000.00",
      );
    });

    it("keeps the ten minute deadline while a good reference price is under an hour old", async () => {
      const { ledger, feed, tick } = await breached("blind-recent", dollars(0.5));

      feed.reference = DOWN;
      await tick(200);
      await tick(200);
      expect(ledger.state.mode).toBe("flatten");
      await tick(250);

      expect(ledger.state.mode).toBe("stopped");
    });

    it("counts at the worse of the mark and an older good reference price, and gives a flattening three minutes", async () => {
      const { warmUp, book, feed, tick, ledger, said } = await rig("blind-old-reference");
      book.position = dollars(20);
      await warmUp();
      feed.reference = { ok: true, price: dollars(148.8) };
      await tick();
      expect(ledger.state.mode).toBe("run");

      feed.reference = DOWN;
      book.equity = dollars(985);
      await tick(3_601);
      expect(ledger.state.mode).toBe("flatten");
      expect(said.alerts[0]).toContain("it lost 39.00 nUSD today");

      await tick(120);
      expect(ledger.state.mode).toBe("flatten");
      await tick(61);

      expect(ledger.state.mode).toBe("stopped");
      expect(said.alerts[1]).toContain(
        "it still held a position 3 minutes after it began to reduce it, with no good reference price in the last hour",
      );
    });

    it("counts at the mark and gives a flattening three minutes when there never was a good price", async () => {
      const { book, feed, tick, ledger, said } = await rig("blind-never-good");
      feed.reference = DOWN;
      book.position = dollars(0.5);
      await tick();

      book.equity = dollars(969);
      await tick();
      expect(ledger.state.mode).toBe("flatten");
      await tick(120);
      expect(ledger.state.mode).toBe("flatten");
      await tick(61);

      expect(ledger.state.mode).toBe("stopped");
      expect(said.alerts[1]).toContain("3 minutes after it began to reduce it");
    });
  });

  describe("across the turn of the UTC day", () => {
    const flatteningBeforeMidnight = async (name: string) => {
      const made = await rig(name);
      made.book.position = dollars(0.5);
      await made.warmUp();
      made.clock.set(Date.parse("2026-11-02T23:54:00Z"));
      made.book.equity = dollars(945);
      await made.tick();
      expect(made.ledger.state.mode).toBe("flatten");
      made.clock.set(Date.parse("2026-11-03T00:01:00Z"));
      return made;
    };

    it("keeps the day's starting equity while it flattens a position, so the 6% line holds", async () => {
      const { book, tick, ledger, said } = await flatteningBeforeMidnight("flatten-midnight");

      book.equity = dollars(935);
      await tick();

      expect(ledger.state.day).toBe("2026-11-02");
      expect(ledger.state.dayStartEquity).toBe(dollars(1_000));
      expect(ledger.state.mode).toBe("stopped");
      expect(said.alerts[1]).toContain("it lost 65.00 nUSD today, 6% of the 1000.00");
    });

    it("starts the new day's count once the position is flat", async () => {
      const { book, tick, ledger } = await flatteningBeforeMidnight("flatten-midnight-flat");

      book.position = 0n;
      await tick();

      expect(ledger.state.day).toBe("2026-11-03");
      expect(ledger.state.dayStartEquity).toBe(dollars(945));
    });

    it("starts the new day's count when an operator resumes it", async () => {
      const { dir, clock, tick, ledger } =
        await flatteningBeforeMidnight("flatten-midnight-resume");

      await requestMode(dir, "run", clock.nowMs() + 1);
      await tick();

      expect(ledger.state.mode).toBe("run");
      expect(ledger.state.dayStartEquity).toBe(dollars(945));
    });
  });

  describe("once it is flat", () => {
    it("says in the breach alert that it then stays dark until an operator resumes it", async () => {
      const { said } = await breached("flatten-dark-text", dollars(0.5));

      expect(said.alerts[0]).toContain(
        "Once it is flat it quotes nothing and stays dark until an operator resumes it",
      );
      expect(said.alerts[0]).toContain('run the kill switch with "resume"');
    });

    it("ends the flattening with one ALERT that says quoting is off until resumed, and quotes again after a resume", async () => {
      const { book, tick, said, ledger, dir, clock } = await breached("flatten-done", dollars(0.5));
      book.take();

      book.position = 0n;
      await tick(11);
      await tick(11);

      expect(said.alerts).toHaveLength(2);
      expect(said.alerts[1]).toContain("reduced its position to flat");
      expect(said.alerts[1]).toContain("quotes nothing");
      expect(said.alerts[1]).toContain("until an operator resumes it");
      expect(said.alerts[1]).toContain('run the kill switch with "resume"');
      expect(ledger.state.mode).toBe("flatten");
      expect(book.take()).toEqual([]);

      await requestMode(dir, "run", clock.nowMs() + 1);
      await tick();
      for (let second = 0; second < 10; second += 1) await tick();
      expect(ledger.state.mode).toBe("run");
      expect(book.orders.length).toBeGreaterThan(0);
    });

    it("does not announce it while a position is still being worked down", async () => {
      const { tick, said } = await breached("flatten-not-done", dollars(0.5));

      await tick(11);
      await tick(11);

      expect(said.alerts).toHaveLength(1);
    });
  });

  it("keeps the first limit's alert to one line", async () => {
    const { said, tick } = await breached("flatten-one-alert", dollars(0.5));

    await tick(11);
    await tick(11);

    expect(said.alerts).toHaveLength(1);
  });
});

describe("the heartbeat of a maker that is not quoting freely", () => {
  it("is not sent while a loss limit, the soft stop or a reduce-only market has it reducing", async () => {
    let beats = 0;
    const { warmUp, book, dir, clock, tick } = await rig("beat-limited", {
      afterRequote: () => (beats += 1),
    });
    book.position = dollars(0.5);
    await warmUp();
    expect(beats).toBe(1);

    book.refusedBecause = "the market takes reduce-only orders alone (MarketReduceOnly, 6032)";
    book.takesReduceOnly = true;
    await tick(11);
    book.refusedBecause = null;
    book.takesReduceOnly = false;
    expect(beats).toBe(1);

    await tick(11);
    expect(beats).toBe(2);

    await requestMode(dir, "reduce", clock.nowMs() + 1);
    await tick(11);
    await tick(11);
    expect(beats).toBe(2);

    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick(11);
    expect(beats).toBe(3);

    book.equity = dollars(960);
    await tick(11);
    await tick(11);
    await tick(11);
    expect(beats).toBe(3);
  });
});

describe("the kill switch's two stops", () => {
  it("refuses the hard stop unless it is confirmed, and says what it does", () => {
    const refused = killSwitchRequest(["stop"]);

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.message).toContain("nobody can close a position against it");
    expect(refused.message).toContain(CONFIRM_STOP_FLAG);
    expect(refused.message).toContain('use "reduce"');
  });

  it("writes the hard stop when it is confirmed, and names the consequence", () => {
    const request = killSwitchRequest(["stop", CONFIRM_STOP_FLAG]);

    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(request.mode).toBe("stopped");
    expect(request.meaning).toContain("nobody can close a position against it");
  });

  it("takes the soft stop and the resume without a confirmation, and nothing else", () => {
    expect(killSwitchRequest(["reduce"])).toMatchObject({ ok: true, mode: "reduce" });
    expect(killSwitchRequest(["resume"])).toMatchObject({ ok: true, mode: "run" });
    expect(killSwitchRequest(["reduce", CONFIRM_STOP_FLAG]).ok).toBe(false);
    expect(killSwitchRequest(["stop", "--yes"]).ok).toBe(false);
    expect(killSwitchRequest(["halt"]).ok).toBe(false);
    expect(killSwitchRequest([]).ok).toBe(false);
  });

  it("does not accept a flatten request from the control file, which is the maker's own answer to a loss", async () => {
    const { warmUp, dir, tick, ledger } = await rig("kill-flatten-request");
    await warmUp();

    await writeFile(controlPath(dir), JSON.stringify({ mode: "flatten", requestedAtMs: 1e15 }));
    await tick();

    expect(ledger.state.mode).toBe("reduce");
  });
});

describe("a control file that cannot be read", () => {
  it("holds the maker at the soft stop, and a file that parses again does not release it", async () => {
    const { warmUp, book, dir, tick, ledger, said, clock } = await rig("control-damaged");
    book.position = dollars(0.5);
    await warmUp();
    book.take();

    await writeFile(controlPath(dir), "garbage");
    await tick(11);

    expect(ledger.state.mode).toBe("reduce");
    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("maker control file");
    expect(said.alerts[0]).toContain("soft stop");
    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(sidesOf(orders)).toEqual(new Set(["sell"]));

    await tick(11);
    await tick(11);
    expect(said.alerts).toHaveLength(1);

    await writeFile(controlPath(dir), JSON.stringify({ mode: "run", requestedAtMs: 0 }));
    await tick(11);
    await tick(11);
    expect(ledger.state.mode).toBe("reduce");
    expect(sidesOf(book.take())).toEqual(new Set(["sell"]));

    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick();
    expect(ledger.state.mode).toBe("run");
  });

  it("keeps the hard stop and the flattening it found, rather than loosening them", async () => {
    const stopped = await rig("control-damaged-stopped");
    await stopped.warmUp();
    await requestMode(stopped.dir, "stopped", stopped.clock.nowMs() + 1);
    await stopped.tick();
    await writeFile(controlPath(stopped.dir), "garbage");
    await stopped.tick(11);
    expect(stopped.ledger.state.mode).toBe("stopped");
    expect(stopped.said.alerts).toHaveLength(1);

    const flattening = await rig("control-damaged-flatten");
    flattening.book.position = dollars(0.5);
    await flattening.warmUp();
    flattening.book.equity = dollars(969);
    await flattening.tick(11);
    await writeFile(controlPath(flattening.dir), "garbage");
    await flattening.tick(11);
    expect(flattening.ledger.state.mode).toBe("flatten");
    expect(flattening.said.alerts).toHaveLength(1);
  });
});

describe("a maker whose market is reduce-only", () => {
  const REDUCE_ONLY = "the market takes reduce-only orders alone (MarketReduceOnly, 6032)";

  it("keeps quoting the side that shrinks its position, flagged reduce-only, and cancels what grows it", async () => {
    const { warmUp, book, tick } = await rig("venue-reduce-only");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.refusedBecause = REDUCE_ONLY;
    book.takesReduceOnly = true;
    await tick();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(sidesOf(orders)).toEqual(new Set(["sell"]));
    expect(orders.every((order) => order.reduceOnly === true)).toBe(true);
    expect(orders.reduce((sum, order) => sum + order.size, 0n)).toBeLessThanOrEqual(dollars(0.5));
    expect(book.cancels).toBe(cancelsBefore + 1);
  });

  it("buys for a short position", async () => {
    const { warmUp, book, tick } = await rig("venue-reduce-only-short");
    book.position = -dollars(0.5);
    await warmUp();
    book.take();

    book.refusedBecause = REDUCE_ONLY;
    book.takesReduceOnly = true;
    await tick();

    const orders = book.take();
    expect(sidesOf(orders)).toEqual(new Set(["buy"]));
    expect(orders.every((order) => order.reduceOnly === true)).toBe(true);
  });

  it("quotes nothing when it is flat, but takes its standing quotes off", async () => {
    const { warmUp, book, tick } = await rig("venue-reduce-only-flat");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.refusedBecause = REDUCE_ONLY;
    book.takesReduceOnly = true;
    await tick();

    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBe(cancelsBefore + 1);
  });

  it("goes back to both sides when the market opens again", async () => {
    const { warmUp, book, tick } = await rig("venue-reopens");
    book.position = dollars(0.5);
    await warmUp();
    book.refusedBecause = REDUCE_ONLY;
    book.takesReduceOnly = true;
    await tick();
    book.take();

    book.refusedBecause = null;
    book.takesReduceOnly = false;
    await tick();

    expect(sidesOf(book.take())).toEqual(new Set(["buy", "sell"]));
  });

  it("still holds back, sending nothing, when the market is refused for any other reason", async () => {
    const { warmUp, book, tick } = await rig("venue-paused");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.refusedBecause = "the market is paused (MarketPaused, 6031)";
    await expect(tick()).rejects.toThrow(QuotesHeld);

    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBe(cancelsBefore);
  });

  it("does the same without the risk rules", async () => {
    const book = new Book();
    book.position = dollars(0.5);
    book.refusedBecause = REDUCE_ONLY;
    book.takesReduceOnly = true;
    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 2,
      spreadBps: 15,
      levelStepBps: 5,
      baseSizePerLevel: dollars(0.3),
      requoteThresholdBps: 6,
      requoteIntervalMs: 10_000,
      positionLimitNotional: dollars(250),
      maxSkewBps: 20,
      lotSize: dollars(0.001),
      startingQuoteBalance: dollars(1_000),
      startingBaseBalance: 0n,
      clock: new ManualClock(START_MS),
    });

    await maker.tick(book.asVenue());

    const orders = book.take();
    expect(sidesOf(orders)).toEqual(new Set(["sell"]));
    expect(orders.every((order) => order.reduceOnly === true)).toBe(true);
  });
});

describe("the position limit counts the position and every resting level together", () => {
  const SHAPE = {
    market: PERP,
    levels: 3,
    spreadBps: 15,
    levelStepBps: 5,
    baseSizePerLevel: dollars(0.3),
    maxSkewBps: 20,
    lotSize: dollars(0.001),
  };
  const sum = (orders: NewOrder[], side: NewOrder["side"]): bigint =>
    orders.filter((order) => order.side === side).reduce((total, order) => total + order.size, 0n);
  const at = (position: number, limit: number) => ({
    mark: dollars(150),
    tickSize: dollars(0.01),
    position: dollars(position),
    positionLimit: dollars(limit),
  });

  it("sends one cut level, not three whole ones, from a position just under the limit", () => {
    const orders = ladderOrders(SHAPE, at(1.66, 1.667));

    expect(orders.filter((order) => order.side === "buy").map((order) => order.size)).toEqual([
      dollars(0.007),
    ]);
    expect(sum(orders, "sell")).toBe(dollars(0.9));
  });

  it("cuts the level that would pass the limit and leaves out the ones after it", () => {
    const orders = ladderOrders(SHAPE, at(0, 0.5));

    expect(orders.filter((order) => order.side === "buy").map((order) => order.size)).toEqual([
      dollars(0.3),
      dollars(0.2),
    ]);
    expect(orders.filter((order) => order.side === "sell").map((order) => order.size)).toEqual([
      dollars(0.3),
      dollars(0.2),
    ]);
  });

  it("never lets the position plus a side's resting levels pass the limit, whatever the position", () => {
    const limit = 1.667;
    for (const position of [-2, -1.66, -0.4, 0, 0.4, 1.66, 1.667, 2]) {
      const orders = ladderOrders(SHAPE, at(position, limit));
      const grown = dollars(position) + sum(orders, "buy");
      const shrunk = dollars(position) - sum(orders, "sell");
      expect(grown).toBeLessThanOrEqual(dollars(Math.max(limit, position)));
      expect(shrunk).toBeGreaterThanOrEqual(dollars(Math.min(-limit, position)));
    }
  });

  it("quotes no more buying at the limit, and all three levels of selling", () => {
    const orders = ladderOrders(SHAPE, at(1.667, 1.667));

    expect(sidesOf(orders)).toEqual(new Set(["sell"]));
    expect(orders).toHaveLength(3);
  });
});

describe("the maker's state file from before the flattening existed", () => {
  it("opens, with no flattening in progress", async () => {
    const dir = join(ROOT, "old-state");
    await mkdir(dir, { recursive: true });
    await writeFile(
      makerStatePath(dir, PERP),
      JSON.stringify({
        mode: "reduce",
        reason: "the kill switch stopped its growth",
        day: "2026-11-02",
        dayStartEquity: "1000000000",
        peakEquity: "1000000000",
        lastCommandAtMs: 5,
        spotBaseAtStart: null,
      }),
    );

    const ledger = await MakerLedger.open(makerStatePath(dir, PERP));

    expect(ledger.state.mode).toBe("reduce");
    expect(ledger.state.flattenStartedAtMs).toBeNull();
  });
});

describe("an order whose outcome is unknown", () => {
  it("holds the maker until the unknown order's own expiry has passed, though the cancel works and the seat is empty", async () => {
    const { warmUp, book, tick, maker } = await rig("unknown-window");
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    expect(maker.quarantinedSinceMs).not.toBeNull();

    book.unknownBecause = null;
    await tick(5);
    await tick(5);
    expect(book.take()).toEqual([]);
    expect(maker.quarantinedSinceMs).not.toBeNull();

    await tick(11);
    expect(maker.quarantinedSinceMs).not.toBeNull();
    expect(book.take()).toEqual([]);

    await tick(40);
    expect(maker.quarantinedSinceMs).toBeNull();
    expect(book.take().length).toBeGreaterThan(0);
  });

  it("still acts on a loss breach while held, flattening with reduce-only orders only", async () => {
    const { warmUp, book, tick, ledger } = await rig("unknown-loss");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;

    book.equity = dollars(969);
    await tick(1);

    expect(ledger.state.mode).toBe("flatten");
    const placed = book.take();
    expect(placed.length).toBeGreaterThan(0);
    expect(placed.every((order) => order.reduceOnly === true)).toBe(true);
  });

  it("still acts on a loss breach while held and the reconcile keeps failing", async () => {
    const { warmUp, book, tick, ledger } = await rig("unknown-loss-failing");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;
    book.failCancelling = new Error("the venue is away");

    book.equity = dollars(969);
    await expect(tick(1)).rejects.toThrow("the venue is away");

    expect(ledger.state.mode).toBe("flatten");
  });

  it("obeys a hard-stop command while held", async () => {
    const { warmUp, book, tick, ledger, dir, clock, said } = await rig("unknown-kill");
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;

    await requestMode(dir, "stopped", clock.nowMs() + 1);
    await tick(1);

    expect(ledger.state.mode).toBe("stopped");
    expect(said.alerts.some((line) => line.includes("the kill switch stopped it"))).toBe(true);
    expect(book.take()).toEqual([]);
  });

  it("reaches the alert sink when the reconcile keeps failing", async () => {
    const { warmUp, book, tick, maker, clock, said } = await rig("unknown-persistent");
    const watch = new TradingWatch(
      () =>
        maker.quarantinedSinceMs === null
          ? { ready: true }
          : { ready: false, reason: "NSOL-PERP maker is held by an order of unknown outcome" },
      voiceOf(said),
      clock,
    );
    watch.check();
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    watch.check();
    expect(said.alerts).toHaveLength(1);

    book.unknownBecause = null;
    book.failCancelling = new Error("the venue is away");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(tick(30)).rejects.toThrow("the venue is away");
      watch.check();
    }

    expect(said.alerts.some((line) => line.includes("has not been ready for"))).toBe(true);
  });

  it.each([
    ["a routine-looking", "post-only order would match"],
    ["a non-routine", "the connection dropped"],
  ])(
    "takes the quotes off and holds the maker, whatever %s reason it carries",
    async (_, reason) => {
      const { warmUp, book, tick, ledger } = await rig(`unknown-${reason.length}`);
      await warmUp();
      book.take();
      const cancelsBefore = book.cancels;
      book.unknownBecause = reason;

      await expect(tick(11)).rejects.toThrow("outcome unknown");

      expect(book.cancels).toBeGreaterThan(cancelsBefore);
      expect(ledger.state.mode).toBe("run");

      book.unknownBecause = null;
      book.failCancelling = new Error("the venue is away");
      await expect(tick(11)).rejects.toThrow("the venue is away");
      expect(book.take()).toEqual([]);

      book.failCancelling = null;
      await tick(11);
      await tick(40);
      expect(book.take().length).toBeGreaterThan(0);
    },
  );
});

describe("every order of a reduce-only plan carries the reduce-only flag", () => {
  it("flags the soft stop's orders, so a fill between the position read and the order cannot flip it", async () => {
    const { warmUp, book, dir, clock, tick, ledger } = await rig("reduce-flag-race");
    book.position = dollars(0.5);
    book.refusesReduceOnlyWhenFlat = true;
    await warmUp();
    book.take();

    await requestMode(dir, "reduce", clock.nowMs() + 1);
    book.beforePlacing = async () => {
      book.position = 0n;
    };
    await tick();

    expect(book.orders).toHaveLength(0);
    expect(book.rejectedCount).toBeGreaterThan(0);
    expect(ledger.state.mode).toBe("reduce");
  });

  it("flags them when no race happens either", async () => {
    const { warmUp, book, dir, clock, tick } = await rig("reduce-flag-plain");
    book.position = dollars(0.5);
    await warmUp();
    book.take();

    await requestMode(dir, "reduce", clock.nowMs() + 1);
    await tick();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => order.reduceOnly === true)).toBe(true);
  });
});

describe("a maker whose state cannot be saved fails closed", () => {
  /** A directory where the state file goes: the temporary file is written, but the rename onto it fails. */
  const breakWrites = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    await rm(makerStatePath(dir, PERP), { force: true });
    await mkdir(makerStatePath(dir, PERP));
  };
  const repairWrites = (dir: string) => rm(makerStatePath(dir, PERP), { recursive: true });
  const markerOf = (dir: string) => `${makerStatePath(dir, PERP)}.failed`;
  /** A marker path that cannot be checked: a link that points at itself. */
  const unreadableMarker = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    await rm(markerOf(dir), { recursive: true, force: true });
    await symlink(basename(markerOf(dir)), markerOf(dir));
  };

  it("cancels its quotes at once, and stays stopped on later ticks", async () => {
    const { warmUp, book, dir, tick, ledger } = await rig("persist-fails");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    await breakWrites(dir);
    book.equity = dollars(969);
    await expect(tick(11)).rejects.toThrow(StatePersistenceError);

    expect(book.cancels).toBe(cancelsBefore + 1);
    expect(ledger.state.mode).toBe("stopped");
    book.equity = dollars(1_000);
    await tick(30);
    expect(book.orders).toHaveLength(0);
    expect(ledger.state.mode).toBe("stopped");
  });

  it("starts a restarted maker stopped, and only an explicit resume clears that", async () => {
    const { warmUp, book, dir, clock, tick, open, venue } = await rig("persist-restart");
    await warmUp();
    book.take();
    await breakWrites(dir);
    book.equity = dollars(969);
    await expect(tick(11)).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);

    const restarted = await open();
    expect(restarted.ledger.state.mode).toBe("stopped");
    book.equity = dollars(1_000);
    clock.advance(30_000);
    await restarted.maker.tick(venue);
    expect(restarted.ledger.state.mode).toBe("stopped");
    expect(book.orders).toHaveLength(0);

    await requestMode(dir, "run", clock.nowMs() + 1);
    clock.advance(1_000);
    await restarted.maker.tick(venue);
    expect(restarted.ledger.state.mode).toBe("run");
    const again = await MakerLedger.open(makerStatePath(dir, PERP));
    expect(again.state.mode).toBe("run");
  });

  it("keeps the marker while only other changes are written", async () => {
    const { dir, ledger } = await rig("persist-marker-stays");
    await breakWrites(dir);
    await expect(ledger.update({ mode: "reduce" })).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);

    await ledger.update({ mode: "reduce", reason: "other" });

    expect(ledger.state.mode).toBe("stopped");
    expect((await MakerLedger.open(makerStatePath(dir, PERP))).state.mode).toBe("stopped");
  });

  it("refuses to open while the marker cannot be checked", async () => {
    const { dir } = await rig("marker-unreadable");
    await unreadableMarker(dir);

    await expect(MakerLedger.open(makerStatePath(dir, PERP))).rejects.toThrow("recovery marker");
  });

  it("refuses the start after the state and the marker both failed to write", async () => {
    const { dir, ledger } = await rig("persist-both-fail");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await breakWrites(dir);
    await mkdir(markerOf(dir));

    await expect(ledger.update({ mode: "reduce" })).rejects.toThrow(StatePersistenceError);

    expect(ledger.state.mode).toBe("stopped");
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("ALERT"), expect.anything());
    logged.mockRestore();
    await unreadableMarker(dir);
    await expect(MakerLedger.open(makerStatePath(dir, PERP))).rejects.toThrow("recovery marker");
  });

  it("stays stopped with a recovery-required reason when the marker cannot be removed, and runs the same resume again", async () => {
    const { dir, ledger, clock } = await rig("persist-rm-fails");
    const said: string[] = [];
    const risk = new MakerRisk(ledger, clock, PERP, {
      alert: (message) => said.push(message),
      notice: (message) => said.push(message),
    });
    await breakWrites(dir);
    await expect(ledger.update({ mode: "reduce" })).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);
    const resume = { mode: "run", requestedAtMs: 5 } as const;
    removal.fails = true;

    await expect(risk.follow(resume, dollars(1_000))).rejects.toThrow(StatePersistenceError);

    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.state.reason).toContain("recovery marker could not be removed");
    expect(await ledger.canRetryResume(5)).toBe(true);
    expect(JSON.parse(await readFile(markerOf(dir), "utf8"))).toEqual({
      phase: "resumed",
      commandTs: 5,
    });

    const restarted = await MakerLedger.open(makerStatePath(dir, PERP));
    expect(restarted.state.mode).toBe("stopped");
    removal.fails = false;
    const again = new MakerRisk(restarted, clock, PERP, {
      alert: (message) => said.push(message),
      notice: (message) => said.push(message),
    });
    await again.follow(resume, dollars(1_000));
    expect(restarted.state.mode).toBe("run");
    expect(await restarted.canRetryResume(5)).toBe(false);
    expect((await MakerLedger.open(makerStatePath(dir, PERP))).state.mode).toBe("run");
  });

  it("finishes a saved resume at the next start once the marker can be removed", async () => {
    const { dir, ledger, clock } = await rig("persist-finish-on-open");
    const risk = new MakerRisk(ledger, clock, PERP, { alert: () => {}, notice: () => {} });
    await breakWrites(dir);
    await expect(ledger.update({ mode: "reduce" })).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);
    removal.fails = true;
    await expect(risk.follow({ mode: "run", requestedAtMs: 5 }, dollars(1_000))).rejects.toThrow(
      StatePersistenceError,
    );

    const held = await MakerLedger.open(makerStatePath(dir, PERP));
    expect(held.state.mode).toBe("stopped");
    expect(held.state.reason).toContain("recovery marker could not be removed");
    removal.fails = false;
    const finished = await MakerLedger.open(makerStatePath(dir, PERP));

    expect(finished.state.mode).toBe("run");
    await expect(access(markerOf(dir))).rejects.toThrow();
  });

  it("refuses a stale resume once a newer stop is saved, before and after a restart", async () => {
    const { dir, ledger, clock } = await rig("persist-stale-after-stop");
    const quiet = { alert: () => {}, notice: () => {} };
    const risk = new MakerRisk(ledger, clock, PERP, quiet);
    await breakWrites(dir);
    await expect(ledger.update({ mode: "reduce" })).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);
    const resume = { mode: "run", requestedAtMs: 5 } as const;
    removal.fails = true;
    await expect(risk.follow(resume, dollars(1_000))).rejects.toThrow(StatePersistenceError);

    await risk.follow({ mode: "stopped", requestedAtMs: 6 }, dollars(1_000));
    await risk.follow(resume, dollars(1_000));
    expect(ledger.state.mode).toBe("stopped");

    const restarted = await MakerLedger.open(makerStatePath(dir, PERP));
    removal.fails = false;
    const again = new MakerRisk(restarted, clock, PERP, quiet);
    await again.follow(resume, dollars(1_000));
    expect(restarted.state.mode).toBe("stopped");
    expect(restarted.state.lastCommandAtMs).toBe(6);
  });

  it("does not let an old run command resume a maker whose marker says failed", async () => {
    const { dir, ledger, clock } = await rig("persist-stale-run");
    await breakWrites(dir);
    await expect(ledger.update({ peakEquity: 1n })).rejects.toThrow(StatePersistenceError);
    await repairWrites(dir);
    await writeFile(
      makerStatePath(dir, PERP),
      JSON.stringify({
        mode: "run",
        reason: null,
        flattenStartedAtMs: null,
        day: null,
        dayStartEquity: null,
        peakEquity: null,
        lastCommandAtMs: 5,
        spotBaseAtStart: null,
      }),
    );
    const restarted = await MakerLedger.open(makerStatePath(dir, PERP));
    const risk = new MakerRisk(restarted, clock, PERP, { alert: () => {}, notice: () => {} });

    await risk.follow({ mode: "run", requestedAtMs: 5 }, dollars(1_000));
    expect(restarted.state.mode).toBe("stopped");

    await risk.follow({ mode: "run", requestedAtMs: 6 }, dollars(1_000));
    expect(restarted.state.mode).toBe("run");
  });

  it("does not keep a mode in memory that is not on disk", async () => {
    const { dir, ledger } = await rig("persist-memory");
    await breakWrites(dir);

    await expect(ledger.update({ mode: "reduce", reason: "test" })).rejects.toThrow(
      StatePersistenceError,
    );

    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.state.lastCommandAtMs).toBe(0);
  });

  it("writes the state to a file a restart reads back", async () => {
    const { dir, ledger } = await rig("persist-ok");

    await ledger.update({ mode: "reduce", reason: "test" });

    const reopened = await MakerLedger.open(makerStatePath(dir, PERP));
    expect(reopened.state.mode).toBe("reduce");
  });
});

describe("a stopped maker keeps trying to cancel", () => {
  it("retries a failed cancel on later ticks even when the mark is missing, and alerts once", async () => {
    const { warmUp, book, dir, clock, tick, said } = await rig("stopped-cancel-retry");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.failCancelling = new Error("the rollup did not answer");
    await requestMode(dir, "stopped", clock.nowMs() + 1);
    await expect(tick()).rejects.toThrow("did not answer");
    book.markMissing = true;
    await expect(tick()).rejects.toThrow("did not answer");

    expect(book.cancels).toBe(cancelsBefore);
    expect(said.alerts.filter((alert) => alert.includes("cancel was not confirmed"))).toHaveLength(
      1,
    );

    book.failCancelling = null;
    await tick();
    expect(book.cancels).toBe(cancelsBefore + 1);
    await tick();
    expect(book.cancels).toBe(cancelsBefore + 1);
  });
});

describe("the skew uses exact integer ratios", () => {
  it("skews a position of half the limit the same at any scale", () => {
    const shape = { ...SKEW_SHAPE };
    const small = ladderOrders(shape, {
      mark: dollars(150),
      tickSize: dollars(0.01),
      position: 1n,
      positionLimit: 2n,
    });
    const huge = ladderOrders(shape, {
      mark: dollars(150),
      tickSize: dollars(0.01),
      position: 10n ** 30n,
      positionLimit: 2n * 10n ** 30n,
    });

    expect(pricesOf(huge, "buy")[0]).toBe(pricesOf(small, "buy")[0]);
    expect(pricesOf(huge, "sell")[0]).toBe(pricesOf(small, "sell")[0]);
  });

  it("caps the skew at the limit however large the position is", () => {
    const base = {
      mark: dollars(150),
      tickSize: dollars(0.01),
      positionLimit: 10n ** 30n,
    };
    const full = ladderOrders(SKEW_SHAPE, { ...base, position: 10n ** 30n });
    const beyond = ladderOrders(SKEW_SHAPE, { ...base, position: 10n ** 40n });
    const nearly = ladderOrders(SKEW_SHAPE, { ...base, position: 9n * 10n ** 29n });

    expect(pricesOf(beyond, "sell")[0]).toBe(pricesOf(full, "sell")[0]);
    expect(pricesOf(nearly, "sell")[0]).toBeGreaterThan(pricesOf(full, "sell")[0]);
  });
});

describe("an order of unknown outcome holds the maker across a restart", () => {
  const holdOnDisk = async (dir: string) =>
    JSON.parse(await readFile(makerStatePath(dir, PERP), "utf8")).hold;

  it("writes the hold to disk, and a fresh maker over the same state is held until the order's absolute expiry", async () => {
    const { warmUp, book, tick, dir, clock, open, venue } = await rig("hold-restart");
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    const sentAtMs = clock.nowMs() + 11_000;
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    const saved = await holdOnDisk(dir);
    expect(saved).toMatchObject({ sinceMs: sentAtMs, lastAtMs: sentAtMs });
    expect(saved.untilMs).toBeGreaterThan(sentAtMs);
    book.unknownBecause = null;
    book.take();

    const restarted = await open();
    expect(restarted.maker.quarantinedSinceMs).toBe(sentAtMs);
    for (let step = 0; step < 12; step += 1) {
      clock.advance(1_000);
      await restarted.maker.tick(venue);
    }
    expect(book.take()).toEqual([]);
    expect(restarted.maker.quarantinedSinceMs).not.toBeNull();

    clock.advance(saved.untilMs - clock.nowMs() + 1_000);
    await restarted.maker.tick(venue);
    expect(restarted.maker.quarantinedSinceMs).toBeNull();
    expect(await holdOnDisk(dir)).toBeNull();
    for (let step = 0; step < 15; step += 1) {
      clock.advance(1_000);
      await restarted.maker.tick(venue);
    }
    expect(book.take().length).toBeGreaterThan(0);
  });

  it("keeps the hold, durably, past the expiry and an empty seat while a place call the venue gave up on is unsettled", async () => {
    const { warmUp, book, tick, dir, clock, open, venue } = await rig("hold-unsettled");
    await warmUp();
    book.take();
    book.unknownBecause = "the call timed out";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    const { untilMs } = await holdOnDisk(dir);
    book.unknownBecause = null;
    book.unsettled = 1;

    const restarted = await open();
    clock.advance(untilMs - clock.nowMs() + 60_000);
    await restarted.maker.tick(venue);
    await restarted.maker.tick(venue);

    expect(restarted.maker.quarantinedSinceMs).not.toBeNull();
    expect((await holdOnDisk(dir)).seatClearAtMs).not.toBeNull();
    expect(book.take()).toEqual([]);

    book.unsettled = 0;
    await restarted.maker.tick(venue);
    expect(restarted.maker.quarantinedSinceMs).toBeNull();
    expect(await holdOnDisk(dir)).toBeNull();
  });

  it("keeps the hold, and records it, while a cancel or a read of the seat keeps failing after the restart", async () => {
    const { warmUp, book, tick, dir, clock, open, venue } = await rig("hold-restart-failing");
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    const { untilMs } = await holdOnDisk(dir);
    book.unknownBecause = null;

    const restarted = await open();
    clock.advance(untilMs - clock.nowMs() + 1_000);
    book.failCancelling = new Error("the venue is away");
    await expect(restarted.maker.tick(venue)).rejects.toThrow("the venue is away");

    expect(restarted.maker.quarantinedSinceMs).not.toBeNull();
    expect(await holdOnDisk(dir)).not.toBeNull();
    expect(book.take()).toEqual([]);
  });

  it("does not clear a reduce-only order's hold by the clock, only by an operator's resume after it", async () => {
    const { warmUp, book, tick, dir, clock, open, venue, said } = await rig("hold-reduce-only");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    book.equity = dollars(969);
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    expect((await holdOnDisk(dir)).untilMs).toBeNull();
    book.unknownBecause = null;

    const restarted = await open();
    for (let step = 0; step < 4; step += 1) {
      clock.advance(200_000);
      await restarted.maker.tick(venue).catch(() => {});
    }
    expect(restarted.maker.quarantinedSinceMs).not.toBeNull();
    expect(await holdOnDisk(dir)).not.toBeNull();

    await requestMode(dir, "run", clock.nowMs() + 1);
    clock.advance(1_000);
    await restarted.maker.tick(venue);

    expect(restarted.maker.quarantinedSinceMs).toBeNull();
    expect(await holdOnDisk(dir)).toBeNull();
    expect(said.alerts.length).toBeGreaterThan(0);
  });

  it("does not take a resume that came before the unknown order for a review of it", async () => {
    const { warmUp, book, tick, dir, clock } = await rig("hold-old-resume");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick(1);
    book.unknownBecause = "the connection dropped";
    book.equity = dollars(969);
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;

    await tick(5);
    await tick(5);

    expect((await holdOnDisk(dir)).untilMs).toBeNull();
  });

  it("reads a state file written before holds existed as holding nothing", async () => {
    const { dir } = await rig("hold-old-file");
    await writeFile(
      makerStatePath(dir, PERP),
      JSON.stringify({
        mode: "run",
        reason: null,
        day: null,
        dayStartEquity: null,
        peakEquity: null,
        lastCommandAtMs: 0,
        spotBaseAtStart: null,
      }),
    );

    expect((await MakerLedger.open(makerStatePath(dir, PERP))).state.hold).toBeNull();
  });
});

describe("a ladder is recorded before any order of it is sent", () => {
  const holdOnDisk = async (dir: string) =>
    JSON.parse(await readFile(makerStatePath(dir, PERP), "utf8")).hold;

  it("sends every order with the very expiry the hold carries, even when the orders go out late", async () => {
    const { warmUp, book, tick, dir, clock } = await rig("ladder-expiry");
    await warmUp();
    book.take();
    const seen: { untilMs: number }[] = [];
    book.beforePlacing = async () => {
      seen.push(await holdOnDisk(dir));
      clock.advance(30_000);
    };

    await tick(11);

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(1);
    const expiry = orders[0].expiresAtMs ?? 0;
    expect(new Set(orders.map((order) => order.expiresAtMs))).toEqual(new Set([expiry]));
    expect(seen.every((hold) => hold.untilMs === holdLapsesAtMs(expiry))).toBe(true);
  });

  it("takes a slow ladder off without stopping the maker, and quotes again on the next tick", async () => {
    const { warmUp, book, tick, ledger, dir } = await rig("ladder-too-late");
    await warmUp();
    book.take();
    book.refusesTooLateAfter = 2;
    const cancelsBefore = book.cancels;

    await tick(11);

    expect(book.cancels).toBeGreaterThan(cancelsBefore + 1);
    expect(ledger.state.mode).toBe("run");
    expect(await holdOnDisk(dir)).toBeNull();

    book.take();
    book.refusesTooLateAfter = null;
    await tick(11);
    expect(book.take().length).toBeGreaterThan(2);
    expect(ledger.state.mode).toBe("run");
  });

  it("keeps the record of a slow ladder while an order call of it is unsettled", async () => {
    const { warmUp, book, tick, ledger, dir } = await rig("ladder-too-late-unsettled");
    await warmUp();
    book.take();
    book.refusesTooLateAfter = 2;
    book.unsettled = 1;

    await tick(11);

    expect(ledger.state.mode).toBe("run");
    expect(await holdOnDisk(dir)).not.toBeNull();
  });

  it("adds a risk-reducing send to the hold on disk, unbounded", async () => {
    const { warmUp, book, tick, ledger } = await rig("held-flatten-recorded");
    book.position = dollars(0.5);
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;
    const idsBefore = ledger.state.hold?.orderIds.length ?? 0;
    expect(ledger.state.hold?.untilMs).not.toBeNull();

    book.equity = dollars(969);
    await tick(1);

    expect(book.take().every((order) => order.reduceOnly === true)).toBe(true);
    expect(ledger.state.hold?.untilMs).toBeNull();
    expect(ledger.state.hold?.orderIds.length).toBeGreaterThan(idsBefore);
  });

  it("takes the ladder off, throws, and sends no heartbeat when the record of it cannot be cleared", async () => {
    let heartbeats = 0;
    const { warmUp, book, tick, dir, ledger } = await rig("ladder-clear-fails", {
      afterRequote: () => (heartbeats += 1),
    });
    await warmUp();
    book.take();
    const heartbeatsBefore = heartbeats;
    const cancelsBefore = book.cancels;
    book.beforePlacing = async () => {
      book.beforePlacing = null;
      await rm(makerStatePath(dir, PERP), { force: true });
      await mkdir(makerStatePath(dir, PERP));
    };

    await expect(tick(11)).rejects.toThrow(StatePersistenceError);

    expect(heartbeats).toBe(heartbeatsBefore);
    expect(book.cancels).toBe(cancelsBefore + 2);
    expect(ledger.state.mode).toBe("stopped");
  });

  it("sends no ladder after a failed clear and a resume until the saved hold is reconciled, then quotes again", async () => {
    const { warmUp, book, tick, dir, clock, ledger, maker } = await rig(
      "ladder-clear-fails-resume",
    );
    await warmUp();
    book.take();
    book.beforePlacing = async () => {
      book.beforePlacing = null;
      await rm(makerStatePath(dir, PERP), { force: true });
      await mkdir(makerStatePath(dir, PERP));
    };
    await expect(tick(11)).rejects.toThrow(StatePersistenceError);
    book.take();

    await rm(makerStatePath(dir, PERP), { recursive: true, force: true });
    await requestMode(dir, "run", clock.nowMs() + 1);
    await tick(1);

    expect(ledger.state.mode).toBe("run");
    expect(ledger.state.hold).not.toBeNull();
    expect(maker.quarantinedSinceMs).not.toBeNull();
    expect(book.take()).toEqual([]);

    await tick(60);
    await tick(11);
    expect(maker.quarantinedSinceMs).toBeNull();
    expect(book.take().length).toBeGreaterThan(0);
  });

  it("has the hold on disk while the orders go out, and clears it once they are all answered", async () => {
    const { warmUp, book, tick, dir, maker } = await rig("ladder-recorded");
    await warmUp();
    book.take();
    const seen: unknown[] = [];
    book.beforePlacing = async () => {
      seen.push(await holdOnDisk(dir));
    };

    await tick(11);

    expect(book.take().length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((hold) => hold !== null)).toBe(true);
    expect(await holdOnDisk(dir)).toBeNull();
    expect(maker.quarantinedSinceMs).toBeNull();
  });

  it("holds a restarted maker when the process died during the ladder", async () => {
    const { warmUp, book, tick, dir, clock, open, venue } = await rig("ladder-crash");
    await warmUp();
    book.take();
    book.failPlacing = new Error("the process was killed");
    await expect(tick(11)).rejects.toThrow("killed");
    book.failPlacing = null;
    expect(await holdOnDisk(dir)).not.toBeNull();

    const restarted = await open();
    expect(restarted.maker.quarantinedSinceMs).not.toBeNull();
    await restarted.maker.tick(venue);
    expect(book.take()).toEqual([]);

    clock.advance(60_000);
    for (let step = 0; step < 15; step += 1) {
      clock.advance(1_000);
      await restarted.maker.tick(venue);
    }
    expect(restarted.maker.quarantinedSinceMs).toBeNull();
  });

  it("sends nothing, and says nothing on disk will stop a restart, when neither the state nor the marker can be written", async () => {
    const { warmUp, book, tick, dir, ledger, said } = await rig("ladder-double-failure");
    await warmUp();
    book.take();
    await rm(makerStatePath(dir, PERP), { force: true });
    await mkdir(makerStatePath(dir, PERP));
    await mkdir(`${makerStatePath(dir, PERP)}.failed`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    book.beforePlacing = async () => {
      throw new Error("an order was sent");
    };

    await expect(tick(11)).rejects.toThrow(StatePersistenceError);

    errors.mockRestore();
    expect(book.take()).toEqual([]);
    expect(ledger.state.mode).toBe("stopped");
    expect(said.alerts.some((line) => line.includes("neither could the recovery marker"))).toBe(
      true,
    );
    await tick(30).catch(() => {});
    expect(book.take()).toEqual([]);
  });
});

describe("a cancel that never answers", () => {
  const SHORT = { cancelDeadlineMs: 20 };

  it("holds nothing new, tells the operator once, and tries again on every tick until one is confirmed", async () => {
    const { warmUp, book, tick, said } = await rig("cancel-hangs", SHORT);
    await warmUp();
    book.take();

    book.hangCancelling = true;
    await expect(tick(11)).rejects.toThrow("did not answer");
    await expect(tick(1)).rejects.toThrow("did not answer");
    await expect(tick(1)).rejects.toThrow("did not answer");

    expect(book.take()).toEqual([]);
    const alerts = said.alerts.filter((line) => line.includes("cancel was not confirmed"));
    expect(alerts).toHaveLength(1);

    book.hangCancelling = false;
    await expect(tick(1)).rejects.toThrow("did not answer");
    expect(book.take()).toEqual([]);

    book.releaseCancels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick(1);
    expect(book.take().length).toBeGreaterThan(0);
  });

  it("places no ladder for a later cancel to remove while an earlier cancel is still out", async () => {
    const { warmUp, book, tick } = await rig("cancel-late", SHORT);
    await warmUp();
    book.take();
    book.hangCancelling = true;
    await expect(tick(11)).rejects.toThrow("did not answer");
    book.hangCancelling = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(tick(11)).rejects.toThrow("did not answer");
    }
    expect(book.take()).toEqual([]);

    book.releaseCancels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick(11);
    expect(book.take().length).toBeGreaterThan(0);
  });

  it("reads a cancel as unconfirmed until the overdue one settles, whatever later cancel is confirmed", async () => {
    const { warmUp, book, tick, dir, clock, maker } = await rig("cancel-overdue-readiness", SHORT);
    await warmUp();
    book.take();
    await requestMode(dir, "stopped", clock.nowMs() + 1);
    book.hangCancelling = true;
    await expect(tick(1)).rejects.toThrow("did not answer");
    expect(maker.cancelUnconfirmed).toBe(true);

    book.hangCancelling = false;
    await tick(1);
    expect(maker.cancelUnconfirmed).toBe(true);

    book.releaseCancels();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maker.cancelUnconfirmed).toBe(false);
  });

  it("keeps a withdrawn maker from quoting, and keeps trying to withdraw, when the cancel after a hard stop never answers", async () => {
    const { warmUp, book, tick, dir, clock, ledger, said } = await rig("cancel-hangs-stop", SHORT);
    await warmUp();
    book.take();
    await requestMode(dir, "stopped", clock.nowMs() + 1);

    book.hangCancelling = true;
    await expect(tick(1)).rejects.toThrow("did not answer");
    await expect(tick(1)).rejects.toThrow("did not answer");

    expect(ledger.state.mode).toBe("stopped");
    expect(book.take()).toEqual([]);
    expect(said.alerts.filter((line) => line.includes("cancel was not confirmed"))).toHaveLength(1);

    book.hangCancelling = false;
    const cancelsBefore = book.cancels;
    await tick(1);
    expect(book.cancels).toBe(cancelsBefore + 1);
    expect(book.take()).toEqual([]);
  });

  it("holds a maker that is reconciling an unknown order when the cancel never answers", async () => {
    const { warmUp, book, tick, maker } = await rig("cancel-hangs-reconcile", SHORT);
    await warmUp();
    book.take();
    book.unknownBecause = "the connection dropped";
    await expect(tick(11)).rejects.toThrow("outcome unknown");
    book.unknownBecause = null;

    book.hangCancelling = true;
    await expect(tick(30)).rejects.toThrow("did not answer");

    expect(maker.quarantinedSinceMs).not.toBeNull();
    expect(book.take()).toEqual([]);
  });
});
