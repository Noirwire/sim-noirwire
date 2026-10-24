import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MakerMode } from "../src/bots/maker-state.js";
import { ManualClock } from "../src/engine/clock.js";
import { HedgeController } from "../src/hedge/hedge-controller.js";
import { HEDGE_LIMITS, LATE_DISPATCH_QUARANTINE_MS } from "../src/hedge/hedge-limits.js";
import {
  type SavedOrders,
  UnknownOrderStore,
  hedgeOrderPath,
} from "../src/hedge/unknown-order-store.js";
import { FakeHedgeVenue } from "./fake-hedge-venue.js";
import { dollars } from "./helpers.js";

const START_MS = Date.parse("2026-11-02T12:00:00Z");
const MARKET = "NSOL-PERP";
const root = join(process.cwd(), "data-test", `hedge-unknown-order-${process.pid}`);

afterAll(() => rm(root, { recursive: true, force: true }));

/** A store whose disk takes no write. */
class FailingStore extends UnknownOrderStore {
  override async save(): Promise<void> {
    throw new Error("EROFS: the disk is read-only");
  }
}

/** A controller over the given venue and clock, saving to `path`, as one process of the service. */
const process_ = (venue: FakeHedgeVenue, clock: ManualClock, saved: string | SavedOrders) => {
  const said = { alerts: [] as string[], notices: [] as string[] };
  const maker = { position: dollars(1), mode: "run" as MakerMode };
  const controller = new HedgeController({
    venue,
    clock,
    reference: { read: async () => ({ ok: true, price: dollars(150) }) },
    makerPosition: async () => maker.position,
    makerMode: () => maker.mode,
    voice: {
      alert: (message) => said.alerts.push(message),
      notice: (message) => said.notices.push(message),
    },
    market: MARKET,
    settings: {
      softUnhedgedNotional: dollars(100),
      hardUnhedgedNotional: dollars(250),
      confirmTimeoutMs: 60_000,
      maxLeverage: 3,
    },
    unknownOrders: typeof saved === "string" ? new UnknownOrderStore(saved) : saved,
  });
  const tick = async (seconds = 1) => {
    clock.advance(seconds * 1_000);
    await controller.tick();
  };
  return { controller, said, tick, maker };
};

const fresh = async (name: string) => {
  const dir = join(root, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const clock = new ManualClock(START_MS);
  const venue = new FakeHedgeVenue();
  venue.now = () => clock.nowMs();
  return { dir, path: hedgeOrderPath(dir, MARKET), clock, venue };
};

describe("a hedge order of unknown outcome", () => {
  it("raises one alert, not one per tick", async () => {
    const { clock, venue, path } = await fresh("alert-once");
    const { said, tick } = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.script({ lost: true });

    for (let at = 0; at < 5; at += 1) await tick();

    expect(venue.placed).toHaveLength(1);
    expect(said.alerts.filter((line) => line.includes("unknown outcome"))).toHaveLength(1);
  });

  it("is saved before it is sent, and a restart reads it back and sends nothing while the account lags", async () => {
    const { clock, venue, path } = await fresh("restart");
    const first = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.freezeAccount();
    venue.script({ lost: true });
    await first.tick();
    expect(venue.placed).toHaveLength(1);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.order.clientId).toBe(venue.placed[0]?.clientId);

    const second = process_(venue, clock, path);
    for (let at = 0; at < LATE_DISPATCH_QUARANTINE_MS / 1_000 + 30; at += 1) await second.tick();

    expect(venue.placed).toHaveLength(1);
    expect(second.said.notices.some((line) => line.includes("from before the restart"))).toBe(true);
  });

  it("is let go once the account shows the fill after the quarantine, and the saved order is cleared", async () => {
    const { clock, venue, path } = await fresh("released");
    const first = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.freezeAccount();
    venue.script({ lost: true });
    await first.tick();

    const second = process_(venue, clock, path);
    await second.tick(LATE_DISPATCH_QUARANTINE_MS / 1_000 + 1);
    venue.unfreezeAccount();
    await second.tick();
    await second.tick();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ order: null });
    expect(venue.placed).toHaveLength(1);
  });

  it("is not sent at all when it cannot be saved", async () => {
    const { clock, venue, path } = await fresh("write-fails");
    const { said, tick } = process_(venue, clock, new FailingStore(path));
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);

    await tick();
    await tick();

    expect(venue.placed).toHaveLength(0);
    expect(said.alerts.filter((line) => line.includes("could not be saved"))).toHaveLength(1);
  });

  it("stops the hedge, and alerts, when the saved order is corrupt", async () => {
    const { clock, venue, path } = await fresh("corrupt");
    await writeFile(path, "{not json");
    const { controller, said, tick } = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);

    await tick();
    await tick();

    expect(venue.placed).toHaveLength(0);
    expect(controller.status()).toBe("blind");
    expect(said.alerts.filter((line) => line.includes("cannot be read"))).toHaveLength(1);
  });
});

describe("a hedge order of unknown outcome and an oversized hedge", () => {
  /** The first order is lost while the account endpoint lags; then the maker's position and mode change. */
  const afterLostOrder = async (
    name: string,
    start: { hedge: bigint; maker: bigint },
    lost: { maker: bigint },
    then: { maker: bigint },
  ) => {
    const { clock, venue, path } = await fresh(name);
    const t = process_(venue, clock, path);
    venue.position = start.hedge;
    t.maker.position = lost.maker;
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.freezeAccount();
    venue.script({ lost: true });
    await t.tick();
    expect(venue.placed).toHaveLength(1);
    t.maker.mode = "reduce";
    t.maker.position = then.maker;
    for (let at = 0; at < 20; at += 1) await t.tick();
    return { venue, path, ...t };
  };

  it("shrinks by no more than the smallest position the hedge could really hold, if the unknown order grew it", async () => {
    // Read -2; the lost sell of 1 may have taken it to -3. Wanting a buy of 2 is safe: -3 + 2 stays short.
    const { venue } = await afterLostOrder(
      "shrink-short",
      { hedge: dollars(-2), maker: dollars(2) },
      { maker: dollars(3) },
      { maker: 0n },
    );

    expect(venue.placed).toHaveLength(2);
    expect(venue.placed[1]).toMatchObject({ side: "buy", size: dollars(2), reduceOnly: true });
  });

  it("cuts the shrink so it cannot cross zero if the unknown order shrank the hedge too", async () => {
    // Read -2; the lost buy of 1 may have taken it to -1. A buy of 2 could cross zero, so only 1 goes.
    const { venue } = await afterLostOrder(
      "shrink-cut",
      { hedge: dollars(-2), maker: dollars(1) },
      { maker: dollars(1) },
      { maker: 0n },
    );

    expect(venue.placed).toHaveLength(2);
    expect(venue.placed[1]).toMatchObject({ side: "buy", size: dollars(1), reduceOnly: true });
  });

  it("sends nothing when the possible positions reach zero", async () => {
    const { venue } = await afterLostOrder(
      "shrink-straddles",
      { hedge: dollars(-1), maker: 0n },
      { maker: 0n },
      { maker: 0n },
    );

    expect(venue.placed).toHaveLength(1);
  });

  it("never grows the hedge while an order is unexplained, even in run mode", async () => {
    const { clock, venue, path } = await fresh("never-grows");
    const t = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.freezeAccount();
    venue.script({ lost: true });
    await t.tick();
    t.maker.position = dollars(5);
    for (let at = 0; at < 20; at += 1) await t.tick();

    expect(venue.placed).toHaveLength(1);
  });

  it("saves the wider bounds before a shrink is sent, and sends nothing when that save fails", async () => {
    const { clock, venue, path } = await fresh("shrink-save");
    const t = process_(venue, clock, new FailAfterFirstSave(path));
    venue.position = dollars(-2);
    t.maker.position = dollars(3);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.freezeAccount();
    venue.script({ lost: true });
    await t.tick();
    t.maker.mode = "reduce";
    t.maker.position = 0n;

    for (let at = 0; at < 20; at += 1) await t.tick();

    expect(venue.placed).toHaveLength(1);
    expect(t.said.alerts.some((line) => line.includes("could not be saved"))).toBe(true);
  });
});

describe("a hedge order of unknown outcome under a hard stop", () => {
  it("retries the cancel and reconciles once the account catches up, sending nothing new", async () => {
    const { clock, venue, path } = await fresh("hard-stop");
    const t = process_(venue, clock, path);
    clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
    venue.cancelFails = true;
    venue.freezeAccount();
    venue.script({ lost: true });
    await t.tick();
    const clientId = venue.placed[0]?.clientId ?? "";
    expect(venue.cancelled).toEqual([]);

    t.maker.mode = "stopped";
    venue.cancelFails = false;
    for (let at = 0; at < 5; at += 1) await t.tick();
    expect(venue.cancelled).toContain(clientId);

    venue.unfreezeAccount();
    for (let at = 0; at < LATE_DISPATCH_QUARANTINE_MS / 1_000 + 5; at += 1) await t.tick();

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ order: null });
    expect(venue.placed).toHaveLength(1);
  });
});

/** Takes the first write and refuses the rest. */
class FailAfterFirstSave extends UnknownOrderStore {
  private saved = false;

  override async save(record: Parameters<UnknownOrderStore["save"]>[0]): Promise<void> {
    if (this.saved) throw new Error("EROFS: the disk is read-only");
    this.saved = true;
    await super.save(record);
  }
}
