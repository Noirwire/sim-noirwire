import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MakerLedger, type MakerMode, makerStatePath } from "../src/bots/maker-state.js";
import { ManualClock } from "../src/engine/clock.js";
import { HedgeController } from "../src/hedge/hedge-controller.js";
import { HEDGE_LIMITS } from "../src/hedge/hedge-limits.js";
import type { Reference } from "../src/prices/reference-price.js";
import { FakeHedgeVenue } from "./fake-hedge-venue.js";
import { dollars } from "./helpers.js";

const START_MS = Date.parse("2026-11-02T12:00:00Z");
const MARKET = "NSOL-PERP";

const rig = (settled = true, modeOf?: () => MakerMode) => {
  const clock = new ManualClock(START_MS);
  const venue = new FakeHedgeVenue();
  venue.now = () => clock.nowMs();
  const said = { alerts: [] as string[], notices: [] as string[] };
  const state = {
    maker: 0n,
    mode: "run" as MakerMode,
    reference: { ok: true, price: dollars(150) } as Reference,
  };
  const controller = new HedgeController({
    venue,
    clock,
    reference: { read: async () => state.reference },
    makerPosition: async () => state.maker,
    makerMode: () => (modeOf ? modeOf() : state.mode),
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
  });
  if (settled) clock.advance(HEDGE_LIMITS.settleAfterUnknownMs);
  /** Moves the clock on, then runs one tick. */
  const tick = async (seconds = 1) => {
    clock.advance(seconds * 1_000);
    await controller.tick();
  };
  return { clock, venue, said, state, controller, tick };
};

describe("the hedge controller", () => {
  it("is blind until the venue has answered once", () => {
    expect(rig().controller.status()).toBe("blind");
  });

  it("hedges the maker's position and records the hedge and when the venue confirmed it", async () => {
    const { venue, state, controller, tick, clock } = rig();
    state.maker = dollars(1);

    await tick();

    expect(venue.position).toBe(dollars(-1));
    expect(controller.hedgedPosition).toBe(dollars(-1));
    expect(controller.lastConfirmedAtMs).toBe(clock.nowMs());
    expect(controller.status()).toBe("ok");
  });

  it("sends no order while the maker's exposure is already hedged", async () => {
    const { venue, state, tick } = rig();
    state.maker = dollars(1);
    await tick();
    await tick();

    expect(venue.placed).toHaveLength(1);
  });

  describe("right after a restart", () => {
    it("sends no order inside the settle window, even when the decision calls for one", async () => {
      const { venue, state, controller, tick } = rig(false);
      state.maker = dollars(1);

      await tick(1);
      await tick(5);
      await tick(3);

      expect(venue.placed).toHaveLength(0);
      expect(controller.hedgedPosition).toBe(0n);
    });

    it("sends the order once the window has passed", async () => {
      const { venue, state, tick } = rig(false);
      state.maker = dollars(1);

      await tick(5);
      expect(venue.placed).toHaveLength(0);

      await tick(5);
      expect(venue.placed).toHaveLength(1);
      expect(venue.position).toBe(dollars(-1));
    });

    it("reports blind inside the settle window so the maker cannot add exposure", async () => {
      const { controller, tick } = rig(false);

      await tick(1);
      expect(controller.status()).toBe("blind");

      await tick(10);
      expect(controller.status()).not.toBe("blind");
    });

    it("says once that it is waiting for the venue to settle", async () => {
      const { said, state, tick } = rig(false);
      state.maker = dollars(1);

      await tick(1);
      await tick(1);
      await tick(1);
      await tick(10);

      expect(said.notices.filter((line) => line.includes("settle after a restart"))).toHaveLength(
        1,
      );
    });
  });

  describe("reconciling from the venue's position", () => {
    it("recomputes after a partial fill and sends what is left", async () => {
      const { venue, state, tick } = rig();
      venue.script({ fill: dollars(0.4) });
      state.maker = dollars(1);

      await tick();
      expect(venue.position).toBe(dollars(-0.4));

      await tick();
      expect(venue.placed.map((order) => order.size)).toEqual([dollars(1), dollars(0.6)]);
      expect(venue.position).toBe(dollars(-1));
    });

    it("does not send again after a lost answer to an order that filled", async () => {
      const { venue, state, said, tick } = rig();
      venue.script({ lost: true });
      state.maker = dollars(1);

      await tick();
      expect(venue.position).toBe(dollars(-1));
      expect(said.notices.some((line) => line.includes("unknown outcome"))).toBe(true);
      expect(venue.cancelled).toHaveLength(1);

      state.maker = dollars(1.5);
      await tick();
      expect(venue.placed).toHaveLength(1);

      await tick(11);
      expect(venue.placed.map((order) => order.size)).toEqual([dollars(1), dollars(0.5)]);
    });

    it("waits out the unknown outcome of an order that did not fill, then trusts the position", async () => {
      const { venue, state, tick } = rig();
      venue.script({ lost: true, fill: 0n });
      state.maker = dollars(1);

      await tick();
      await tick();
      expect(venue.placed).toHaveLength(1);

      await tick(11);
      expect(venue.placed).toHaveLength(2);
      expect(venue.position).toBe(dollars(-1));
    });

    it("sends no second order when the reply was lost, the cancel failed and the account read stays stale", async () => {
      const { venue, state, said, controller, tick } = rig();
      venue.script({ lost: true });
      venue.cancelFails = true;
      venue.freezeAccount();
      state.maker = dollars(1);

      await tick();
      for (let i = 0; i < 5; i += 1) await tick(15);
      expect(venue.placed).toHaveLength(1);
      expect(venue.position).toBe(dollars(-1));
      expect(said.alerts.filter((line) => line.includes("could not be cancelled"))).toHaveLength(1);

      venue.unfreezeAccount();
      await tick();
      expect(controller.hedgedPosition).toBe(dollars(-1));
      await tick(15);
      expect(venue.placed).toHaveLength(1);
    });

    it("holds while a cancel keeps failing, and resends once an order that did not fill is cancelled", async () => {
      const { venue, state, tick } = rig();
      venue.script({ lost: true, fill: 0n });
      venue.cancelFails = true;
      state.maker = dollars(1);

      await tick();
      await tick(15);
      await tick(15);
      expect(venue.placed).toHaveLength(1);

      venue.cancelFails = false;
      await tick(1);
      expect(venue.placed).toHaveLength(2);
      expect(venue.position).toBe(dollars(-1));
    });

    it("does not send a second order while an accepted one has not shown in the position", async () => {
      const { venue, state, controller, tick } = rig();
      venue.script({ delayed: true });
      state.maker = dollars(1);

      await tick();
      await tick();
      expect(venue.placed).toHaveLength(1);

      venue.deliverDelayed();
      await tick();
      expect(controller.hedgedPosition).toBe(dollars(-1));

      await tick(11);
      expect(venue.placed).toHaveLength(1);
      expect(controller.status()).toBe("ok");
    });

    it("holds off after a refusal and then tries again", async () => {
      const { venue, state, said, tick } = rig();
      venue.script({ reject: "not enough margin" });
      state.maker = dollars(1);

      await tick();
      await tick();
      expect(venue.placed).toHaveLength(1);
      expect(said.notices.some((line) => line.includes("not enough margin"))).toBe(true);

      await tick(6);
      expect(venue.placed).toHaveLength(2);
      expect(venue.position).toBe(dollars(-1));
    });
  });

  describe("when the venue goes away", () => {
    it("is blind, trades nothing, and recovers when the venue answers again", async () => {
      const { venue, state, said, controller, tick } = rig();
      state.maker = dollars(1);
      await tick();
      expect(controller.status()).toBe("ok");

      venue.down = true;
      state.maker = dollars(2);
      await tick();
      expect(controller.status()).toBe("blind");
      expect(venue.placed).toHaveLength(1);
      expect(said.notices.some((line) => line.includes("cannot be reached"))).toBe(true);

      venue.down = false;
      await tick();
      expect(venue.placed).toHaveLength(2);
      expect(controller.status()).toBe("ok");
      expect(said.notices.some((line) => line.includes("answers again"))).toBe(true);
    });

    it("is blind while the venue reports that it is not trading", async () => {
      const { venue, controller, tick } = rig();
      await tick();
      expect(controller.status()).toBe("ok");

      venue.unhealthyBecause = "the venue is halted";
      await tick();
      expect(controller.status()).toBe("blind");
    });

    it("is blind when the controller has stopped ticking for longer than the timeout", async () => {
      const { controller, tick, clock } = rig();
      await tick();
      clock.advance(61_000);

      expect(controller.status()).toBe("blind");
    });
  });

  describe("status thresholds", () => {
    it("is lagging past the soft limit and blind past the hard limit", async () => {
      const { venue, state, controller, tick } = rig();
      await tick();
      venue.script({ reject: "no liquidity" });
      state.maker = dollars(1);
      await tick();
      expect(controller.status()).toBe("lagging");

      state.maker = dollars(2);
      await tick();
      expect(controller.status()).toBe("blind");
    });

    it("is lagging when the venue has confirmed nothing for the timeout", async () => {
      const { venue, state, controller, tick } = rig();
      await tick();
      venue.script({ reject: "a" }, { reject: "b" }, { reject: "c" });
      state.maker = dollars(0.5);
      await tick();
      expect(controller.status()).toBe("ok");

      await tick(30);
      await tick(30);
      expect(controller.status()).toBe("lagging");
    });

    it("stays ok with exposure between the trigger and the soft limit while every order is held", async () => {
      const { venue, state, controller, tick } = rig();
      venue.rulesNow = { ...venue.rulesNow, minOrderNotional: dollars(1_000) };
      await tick();
      state.maker = dollars(0.5);

      for (let i = 0; i < 5; i += 1) await tick(30);

      expect(venue.placed).toHaveLength(0);
      expect(controller.status()).toBe("ok");
    });

    it("still lags when the exposure is above the soft limit and nothing confirms it", async () => {
      const { venue, state, controller, tick } = rig();
      venue.rulesNow = { ...venue.rulesNow, minOrderNotional: dollars(1_000) };
      await tick();
      state.maker = dollars(0.8);

      await tick(30);
      await tick(30);

      expect(controller.status()).toBe("lagging");
    });

    it("treats the last price as missing once it is too old", async () => {
      const { venue, state, controller, tick } = rig();
      await tick();
      venue.script({ reject: "no liquidity" });
      state.maker = dollars(0.5);
      await tick();
      state.reference = { ok: false, reason: "the sources went dark" };

      await tick(5);
      expect(controller.status()).toBe("ok");

      await tick(10);
      expect(controller.status()).toBe("blind");
    });

    it("sends nothing and lags when the reference price is not trusted", async () => {
      const { venue, state, controller, tick } = rig();
      await tick();
      state.reference = { ok: false, reason: "the sources disagree" };
      state.maker = dollars(1);
      await tick();

      expect(venue.placed).toHaveLength(0);
      expect(controller.status()).toBe("lagging");
    });
  });

  describe("the maker's kill switch", () => {
    it("opens no new hedge at the soft stop, but still shrinks the hedge as the maker shrinks", async () => {
      const { venue, state, tick } = rig();
      state.mode = "reduce";
      state.maker = dollars(1);
      await tick();
      expect(venue.placed).toHaveLength(0);

      venue.position = dollars(-1);
      state.maker = dollars(0.4);
      await tick();
      expect(venue.placed).toMatchObject([{ side: "buy", size: dollars(0.6), reduceOnly: true }]);
    });

    it("trades nothing at the hard stop, and says once that the hedge is unmanaged", async () => {
      const { venue, state, said, tick } = rig();
      venue.position = dollars(-1);
      state.mode = "stopped";
      state.maker = dollars(5);

      await tick();
      await tick();

      expect(venue.placed).toHaveLength(0);
      expect(said.alerts).toHaveLength(1);
      expect(said.alerts[0]).toMatch(/ALERT .*-1\.0 SOL.*unmanaged/);

      state.mode = "run";
      await tick();
      expect(venue.placed).toHaveLength(1);
    });
  });

  describe("when the maker's state cannot be saved", () => {
    const root = join("data-test", `hedge-fault-${Date.now()}`);
    afterAll(() => rm(root, { recursive: true, force: true }));

    const faultedLedger = async (name: string): Promise<MakerLedger> => {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      const path = makerStatePath(dir, MARKET);
      const ledger = await MakerLedger.open(path);
      await mkdir(path);
      await expect(ledger.update({ peakEquity: dollars(1_000) })).rejects.toThrow();
      return ledger;
    };

    it("still shrinks the hedge as the maker shrinks, and opens nothing new", async () => {
      const ledger = await faultedLedger("shrinks");
      expect(ledger.state.mode).toBe("stopped");
      const { venue, state, said, tick } = rig(true, () => ledger.hedgeMode);
      venue.position = dollars(-1);

      state.maker = dollars(5);
      await tick();
      expect(venue.placed).toHaveLength(0);

      state.maker = dollars(0.4);
      await tick();
      expect(venue.placed).toMatchObject([{ side: "buy", size: dollars(0.6), reduceOnly: true }]);
      expect(said.alerts.filter((line) => line.includes("unmanaged"))).toHaveLength(0);
    });

    it("still reads a hard stop as stopped when its own save fails", async () => {
      const dir = join(root, "hard-stop-unsaved");
      await mkdir(dir, { recursive: true });
      const path = makerStatePath(dir, MARKET);
      const ledger = await MakerLedger.open(path);
      await mkdir(path);
      await expect(ledger.update({ mode: "stopped", reason: "the loss limit" })).rejects.toThrow();
      expect(ledger.hedgeMode).toBe("stopped");
      const { venue, state, tick } = rig(true, () => ledger.hedgeMode);
      venue.position = dollars(-1);
      state.maker = dollars(0.4);

      await tick();

      expect(venue.placed).toHaveLength(0);
    });

    it("keeps a hard stop saved while the marker stood as stopped after a restart, but a marker alone as reduce", async () => {
      const dir = join(root, "stop-saved-under-marker");
      await mkdir(dir, { recursive: true });
      const path = makerStatePath(dir, MARKET);
      const ledger = await MakerLedger.open(path);
      await mkdir(path);
      await expect(ledger.update({ peakEquity: dollars(1_000) })).rejects.toThrow();
      await rm(path, { recursive: true });
      await ledger.update({ mode: "stopped", reason: "the kill switch", lastCommandAtMs: 7 });

      const restarted = await MakerLedger.open(path);
      expect(restarted.hedgeMode).toBe("stopped");
      const { venue, state, tick } = rig(true, () => restarted.hedgeMode);
      venue.position = dollars(-1);
      state.maker = dollars(0.4);
      await tick();
      expect(venue.placed).toHaveLength(0);

      await rm(path);
      await writeFile(
        path,
        JSON.stringify({
          mode: "run",
          reason: null,
          flattenStartedAtMs: null,
          day: null,
          dayStartEquity: null,
          peakEquity: null,
          lastCommandAtMs: 7,
          spotBaseAtStart: null,
        }),
      );
      const markerOnly = await MakerLedger.open(path);
      expect(markerOnly.state.mode).toBe("stopped");
      expect(markerOnly.hedgeMode).toBe("reduce");
    });

    it("still abandons the hedge at an intentional hard stop", async () => {
      const dir = join(root, "intentional");
      await mkdir(dir, { recursive: true });
      const ledger = await MakerLedger.open(makerStatePath(dir, MARKET));
      await ledger.update({ mode: "stopped", reason: "the kill switch stopped it" });
      const { venue, state, tick } = rig(true, () => ledger.hedgeMode);
      venue.position = dollars(-1);
      state.maker = dollars(0.4);

      await tick();

      expect(venue.placed).toHaveLength(0);
    });
  });
});
