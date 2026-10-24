import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What the mocked disk does. The busy count lets a test wait until no file work is under way. */
const disk = vi.hoisted(() => ({
  busy: 0,
  /** Opening the maker's state file (and its probe) for writing fails. */
  failState: false,
  /** Opening the recovery marker for writing fails. */
  failMarker: false,
  /** Removing the recovery marker fails. */
  failMarkerRemoval: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
    disk.busy += 1;
    try {
      return await work();
    } finally {
      disk.busy -= 1;
    }
  };
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => tracked(() => actual.mkdir(...args)),
    rename: (...args: Parameters<typeof actual.rename>) => tracked(() => actual.rename(...args)),
    readFile: ((...args: Parameters<typeof actual.readFile>) =>
      tracked(() => actual.readFile(...args))) as typeof actual.readFile,
    lstat: ((...args: Parameters<typeof actual.lstat>) =>
      tracked(() => actual.lstat(...args))) as typeof actual.lstat,
    rm: (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) =>
      tracked(() =>
        disk.failMarkerRemoval && String(path).endsWith(".failed")
          ? Promise.reject(new Error("EBUSY: the disk refused the removal"))
          : actual.rm(path, options),
      ),
    open: (...args: Parameters<typeof actual.open>) =>
      tracked(async () => {
        const path = String(args[0]);
        const isMarker = path.includes(".failed");
        const writing = args[1] !== "r";
        if (writing && path.includes("maker-NSOL-PERP")) {
          if (isMarker ? disk.failMarker : disk.failState) {
            throw new Error("EROFS: the disk is read-only");
          }
        }
        const handle = await actual.open(...args);
        return new Proxy(handle, {
          get: (target, property) => {
            const member = Reflect.get(target, property) as unknown;
            return typeof member === "function"
              ? (...inner: unknown[]) => tracked(async () => member.apply(target, inner))
              : member;
          },
        });
      }),
  };
});

import { CANCEL_DEADLINE_MS } from "../src/bots/house-maker.js";
import { controlPath, requestMode } from "../src/bots/maker-control.js";
import { makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { MARKETS } from "../src/engine/markets.js";
import type {
  MarketInfo,
  NewOrder,
  OrderView,
  PlaceResult,
  TraderState,
  Venue,
} from "../src/engine/types.js";
import { LATE_DISPATCH_QUARANTINE_MS } from "../src/hedge/hedge-limits.js";
import type { HedgeAck, HedgeOrder } from "../src/hedge/hedge-venue.js";
import { PLACE_DEADLINE_MS } from "../src/rollup/rollup-venue.js";
import { type OpenedBots, openBots } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { FakeHedgeVenue } from "./fake-hedge-venue.js";
import { dollars } from "./helpers.js";

const PERP = "NSOL-PERP";
const START_MS = Date.parse("2026-11-02T12:00:00Z");
const ROOT = join("data-test", `failure-injection-${Date.now()}`);
const LEVELS = 2;
/** One ladder is a bid and an ask per level. */
const LADDER_SIZE = LEVELS * 2;
const SHORT_REQUOTE_MS = 10_000;
/** The longest the requote interval may be set to: a quote then lives 40 s, well past a place call's 20 s deadline. */
const LONG_REQUOTE_MS = 30_000;
const SECOND = 1_000;
const realSetTimeout = globalThis.setTimeout;

afterAll(() => rm(ROOT, { recursive: true, force: true }));

/** How the next order call goes wrong. */
type PlaceFault =
  | { kind: "ok" }
  /** The venue gives up at its deadline and the call never lands. */
  | { kind: "hang-forever" }
  /** The venue gives up at its deadline; the order lands later on the venue's side. */
  | { kind: "late"; landsAfterMs: number }
  /** The order lands and the call then fails. */
  | { kind: "throws" }
  /** The order lands and the call never answers, with no deadline of its own. */
  | { kind: "raw-hang" }
  /** The venue answers normally, after this long. */
  | { kind: "slow"; ms: number };

/** How the next cancel goes wrong. */
type CancelFault = { kind: "hang" } | { kind: "late"; settlesAfterMs: number } | { kind: "fail" };

interface Resting {
  expiresAtMs: number;
  order: NewOrder;
}

interface Call {
  generation: number;
  abandoned: boolean;
  landed: boolean;
}

interface SavedHold {
  orderIds: string[];
  sinceMs: number;
  lastAtMs: number;
  untilMs: number | null;
}

interface SavedState {
  mode: string;
  hardStop?: boolean;
  lastCommandAtMs: number;
  hold: SavedHold | null;
}

const feedBody = (host: string, price: number, atMs: number) => {
  const text = price.toFixed(2);
  if (host === "hermes.pyth.network") {
    return {
      parsed: [
        {
          price: { price: String(Math.round(price * 1e8)), expo: -8, publish_time: atMs / SECOND },
        },
      ],
    };
  }
  if (host === "api.exchange.coinbase.com") {
    return { price: text, time: new Date(atMs).toISOString() };
  }
  if (host === "api.kraken.com") {
    return {
      error: [],
      result: { SOLUSD: [[text, "0.4", atMs / SECOND, "b", "l", "", 1]], last: "1" },
    };
  }
  return { data: [{ last: text, ts: String(atMs) }] };
};

/** A hedge venue that tells the world about each order before it takes it. */
class WatchedHedgeVenue extends FakeHedgeVenue {
  onOrder: (order: HedgeOrder, positionBefore: bigint) => void = () => {};

  override async placeIoc(order: HedgeOrder): Promise<HedgeAck> {
    this.onOrder(order, this.position);
    return super.placeIoc(order);
  }
}

/**
 * The exchange the maker quotes on, with its faults, and everything that
 * counts as breaking an invariant. It writes a violation down the moment it
 * sees one, from inside the venue call where it can.
 */
class World {
  mark = dollars(150);
  position = 0n;
  equity = dollars(1_000);
  feed = { price: 150, mode: "ok" as "ok" | "stale" | "down" | "hang" };
  marketsHang = false;
  refusedBecause: string | null = null;
  placeFaults: PlaceFault[] = [];
  cancelFault: CancelFault | null = null;
  generation = 0;
  placeCalls = 0;
  cancelCalls = 0;
  /** When each order call was made, relative to the start, and whether it was reduce-only. */
  placeLog: { atMs: number; reduceOnly: boolean }[] = [];
  readonly alerts: { atMs: number; text: string }[] = [];
  readonly errors: { what: string; atMs: number }[] = [];
  /** Moments an outcome became unknown: an order, or a cancel nobody confirmed. */
  readonly unknownEvents: number[] = [];
  bots: OpenedBots | null = null;
  dir = "";
  private readonly found: string[] = [];
  private resting: Resting[] = [];
  private places: Call[] = [];
  private cancels: Call[] = [];
  private hungMarkets: (() => void)[] = [];
  private hungCancels: (() => void)[] = [];
  private normalPlaces = 0;
  /** When the newest cancel was asked for: a hold written before it is not this ladder's own record. */
  private lastCancelAtMs = 0;
  private previousHold: SavedHold | null = null;
  private holdReleasedSeenAtMs: number | null = null;
  private orders = 0;

  violate(text: string): void {
    const line = `${Math.round((Date.now() - START_MS) / SECOND)}s ${text}`;
    if (!this.found.includes(line)) this.found.push(line);
  }

  /** The violations found so far, optionally only those of one invariant. */
  violations(code?: string): string[] {
    const missing = this.unknownEvents
      .filter((at) => !this.alerts.some((alert) => alert.atMs >= at))
      .map(
        (at) =>
          `${Math.round((at - START_MS) / SECOND)}s I4: no ALERT followed the unknown outcome`,
      );
    return [...this.found, ...missing].filter((line) => code === undefined || line.includes(code));
  }

  heard(text: string): boolean {
    return this.alerts.some((alert) => alert.text.includes(text));
  }

  liveResting(): Resting[] {
    return this.resting.filter((entry) => entry.expiresAtMs > Date.now());
  }

  saved(): SavedState | null {
    try {
      return JSON.parse(readFileSync(makerStatePath(this.dir, PERP), "utf8")) as SavedState;
    } catch {
      return null;
    }
  }

  markerOnDisk(): boolean {
    return existsSync(`${makerStatePath(this.dir, PERP)}.failed`);
  }

  readiness(): { ready: boolean; reason?: string } {
    return this.bots ? this.bots.trading() : { ready: true };
  }

  /** A process died: what its caller was waiting for never answers, and its own accounting is gone. */
  processDied(): void {
    this.generation += 1;
    this.normalPlaces = 0;
  }

  releaseHungMarkets(): void {
    this.marketsHang = false;
    for (const release of this.hungMarkets.splice(0)) release();
  }

  releaseHungCancels(): void {
    for (const release of this.hungCancels.splice(0)) release();
  }

  unsettledPlaces(generation: number): number {
    return this.places.filter(
      (call) => call.generation === generation && call.abandoned && !call.landed,
    ).length;
  }

  unsettledCancels(generation: number): number {
    return this.cancels.filter(
      (call) => call.generation === generation && call.abandoned && !call.landed,
    ).length;
  }

  /** Checks every invariant that can be read from outside, once the system is quiet. */
  sample(): void {
    const live = this.liveResting();
    if (live.length > LADDER_SIZE) {
      this.violate(
        `I1: ${live.length} orders rest on the venue, more than one ladder of ${LADDER_SIZE}`,
      );
    }
    const readiness = this.readiness();
    const unsettled =
      this.unsettledPlaces(this.generation) + this.unsettledCancels(this.generation);
    if (unsettled > 0 && readiness.ready) {
      this.violate(`I5: trading reads ready while ${unsettled} call(s) are unsettled`);
    }
    const hold = this.saved()?.hold ?? null;
    if (hold !== null && this.normalPlaces === 0 && readiness.ready) {
      this.violate("I5: trading reads ready while a hold is on disk");
    }
    if (this.previousHold !== null && hold === null) {
      this.holdReleasedSeenAtMs = Date.now();
      if (unsettled > 0) this.violate("I3: the hold was released while a call was unsettled");
    }
    this.previousHold = hold;
  }

  private checkBeforePlacing(order: NewOrder, generation: number): void {
    if (this.unsettledPlaces(generation) > 0) {
      this.violate("I2: an order went out while an earlier place call was unsettled");
    }
    if (this.cancels.some((call) => call.generation === generation && !call.landed)) {
      this.violate("I2: an order went out while a cancel was unsettled");
    }
    if (order.reduceOnly === true) return;
    const reason = this.readiness().reason ?? "";
    if (reason.includes("held by an order of unknown outcome")) {
      this.violate("I2: a new order went out while the maker was held by an unknown order");
    }
    if (reason.includes("maker is stopped")) {
      this.violate("I6: a new order went out while the maker was stopped");
    }
    const saved = this.saved();
    if (saved?.mode === "stopped") this.violate("I6: a new order went out over a saved stop");
    if (this.markerOnDisk()) this.violate("I6: a new order went out with a failure marker on disk");
    if (saved?.hold && saved.hold.sinceMs < this.lastCancelAtMs) {
      this.violate("I6: a new ladder went out with an older unresolved hold still on disk");
    }
  }

  /** An order's expiry is fixed when it is sent, as the program takes it: a late landing rests only until then. */
  private land(order: NewOrder, late: boolean, sentAtMs: number): void {
    const expiresAtMs = sentAtMs + (order.expiresInSeconds ?? 0) * SECOND;
    if (expiresAtMs <= Date.now()) return;
    this.resting.push({ expiresAtMs, order });
    if (this.liveResting().length > LADDER_SIZE) {
      this.violate(
        `I1: ${this.liveResting().length} orders rest after a landing, more than one ladder`,
      );
    }
    const unknownAt = this.unknownEvents.at(-1);
    if (
      late &&
      this.holdReleasedSeenAtMs !== null &&
      unknownAt !== undefined &&
      this.holdReleasedSeenAtMs >= unknownAt
    ) {
      this.violate("I3: an order landed after the hold that covered it was released");
    }
  }

  private unknownResult(order: NewOrder, id: string, reason: string): PlaceResult {
    return {
      orderId: id,
      tag: 0n,
      status: "rejected",
      filledSize: 0n,
      remainingSize: order.size,
      reason,
      outcomeUnknown: true,
    };
  }

  /** Waits for a caller of `generation`; `onTime` happens on the venue's side whether or not that caller is still alive. */
  private sleep(ms: number, generation: number, onTime: () => void): Promise<void> {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        onTime();
        if (generation === this.generation) resolve();
      }, ms);
    });
  }

  private async place(generation: number, order: NewOrder): Promise<PlaceResult> {
    this.checkBeforePlacing(order, generation);
    this.placeCalls += 1;
    this.placeLog.push({ atMs: Date.now(), reduceOnly: order.reduceOnly === true });
    this.orders += 1;
    const id = `order-${this.orders}`;
    const fault = this.placeFaults.shift() ?? { kind: "ok" };
    const open: PlaceResult = {
      orderId: id,
      tag: 0n,
      status: "open",
      filledSize: 0n,
      remainingSize: order.size,
    };
    const sentAtMs = Date.now();
    if (fault.kind === "ok") {
      this.land(order, false, sentAtMs);
      return open;
    }
    if (fault.kind === "slow") {
      this.normalPlaces += 1;
      await this.sleep(fault.ms, generation, () => this.land(order, false, sentAtMs));
      this.normalPlaces -= 1;
      return open;
    }
    if (fault.kind === "throws") {
      this.land(order, false, sentAtMs);
      this.unknownEvents.push(Date.now());
      throw new Error("the connection was reset after the order was sent");
    }
    if (fault.kind === "raw-hang") {
      this.land(order, false, sentAtMs);
      this.normalPlaces += 1;
      return new Promise<PlaceResult>(() => {});
    }
    const call: Call = { generation, abandoned: false, landed: false };
    this.places.push(call);
    this.normalPlaces += 1;
    if (fault.kind === "late") {
      setTimeout(() => {
        call.landed = true;
        this.land(order, true, sentAtMs);
      }, fault.landsAfterMs);
    }
    await this.sleep(PLACE_DEADLINE_MS, generation, () => {
      call.abandoned = true;
    });
    this.normalPlaces -= 1;
    this.unknownEvents.push(Date.now());
    return this.unknownResult(order, id, "the venue did not answer in time");
  }

  private async cancelAll(generation: number): Promise<number> {
    this.cancelCalls += 1;
    this.lastCancelAtMs = Date.now();
    const fault = this.cancelFault;
    const clear = (): number => {
      const count = this.liveResting().length;
      this.resting = [];
      return count;
    };
    if (fault === null) return clear();
    if (fault.kind === "fail") throw new Error("the cancel was refused");
    const call: Call = { generation, abandoned: false, landed: false };
    this.cancels.push(call);
    const deadline = setTimeout(() => {
      call.abandoned = true;
      this.unknownEvents.push(Date.now());
    }, CANCEL_DEADLINE_MS);
    return new Promise<number>((resolve) => {
      const settle = (): void => {
        clearTimeout(deadline);
        call.landed = true;
        const count = clear();
        if (generation === this.generation) resolve(count);
      };
      if (fault.kind === "late") setTimeout(settle, fault.settlesAfterMs);
      else this.hungCancels.push(settle);
    });
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
      markPriceUpdatedAtMs: Date.now(),
      change24h: null,
      volume24h: 0n,
      openInterest: null,
      ...(this.refusedBecause === null ? {} : { quotesRefusedBecause: this.refusedBecause }),
    };
  }

  /** The venue as one process of the service sees it. */
  venueFor(generation: number): Venue {
    return {
      markets: () =>
        this.marketsHang
          ? new Promise<MarketInfo[]>((resolve) => {
              this.hungMarkets.push(() => {
                if (generation === this.generation) resolve([this.info()]);
              });
            })
          : Promise.resolve([this.info()]),
      publishPrice: async () => {},
      openTrader: async () => {},
      deposit: async () => {},
      placeOrder: (_trader, order) => this.place(generation, order),
      cancelAll: () => this.cancelAll(generation),
      traderState: async (): Promise<TraderState> => ({
        trader: "maker",
        balances: {},
        positions: { [PERP]: { size: this.position, entryPrice: this.mark } },
        openOrders: this.liveResting().map((entry): OrderView => ({
          orderId: "resting",
          tag: 0n,
          market: PERP,
          side: entry.order.side,
          type: entry.order.type,
          price: entry.order.price ?? null,
          size: entry.order.size,
          remainingSize: entry.order.size,
          reduceOnly: false,
        })),
        equity: this.equity,
      }),
      updateFunding: async () => {},
      liquidate: async () => false,
      unsettledPlaces: () => this.unsettledPlaces(generation),
      onFill: () => () => {},
    };
  }

  fetchFeed = async (input: unknown): Promise<Response> => {
    const { host } = new URL(String(input));
    if (this.feed.mode === "down") throw new Error("the network is down");
    if (this.feed.mode === "hang") {
      await new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 3_000));
    }
    const age = this.feed.mode === "stale" ? 60_000 : 1_000;
    const body = feedBody(host, this.feed.price, Date.now() - age);
    return { ok: true, status: 200, json: async () => body } as Response;
  };
}

const settle = async (): Promise<void> => {
  for (let quiet = 0; quiet < 3;) {
    await new Promise((resolve) => realSetTimeout(resolve, 1));
    await vi.advanceTimersByTimeAsync(0);
    quiet = disk.busy === 0 ? quiet + 1 : 0;
  }
};

interface RigOptions {
  hedge?: boolean;
  network?: string;
  requoteMs?: number;
}

/** The service wired the way it is in production: `openBots` over a fake exchange, with real files. */
const rig = async (name: string, options: RigOptions = {}) => {
  const dir = join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const world = new World();
  world.dir = dir;
  const hedgeVenue = new WatchedHedgeVenue();
  hedgeVenue.now = () => Date.now();
  let loops: ReturnType<OpenedBots["start"]> = [];
  vi.stubGlobal("fetch", world.fetchFeed);
  const config = {
    ...loadConfig({
      VENUE: "memory",
      NOISE_TAKERS_ENABLED: "0",
      LIQUIDATOR_ENABLED: "0",
      HOUSE_MAKER_RISK_RULES: "1",
      HOUSE_MAKER_LEVELS: String(LEVELS),
      HOUSE_MAKER_REQUOTE_INTERVAL_MS: String(options.requoteMs ?? SHORT_REQUOTE_MS),
      HEDGE_ENABLED: options.hedge ? "1" : "0",
      DATA_DIR: dir,
    }),
    NETWORK: options.network ?? "devnet",
  };
  const problems = {
    onError: (what: string, error: unknown) => {
      world.errors.push({ what, atMs: Date.now() });
      if (error === null && what.startsWith("ALERT")) {
        world.alerts.push({ atMs: Date.now(), text: what });
      }
    },
    onRecovered: () => {},
  };
  const start = async (): Promise<void> => {
    const venue = world.venueFor(world.generation);
    const wiring = {
      venue,
      botVenue: venue,
      botMarkets: [MARKETS[0]],
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
    world.bots = await openBots(config, wiring, problems, options.hedge ? hedgeVenue : undefined);
    loops = world.bots.start();
  };
  hedgeVenue.onOrder = (order, before) => {
    const saved = world.saved();
    const reason = world.readiness().reason ?? "";
    const signed = order.side === "buy" ? order.size : -order.size;
    const grows = abs(before + signed) > abs(before);
    if (saved?.mode === "stopped" && saved.hardStop === true) {
      world.violate("I7: the hedge sent an order while the maker was hard stopped");
    } else if ((saved !== null && saved.mode !== "run") || reason.includes("maker is stopped")) {
      if (grows) world.violate("I7: the hedge grew its exposure while the maker was not running");
    }
  };
  await start();
  const step = async (seconds = 1): Promise<void> => {
    for (let at = 0; at < seconds; at += 1) {
      await vi.advanceTimersByTimeAsync(SECOND);
      await settle();
      world.sample();
    }
  };
  /** Kills the process and starts another over the same directory and the same exchange. */
  const crash = async (): Promise<void> => {
    await settle();
    for (const loop of loops) loop.stop();
    world.bots = null;
    world.processDied();
  };
  const restart = async (): Promise<void> => {
    await crash();
    await start();
  };
  const stopLoops = (): void => {
    for (const loop of loops) loop.stop();
  };
  const command = async (mode: "run" | "reduce" | "stopped", atMs = Date.now()): Promise<void> => {
    await requestMode(dir, mode, atMs);
    await settle();
  };
  return { dir, world, hedgeVenue, step, crash, restart, start, stopLoops, command };
};

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(START_MS);
  disk.failState = false;
  disk.failMarker = false;
  disk.failMarkerRemoval = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a place call goes wrong", () => {
  it("quotes a healthy ladder first, one ladder at a time", async () => {
    const t = await rig("healthy");

    await t.step(60);

    expect(t.world.placeCalls).toBeGreaterThanOrEqual(LADDER_SIZE * 3);
    expect(t.world.violations()).toEqual([]);
    expect(t.world.readiness().ready).toBe(true);
    t.stopLoops();
  });

  it("holds the maker for good when a place hangs forever, and sends nothing else", async () => {
    const t = await rig("place-hang-forever");
    t.world.placeFaults.push({ kind: "hang-forever" });

    await t.step(300);

    expect(t.world.placeCalls).toBe(1);
    expect(t.world.violations()).toEqual([]);
    expect(t.world.readiness().ready).toBe(false);
    expect(t.world.heard("trading is not ready")).toBe(true);
    t.stopLoops();
  });

  it("waits out a place that lands after its deadline, then quotes again", async () => {
    const t = await rig("place-lands-late", { requoteMs: LONG_REQUOTE_MS });
    t.world.placeFaults.push({ kind: "late", landsAfterMs: 35_000 });

    await t.step(120);

    expect(t.world.violations()).toEqual([]);
    expect(t.world.placeCalls).toBeGreaterThan(LADDER_SIZE);
    expect(t.world.readiness().ready).toBe(true);
    t.stopLoops();
  });

  it("falls back to the soft stop when a place throws after it was sent, and holds meanwhile", async () => {
    const t = await rig("place-throws");
    t.world.placeFaults.push({ kind: "throws" });

    await t.step(90);

    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I2")).toEqual([]);
    expect(t.world.violations("I4")).toEqual([]);
    expect(t.world.heard("fallen back to the soft stop")).toBe(true);
    expect(t.world.saved()?.mode).toBe("reduce");
    expect(t.world.placeCalls).toBe(1);
    t.stopLoops();
  });

  // BUG: a place that throws after dispatch leaves its hold on disk only, so the running maker is not held and trading reads ready.
  it.fails("reads not ready while the hold of a place that threw is on disk", async () => {
    const t = await rig("place-throws-readiness");
    t.world.placeFaults.push({ kind: "throws" });

    await t.step(60);

    expect(t.world.violations("I5")).toEqual([]);
    t.stopLoops();
  });

  // BUG: after a place that threw, a resume sends a full ladder at once; the next dispatch record overwrites the hold.
  it.fails("sends no ladder after a resume while a thrown place's hold lasts", async () => {
    const t = await rig("place-throws-resume");
    t.world.placeFaults.push({ kind: "throws" });
    await t.step(14);
    const thrownAt = Date.now();

    await t.command("run");
    await t.step(15);

    const ladders = t.world.placeLog.filter((entry) => entry.atMs > thrownAt && !entry.reduceOnly);
    expect(ladders).toEqual([]);
    t.stopLoops();
  });

  it("does not stack a second ladder behind a place call that never answers", async () => {
    const t = await rig("place-raw-hang");
    t.world.placeFaults.push({ kind: "raw-hang" });

    await t.step(90);

    expect(t.world.placeCalls).toBe(1);
    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I2")).toEqual([]);
    t.stopLoops();
  });
});

describe("a cancel goes wrong", () => {
  it("places nothing while a cancel hangs, and says so, then recovers when it answers", async () => {
    const t = await rig("cancel-hangs");
    await t.step(20);
    const placedBefore = t.world.placeCalls;
    t.world.cancelFault = { kind: "hang" };

    await t.step(60);

    expect(t.world.placeCalls).toBe(placedBefore);
    expect(t.world.heard("the cancel was not confirmed")).toBe(true);
    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I2")).toEqual([]);

    t.world.cancelFault = null;
    t.world.releaseHungCancels();
    await t.step(30);

    expect(t.world.placeCalls).toBeGreaterThan(placedBefore);
    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I2")).toEqual([]);
    t.stopLoops();
  });

  // BUG: trading() has no input for an unconfirmed cancel, so it reads ready while the quotes may still stand.
  it.fails("reads not ready while a cancel is unconfirmed", async () => {
    const t = await rig("cancel-hangs-readiness");
    await t.step(20);
    t.world.cancelFault = { kind: "hang" };

    await t.step(40);

    expect(t.world.violations("I4")).toEqual([]);
    expect(t.world.violations("I5")).toEqual([]);
    t.stopLoops();
  });

  it("does not place behind a cancel that settles after later ticks", async () => {
    const t = await rig("cancel-settles-late");
    await t.step(20);
    const placedBefore = t.world.placeCalls;
    t.world.cancelFault = { kind: "late", settlesAfterMs: 45_000 };

    await t.step(40);
    expect(t.world.placeCalls).toBe(placedBefore);
    t.world.cancelFault = null;
    await t.step(40);

    expect(t.world.placeCalls).toBeGreaterThan(placedBefore);
    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I2")).toEqual([]);
    t.stopLoops();
  });
});

describe("the disk goes wrong", () => {
  it("stops the maker when a state write fails, keeps it stopped across a restart, and resumes on command", async () => {
    const t = await rig("state-write-fails");
    await t.step(20);
    disk.failState = true;

    await t.step(30);
    const placed = t.world.placeCalls;
    expect(t.world.readiness().ready).toBe(false);
    expect(t.world.markerOnDisk()).toBe(true);

    disk.failState = false;
    await t.restart();
    await t.step(60);
    expect(t.world.placeCalls).toBe(placed);
    expect(t.world.readiness().reason).toContain("stopped");

    await t.command("run");
    await t.step(30);
    expect(t.world.placeCalls).toBeGreaterThan(placed);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("stays stopped while the marker cannot be removed, and resumes once it can", async () => {
    const t = await rig("marker-removal-fails");
    await t.step(20);
    disk.failState = true;
    await t.step(10);
    disk.failState = false;
    const placed = t.world.placeCalls;
    disk.failMarkerRemoval = true;

    await t.command("run");
    await t.step(40);
    expect(t.world.placeCalls).toBe(placed);

    await t.restart();
    await t.step(40);
    expect(t.world.placeCalls).toBe(placed);

    disk.failMarkerRemoval = false;
    await t.step(70);
    expect(t.world.placeCalls).toBeGreaterThan(placed);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("alerts when the state and the marker both fail, refuses to restart on a broken disk, and keeps a stop", async () => {
    const t = await rig("both-writes-fail");
    await t.step(20);
    disk.failState = true;
    disk.failMarker = true;

    await t.step(30);
    const placed = t.world.placeCalls;
    expect(t.world.heard("neither could the recovery marker")).toBe(true);
    expect(t.world.readiness().ready).toBe(false);

    await t.crash();
    await expect(t.start()).rejects.toThrow("does not take a durable write");

    disk.failState = false;
    disk.failMarker = false;
    await t.start();
    await t.step(60);
    expect(t.world.placeCalls).toBeGreaterThan(placed);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("applies a kill switch stop after a restart even when its own save and marker both failed", async () => {
    const t = await rig("stop-not-saved");
    await t.step(20);
    disk.failState = true;
    disk.failMarker = true;
    await t.command("stopped");

    await t.step(10);
    expect(t.world.readiness().ready).toBe(false);

    await t.crash();
    disk.failState = false;
    disk.failMarker = false;
    await t.start();
    const placed = t.world.placeCalls;
    await t.step(60);

    expect(t.world.placeCalls).toBe(placed);
    expect(t.world.liveResting()).toEqual([]);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("starts stopped on a broken disk when the marker is already there, and stays stopped", async () => {
    const t = await rig("restart-disk-still-broken");
    await t.step(20);
    disk.failState = true;
    await t.step(10);
    const placed = t.world.placeCalls;

    await t.crash();
    await t.start();
    await t.command("run");
    await t.step(60);

    expect(t.world.placeCalls).toBe(placed);
    expect(t.world.readiness().ready).toBe(false);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });
});

describe("the prices go wrong", () => {
  for (const mode of ["stale", "down", "hang"] as const) {
    it(`pulls its quotes while the price feed is ${mode}, and quotes again after it has watched the price`, async () => {
      const t = await rig(`feed-${mode}`);
      await t.step(30);
      t.world.feed.mode = mode;
      const failedAt = Date.now();

      await t.step(40);
      const placedWhileDown = t.world.placeLog.filter(
        (entry) => entry.atMs > failedAt + 2 * SECOND,
      );
      expect(placedWhileDown).toEqual([]);
      expect(t.world.liveResting()).toEqual([]);

      t.world.feed.mode = "ok";
      await t.step(30);
      expect(t.world.placeLog.length).toBeGreaterThan(placedWhileDown.length);
      expect(t.world.liveResting().length).toBeGreaterThan(0);
      expect(t.world.violations()).toEqual([]);
      t.stopLoops();
    });
  }

  it("pulls its quotes when the venue mark is far from the reference price", async () => {
    const t = await rig("mark-dislocated");
    await t.step(30);
    t.world.mark = dollars(153);
    const movedAt = Date.now();

    await t.step(20);

    expect(t.world.placeLog.filter((entry) => entry.atMs > movedAt + 2 * SECOND)).toEqual([]);
    expect(t.world.liveResting()).toEqual([]);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("holds its quotes and reads not ready while the venue would refuse them", async () => {
    const t = await rig("venue-refuses");
    await t.step(30);
    t.world.refusedBecause = "the mark is stale";
    const refusedAt = Date.now();

    await t.step(30);

    expect(t.world.placeLog.filter((entry) => entry.atMs > refusedAt + 2 * SECOND)).toEqual([]);
    expect(t.world.readiness().ready).toBe(false);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("reads not ready while the market read hangs, places nothing, and recovers", async () => {
    const t = await rig("markets-hang");
    await t.step(30);
    t.world.marketsHang = true;
    const hungAt = Date.now();

    await t.step(40);
    expect(t.world.readiness().ready).toBe(false);
    expect(t.world.placeLog.filter((entry) => entry.atMs > hungAt + 2 * SECOND)).toEqual([]);
    expect(t.world.liveResting()).toEqual([]);

    t.world.releaseHungMarkets();
    await t.step(40);
    expect(t.world.readiness().ready).toBe(true);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });
});

describe("the process restarts", () => {
  it("is held after a restart in the middle of a ladder until the ladder can no longer rest", async () => {
    const t = await rig("restart-mid-ladder");
    t.world.placeFaults.push({ kind: "ok" }, { kind: "slow", ms: 5_000 });
    await t.step(13);

    await t.restart();
    const restartedAt = Date.now();
    expect(t.world.readiness().ready).toBe(false);
    await t.step(60);

    const quotedAfter = t.world.placeLog.filter((entry) => entry.atMs > restartedAt);
    expect(quotedAfter.length).toBeGreaterThan(0);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("is held after a restart in the middle of an unknown hold, and quotes once it has lapsed", async () => {
    const t = await rig("restart-mid-hold");
    t.world.placeFaults.push({ kind: "hang-forever" });
    await t.step(PLACE_DEADLINE_MS / SECOND + 15);
    expect(t.world.readiness().ready).toBe(false);

    await t.restart();
    expect(t.world.readiness().ready).toBe(false);
    await t.step(120);

    expect(t.world.violations()).toEqual([]);
    expect(t.world.placeCalls).toBeGreaterThan(1);
    expect(t.world.readiness().ready).toBe(true);
    t.stopLoops();
  });

  it("stays held across a restart while a late place may still land", async () => {
    const t = await rig("restart-late-landing", { requoteMs: LONG_REQUOTE_MS });
    t.world.placeFaults.push({ kind: "late", landsAfterMs: 35_000 });
    await t.step(25);

    await t.restart();
    await t.step(120);

    expect(t.world.violations("I1")).toEqual([]);
    expect(t.world.violations("I3")).toEqual([]);
    expect(t.world.placeCalls).toBeGreaterThan(LADDER_SIZE);
    t.stopLoops();
  });

  // BUG: a ladder's saved hold lapses 40 s after its first order, but a later order of the ladder expires later and can still land.
  it.fails("stays held until the last order of a crashed ladder can no longer land", async () => {
    const t = await rig("restart-mid-ladder-late", { requoteMs: LONG_REQUOTE_MS });
    t.world.placeFaults.push({ kind: "slow", ms: 15_000 }, { kind: "late", landsAfterMs: 38_000 });
    await t.step(37);

    await t.restart();
    await t.step(60);

    expect(t.world.violations("I1")).toEqual([]);
    t.stopLoops();
  });
});

describe("the hedge goes wrong", () => {
  const hedged = async (name: string) => {
    const t = await rig(name, { hedge: true });
    t.world.position = dollars(1);
    return t;
  };

  it("hedges the maker once it has settled", async () => {
    const t = await hedged("hedge-baseline");

    await t.step(40);

    expect(t.hedgeVenue.placed.length).toBeGreaterThan(0);
    expect(t.hedgeVenue.position).toBeLessThan(0n);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("does not send a second hedge order after one of unknown outcome that did fill, even across a restart", async () => {
    const t = await hedged("hedge-unknown-filled");
    t.hedgeVenue.script({ lost: true });
    await t.step(25);
    expect(t.hedgeVenue.placed).toHaveLength(1);

    await t.restart();
    await t.step(90);

    expect(t.hedgeVenue.placed).toHaveLength(1);
    expect(t.world.violations("I7")).toEqual([]);
    t.stopLoops();
  });

  // BUG: a hedge order of unknown outcome is told as a notice; only a failed cancel raises an ALERT.
  it.fails("alerts an operator after a hedge order of unknown outcome", async () => {
    const t = await hedged("hedge-unknown-alert");
    t.hedgeVenue.script({ lost: true });

    await t.step(40);

    expect(t.hedgeVenue.placed).toHaveLength(1);
    expect(t.world.heard("hedge")).toBe(true);
    t.stopLoops();
  });

  // BUG: the hedge's unknown order is remembered in memory only, and a restart waits 10 s, not the 60 s quarantine, without looking at the venue's fills.
  it.fails("sends no second hedge order after a restart while the account lags", async () => {
    const t = await hedged("hedge-unknown-then-restart");
    t.hedgeVenue.freezeAccount();
    t.hedgeVenue.script({ lost: true });
    await t.step(25);
    expect(t.hedgeVenue.placed).toHaveLength(1);

    await t.restart();
    await t.step(LATE_DISPATCH_QUARANTINE_MS / SECOND);

    expect(t.hedgeVenue.placed).toHaveLength(1);
    t.stopLoops();
  });

  it("trades nothing once the maker is hard stopped, even when its position moves", async () => {
    const t = await hedged("hedge-hard-stop");
    await t.step(40);
    const placed = t.hedgeVenue.placed.length;

    await t.command("stopped");
    await t.step(5);
    t.world.position = dollars(3);
    await t.step(60);

    expect(t.hedgeVenue.placed).toHaveLength(placed);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("only shrinks at the soft stop", async () => {
    const t = await hedged("hedge-soft-stop");
    await t.step(40);

    await t.command("reduce");
    await t.step(5);
    t.world.position = dollars(3);
    await t.step(30);
    const grownBy = t.hedgeVenue.placed.length;
    t.world.position = dollars(0.5);
    await t.step(30);

    expect(grownBy).toBeGreaterThan(0);
    expect(abs(t.hedgeVenue.position)).toBeLessThanOrEqual(dollars(1));
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });
});

describe("the kill switch", () => {
  it("follows a stop issued in the middle of a ladder and leaves nothing quoted", async () => {
    const t = await rig("stop-mid-ladder", { hedge: true });
    t.world.position = dollars(1);
    t.world.placeFaults.push({ kind: "ok" }, { kind: "slow", ms: 4_000 });
    await t.step(12);

    await t.command("stopped");
    await t.step(30);
    const placed = t.world.placeCalls;
    await t.step(30);

    expect(t.world.placeCalls).toBe(placed);
    expect(t.world.liveResting()).toEqual([]);
    expect(t.world.readiness().reason).toContain("stopped");
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("is not undone by a resume command dated before a loss-limit stop, or by a restart", async () => {
    const t = await rig("stale-resume-after-loss-stop");
    await t.step(5);
    await t.command("run");
    await t.step(30);
    t.world.equity = dollars(960);
    await t.step(5);
    t.world.equity = dollars(900);
    await t.step(10);
    expect(t.world.saved()?.mode).toBe("stopped");
    const placed = t.world.placeCalls;

    await t.step(30);
    await t.restart();
    await t.step(60);

    expect(t.world.saved()?.mode).toBe("stopped");
    expect(t.world.placeCalls).toBe(placed);
    expect(t.world.liveResting()).toEqual([]);
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("is not undone by a resume command left over from before a start without saved state", async () => {
    const t = await rig("stale-resume-mainnet", { network: "mainnet" });
    await t.crash();
    await requestMode(t.dir, "run", START_MS - 60_000);
    vi.setSystemTime(START_MS);
    await t.start();

    await t.step(60);

    expect(t.world.placeCalls).toBe(0);
    expect(t.world.readiness().reason).toContain("stopped");
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });

  it("keeps an unbounded hold until a resume dated after the unknown order", async () => {
    const t = await rig("hold-review");
    t.world.position = dollars(1);
    await t.command("reduce");
    await t.step(14);
    t.world.placeFaults.push({ kind: "late", landsAfterMs: PLACE_DEADLINE_MS + 5_000 });
    await t.step(80);
    expect(t.world.readiness().ready).toBe(false);
    const heldFrom = t.world.saved()?.hold?.lastAtMs ?? 0;
    expect(heldFrom).toBeGreaterThan(0);

    await requestMode(t.dir, "run", heldFrom - 1);
    await t.step(30);
    expect(t.world.saved()?.hold).not.toBeNull();

    await t.command("run");
    await t.step(30);
    expect(t.world.saved()?.hold ?? null).toBeNull();
    expect(t.world.violations()).toEqual([]);
    t.stopLoops();
  });
});

describe("the harness itself", () => {
  it("notices an order sent while an earlier place call is unsettled", async () => {
    const world = new World();
    world.dir = join(ROOT, "harness-control");
    const venue = world.venueFor(0);
    const order: NewOrder = {
      market: PERP,
      side: "buy",
      type: "postOnly",
      price: dollars(149),
      size: dollars(0.3),
      expiresInSeconds: 20,
    };
    world.placeFaults.push({ kind: "hang-forever" });
    const first = venue.placeOrder("maker", order);
    await vi.advanceTimersByTimeAsync(PLACE_DEADLINE_MS);
    await first;

    await venue.placeOrder("maker", order);

    expect(world.violations("I2")).toHaveLength(1);
  });

  it("writes the control file where the service reads it", async () => {
    const t = await rig("control-path");

    await t.command("reduce");

    expect(existsSync(controlPath(t.dir))).toBe(true);
    t.stopLoops();
  });
});
