import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import { MakerControl, controlPath, requestMode } from "../src/bots/maker-control.js";
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerSafety } from "../src/bots/maker-safety.js";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import type { MarketInfo, NewOrder, TraderState, Venue } from "../src/engine/types.js";
import { HedgeController, type HedgeStatus } from "../src/hedge/hedge-controller.js";
import type { Reference } from "../src/prices/reference-price.js";
import { HedgeNotAvailable, openBots } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { FakeHedgeVenue } from "./fake-hedge-venue.js";
import { dollars } from "./helpers.js";

const PERP = "NSOL-PERP";
const START_MS = Date.parse("2026-11-02T12:00:00Z");
const ROOT = join("data-test", `hedge-maker-${Date.now()}`);

afterAll(() => rm(ROOT, { recursive: true, force: true }));

/** A venue that records the orders the maker places and holds the position a test sets. */
class Book {
  position = 0n;
  orders: NewOrder[] = [];

  asVenue(): Venue {
    const info: MarketInfo = {
      id: PERP,
      kind: "perp",
      base: "SOL",
      quote: "nUSD",
      tickSize: dollars(0.01),
      lotSize: dollars(0.001),
      maxLeverage: 5,
      markPrice: dollars(150),
      markPriceUpdatedAtMs: 0,
      change24h: null,
      volume24h: 0n,
      openInterest: null,
    };
    return {
      markets: async () => [info],
      cancelAll: async () => 0,
      placeOrder: async (_trader: string, order: NewOrder) => {
        this.orders.push(order);
        return { orderId: "", tag: 0n, status: "open", filledSize: 0n, remainingSize: order.size };
      },
      traderState: async (): Promise<TraderState> => ({
        trader: "maker",
        balances: {},
        positions: { [PERP]: { size: this.position, entryPrice: dollars(150) } },
        openOrders: [],
        equity: dollars(1_000),
      }),
    } as unknown as Venue;
  }

  take(): NewOrder[] {
    return this.orders.splice(0);
  }
}

const nearestBidBps = (orders: NewOrder[]): number => {
  const bids = orders.filter((order) => order.side === "buy").map((order) => order.price ?? 0n);
  const best = bids.reduce((a, b) => (a > b ? a : b));
  return ((150 - Number(best) / 1e6) / 150) * 10_000;
};

const rig = async (name: string) => {
  const dir = join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const clock = new ManualClock(START_MS);
  const book = new Book();
  const said = { alerts: [] as string[], notices: [] as string[] };
  const voice = {
    alert: (message: string) => said.alerts.push(message),
    notice: (message: string) => said.notices.push(message),
  };
  const reference = { read: async (): Promise<Reference> => ({ ok: true, price: dollars(150) }) };
  const ledger = await MakerLedger.open(makerStatePath(dir, PERP));
  const hedgeVenue = new FakeHedgeVenue();
  const controller = new HedgeController({
    venue: hedgeVenue,
    clock,
    reference,
    makerPosition: async () => book.position,
    makerMode: () => ledger.state.mode,
    voice,
    market: PERP,
    settings: {
      softUnhedgedNotional: dollars(100),
      hardUnhedgedNotional: dollars(250),
      confirmTimeoutMs: 60_000,
      maxLeverage: 3,
    },
  });
  const forced = { status: null as HedgeStatus | null };
  const safety = new MakerSafety({
    reference,
    risk: new MakerRisk(ledger, clock, PERP, voice),
    control: new MakerControl(controlPath(dir)),
    clock,
    voice,
    market: PERP,
    hedge: { status: () => forced.status ?? controller.status() },
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
  });
  const venue = book.asVenue();
  const tick = async (seconds = 1) => {
    clock.advance(seconds * 1_000);
    await maker.tick(venue);
  };
  const warmUp = async () => {
    await maker.tick(venue);
    for (let second = 0; second < 10; second += 1) await tick();
  };
  return { dir, clock, book, said, hedgeVenue, controller, forced, ledger, tick, warmUp };
};

describe("the maker and its hedge", () => {
  it("quotes wider while the hedge lags, and returns to normal when it is confirmed", async () => {
    const { book, forced, tick, warmUp, said } = await rig("lagging");
    forced.status = "ok";
    await warmUp();
    const normal = nearestBidBps(book.take());

    forced.status = "lagging";
    await tick();
    const wider = nearestBidBps(book.take());
    expect(wider).toBeGreaterThan(normal + 9);
    expect(said.notices.some((line) => line.includes("hedge is lagging"))).toBe(true);

    forced.status = "ok";
    await tick();
    expect(nearestBidBps(book.take())).toBeCloseTo(normal, 0);
    expect(said.notices.some((line) => line.includes("confirmed again"))).toBe(true);
  });

  it("quotes only the side that shrinks its position while the hedge is blind, with one ALERT", async () => {
    const { book, forced, tick, warmUp, said } = await rig("blind");
    forced.status = "ok";
    await warmUp();
    book.take();

    book.position = dollars(0.5);
    forced.status = "blind";
    await tick();
    await tick();

    const orders = book.take();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => order.side === "sell")).toBe(true);
    const blindAlerts = said.alerts.filter((line) => line.includes("hedge is blind"));
    expect(blindAlerts).toHaveLength(1);
    expect(blindAlerts[0]).toMatch(/^ALERT /);
  });

  it("quotes nothing at all while blind and flat, then both sides again once confirmed", async () => {
    const { book, forced, tick, warmUp } = await rig("flat");
    forced.status = "ok";
    await warmUp();
    book.take();

    forced.status = "blind";
    await tick();
    expect(book.take()).toEqual([]);

    forced.status = "ok";
    await tick();
    const sides = new Set(book.take().map((order) => order.side));
    expect(sides).toEqual(new Set(["buy", "sell"]));
  });

  it("goes blind when the hedge venue is unreachable and recovers once it answers", async () => {
    const { book, hedgeVenue, controller, tick, warmUp, said } = await rig("outage");
    hedgeVenue.down = true;
    await controller.tick();
    await warmUp();
    expect(book.take()).toEqual([]);
    expect(said.alerts.some((line) => line.includes("hedge is blind"))).toBe(true);

    hedgeVenue.down = false;
    await controller.tick();
    await tick();
    expect(new Set(book.take().map((order) => order.side))).toEqual(new Set(["buy", "sell"]));
  });

  it("follows the kill switch: no new hedge at the soft stop, none at all at the hard stop", async () => {
    const { dir, clock, book, hedgeVenue, controller, tick, warmUp, said } = await rig("kill");
    await controller.tick();
    await warmUp();
    book.position = dollars(1);

    await requestMode(dir, "reduce", clock.nowMs());
    await tick();
    await controller.tick();
    expect(hedgeVenue.placed).toHaveLength(0);

    await requestMode(dir, "stopped", clock.nowMs() + 1_000);
    await tick(2);
    await controller.tick();
    expect(hedgeVenue.placed).toHaveLength(0);
    expect(said.alerts.some((line) => /hedge: .*unmanaged/.test(line))).toBe(true);
  });
});

describe("the hedge is off by default", () => {
  it("is off unless HEDGE_ENABLED is set, with conservative limits", () => {
    const config = loadConfig({});
    expect(config.HEDGE_ENABLED).toBe(false);
    expect(config.HEDGE_SOFT_UNHEDGED_NUSD).toBe(dollars(100));
    expect(config.HEDGE_HARD_UNHEDGED_NUSD).toBe(dollars(250));
    expect(config.HEDGE_CONFIRM_TIMEOUT_SECONDS).toBe(60);
    expect(config.HEDGE_MAX_LEVERAGE).toBe(3);
  });

  it("refuses to start when it is on without the maker's risk rules or a venue client", async () => {
    const problems = { onError: () => {}, onRecovered: () => {} };
    const noRules = loadConfig({ HEDGE_ENABLED: "1" });
    await expect(openBots(noRules, {} as VenueWiring, problems)).rejects.toBeInstanceOf(
      HedgeNotAvailable,
    );
  });
});
