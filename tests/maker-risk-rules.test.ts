import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HouseMaker, type HouseMakerOptions, onlyReducing } from "../src/bots/house-maker.js";
import { MakerControl, controlPath, requestMode } from "../src/bots/maker-control.js";
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerSafety } from "../src/bots/maker-safety.js";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import type { MarketInfo, NewOrder, TraderState, Venue } from "../src/engine/types.js";
import { VenueNotReady } from "../src/engine/venue-not-ready.js";
import {
  type PriceReading,
  type Reference,
  ReferencePrice,
  referenceOf,
  referenceSources,
} from "../src/prices/reference-price.js";
import { MARKETS } from "../src/engine/markets.js";
import { placingOrdersThrough } from "../src/engine/venue-orders.js";
import { openBots } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
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
    const clock = new ManualClock(now);
    const answers: Record<string, unknown> = {
      "hermes.pyth.network": {
        parsed: [{ price: { price: "15012345678", expo: -8, publish_time: now / 1_000 - 2 } }],
      },
      "api.exchange.coinbase.com": { price: "150.11", time: new Date(now - 500).toISOString() },
      "api.kraken.com": { error: [], result: { SOLUSD: { c: ["150.12", "0.4"] } } },
      "www.okx.com": { data: [{ last: "150.13", ts: String(now - 300) }] },
    };
    const sources = referenceSources(clock, async (url) => answers[new URL(url).host]);

    const readings = await Promise.all(sources.map((source) => source.read()));

    expect(readings).toEqual([
      { source: "Pyth", exchange: false, price: dollars(150.123456), atMs: now - 2_000 },
      { source: "Coinbase", exchange: true, price: dollars(150.11), atMs: now - 500 },
      { source: "Kraken", exchange: true, price: dollars(150.12), atMs: now },
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
  /** The venue answers every order with a refusal. */
  rejecting = false;
  rejectedCount = 0;
  beforePlacing: (() => Promise<void>) | null = null;

  asVenue(): Venue {
    return {
      markets: async () => [this.info()],
      cancelAll: async () => {
        if (this.failCancelling) throw this.failCancelling;
        this.cancels += 1;
        return 0;
      },
      placeOrder: async (_trader: string, order: NewOrder) => {
        await this.beforePlacing?.();
        if (this.failPlacing) throw this.failPlacing;
        if (this.rejecting) {
          this.rejectedCount += 1;
          return {
            orderId: "",
            tag: 0n,
            status: "rejected",
            filledSize: 0n,
            remainingSize: order.size,
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
      markPrice: this.mark,
      markPriceUpdatedAtMs: 0,
      change24h: null,
      volume24h: 0n,
      openInterest: null,
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
    expect(first.ledger.state.mode).toBe("reduce");

    const { maker, ledger } = await first.open();
    expect(ledger.state.mode).toBe("reduce");
    expect(ledger.state.dayStartEquity).toBe(dollars(1_000));
    expect(ledger.state.peakEquity).toBe(dollars(1_000));
    expect(ledger.state.reason).toContain("it lost 40.00 nUSD today");

    first.clock.advance(24 * 3_600_000);
    first.book.take();
    await maker.tick(first.venue);
    for (let second = 0; second < 11; second += 1) {
      first.clock.advance(1_000);
      await maker.tick(first.venue);
    }
    expect(ledger.state.mode).toBe("reduce");
    expect(ledger.state.day).toBe("2026-11-03");
    expect(ledger.state.dayStartEquity).toBe(dollars(960));
    expect(new Set(first.book.take().map((order) => order.side))).toEqual(new Set(["sell"]));
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
    const { warmUp, book, dir, clock, tick } = await rig("kill-reduce");
    book.position = dollars(0.5);
    await warmUp();
    expect(new Set(book.take().map((order) => order.side))).toEqual(new Set(["buy", "sell"]));

    await requestMode(dir, "reduce", clock.nowMs() + 1);
    await tick();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(new Set(orders.map((order) => order.side))).toEqual(new Set(["sell"]));
    expect(orders.reduce((sum, order) => sum + order.size, 0n)).toBeLessThanOrEqual(dollars(0.5));
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

  it("quotes nothing new while the control file cannot be read", async () => {
    const { warmUp, book, dir, tick, maker, venue, clock } = await rig("kill-damaged");
    await warmUp();
    book.take();

    await writeFile(controlPath(dir), "garbage");
    clock.advance(30_000);

    await expect(maker.tick(venue)).rejects.toThrow("maker control file");
    await expect(tick()).rejects.toThrow("maker control file");
    expect(book.orders).toHaveLength(0);
  });

  it("resumes with its loss limits counting from the equity it has now", async () => {
    const { warmUp, book, dir, clock, tick, ledger } = await rig("kill-resume");
    await warmUp();
    book.equity = dollars(900);
    await tick();
    expect(ledger.state.mode).toBe("reduce");

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
  const openedWith = async (market: (typeof MARKETS)[number], over: Record<string, string>) => {
    const { venue } = makeVenue();
    const sent = { cancels: 0 };
    const counting: Venue = {
      ...placingOrdersThrough(venue, (trader, order) => venue.placeOrder(trader, order)),
      cancelAll: async () => (sent.cancels += 1),
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
    return { opened: openBots(config, wiring, problems), sent };
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

  it("stops for good on an error it does not understand, cancels, and never retries the order", async () => {
    const { warmUp, book, tick, said, ledger } = await rig("unknown-error");
    await warmUp();
    book.take();
    const cancelsBefore = book.cancels;

    book.failPlacing = new Error("the program answered something new");
    await expect(tick(11)).rejects.toThrow("something new");
    book.failPlacing = null;
    await tick(30);
    await tick(30);

    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.state.reason).toBe("the program answered something new");
    expect(said.alerts).toHaveLength(1);
    expect(said.alerts[0]).toContain("does not understand");
    expect(book.orders).toHaveLength(0);
    expect(book.cancels).toBe(cancelsBefore + 2);
  });

  it("does not stop when the venue is only still starting", async () => {
    const { warmUp, book, tick, ledger } = await rig("venue-starting");
    await warmUp();
    book.take();

    book.failPlacing = new VenueNotReady("the service is still starting, try again");
    await expect(tick(11)).rejects.toThrow("still starting");

    expect(ledger.state.mode).toBe("run");
  });

  it("does not stop for a refused order, which the venue answers and which the log already reports", async () => {
    const { warmUp, book, tick, ledger } = await rig("refused-order");
    book.rejecting = true;
    await warmUp();

    await tick(11);

    expect(book.rejectedCount).toBeGreaterThan(0);
    expect(ledger.state.mode).toBe("run");
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
