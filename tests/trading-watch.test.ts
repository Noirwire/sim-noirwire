import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { TradingWatch } from "../src/wiring/trading-watch.js";

const MINUTE = 60_000;

const watched = (startReady = true) => {
  const said = { alerts: [] as string[], notices: [] as string[] };
  const state: { ready: boolean; reason?: string } = { ready: startReady };
  const clock = new ManualClock(0);
  const make = () =>
    new TradingWatch(
      () => state,
      {
        alert: (message) => said.alerts.push(message),
        notice: (message) => said.notices.push(message),
      },
      clock,
    );
  return { said, state, clock, watch: make(), make };
};

describe("the trading readiness watch", () => {
  it("says nothing while trading is ready", () => {
    const { said, watch } = watched();

    watch.check();
    watch.check();

    expect(said).toEqual({ alerts: [], notices: [] });
  });

  it("alerts once when trading stops being ready, and gives a notice once when it recovers", () => {
    const { said, state, watch } = watched();
    watch.check();

    state.ready = false;
    state.reason = "NSOL-PERP hedge is blind";
    watch.check();
    watch.check();

    expect(said.alerts).toEqual(["ALERT trading is not ready: NSOL-PERP hedge is blind"]);

    state.ready = true;
    watch.check();
    watch.check();

    expect(said.notices).toEqual(["trading is ready again"]);
    expect(said.alerts).toHaveLength(1);
  });

  it("alerts again for a second outage", () => {
    const { said, state, watch } = watched();
    watch.check();

    state.ready = false;
    watch.check();
    state.ready = true;
    watch.check();
    state.ready = false;
    watch.check();

    expect(said.alerts).toHaveLength(2);
  });

  it("alerts again after 2 minutes of a hold, then every 10 minutes while it stands", () => {
    const { said, state, clock, watch } = watched();
    watch.check();
    state.ready = false;
    state.reason = "NSOL-PERP maker is held by an order of unknown outcome";
    watch.check();
    expect(said.alerts).toHaveLength(1);

    clock.advance(MINUTE);
    watch.check();
    expect(said.alerts).toHaveLength(1);

    clock.advance(MINUTE);
    watch.check();
    expect(said.alerts).toHaveLength(2);
    expect(said.alerts[1]).toContain("2 min");

    clock.advance(9 * MINUTE);
    watch.check();
    expect(said.alerts).toHaveLength(2);

    clock.advance(MINUTE);
    watch.check();
    expect(said.alerts).toHaveLength(3);
    expect(said.alerts[2]).toContain("12 min");
  });

  it("doubles the wait between repeats up to 4 hours, so an 11-hour hold gives 8 alerts and one notice when it clears", () => {
    const { said, state, clock, watch } = watched();
    watch.check();
    state.ready = false;
    state.reason = "NSOL-PERP maker is only reducing its position";
    const alertedAt: number[] = [];
    for (let minute = 0; minute <= 660; minute += 1) {
      const before = said.alerts.length;
      watch.check();
      if (said.alerts.length > before) alertedAt.push(minute);
      clock.advance(MINUTE);
    }

    expect(alertedAt).toEqual([0, 2, 12, 32, 72, 152, 312, 552]);
    expect(said.notices).toEqual([]);

    state.ready = true;
    watch.check();
    expect(said.notices).toEqual(["trading is ready again"]);
  });

  it("alerts at once for a new kind of reason mid-outage, even inside a long repeat gap", () => {
    const { said, state, clock, watch } = watched();
    watch.check();
    state.ready = false;
    state.reason = "NSOL-PERP: the Pyth price is 42 s old";
    for (let minute = 0; minute <= 400; minute += 1) {
      watch.check();
      clock.advance(MINUTE);
    }
    const before = said.alerts.length;

    state.reason = "NSOL-PERP maker is held by an order of unknown outcome";
    watch.check();

    expect(said.alerts.length - before).toBe(1);
    expect(said.alerts.at(-1)).toBe(
      "ALERT trading is still not ready, for a new reason: NSOL-PERP maker is held by an order of unknown outcome",
    );
  });

  it("does not add alerts when the reason flaps between kinds already seen with different numbers", () => {
    const { said, state, clock, watch } = watched();
    watch.check();
    state.ready = false;
    state.reason = "NSOL-PERP maker has had no quotes resting for 25391 s";
    watch.check();
    state.reason = "NSOL-PERP: the Pyth price is 42 s old";
    watch.check();
    const before = said.alerts.length;

    for (let second = 1; second <= 20; second += 1) {
      clock.advance(1_000);
      state.reason =
        second % 2 === 0
          ? `NSOL-PERP maker has had no quotes resting for ${25391 + second} s`
          : `NSOL-PERP: the Pyth price is ${42 + second} s old`;
      watch.check();
    }

    expect(said.alerts.length).toBe(before);
  });

  it("forgets the seen kinds when trading is ready again", () => {
    const { said, state, watch } = watched();
    watch.check();
    state.ready = false;
    state.reason = "NSOL-PERP: the Pyth price is 42 s old";
    watch.check();
    state.ready = true;
    watch.check();
    state.ready = false;
    watch.check();
    state.reason = "NSOL-PERP: the Pyth price is 55 s old";
    watch.check();

    expect(said.alerts).toHaveLength(2);
  });

  it("starts the repeats over at 10 minutes for a second outage", () => {
    const { said, state, clock, watch } = watched();
    watch.check();
    state.ready = false;
    for (let minute = 0; minute <= 33; minute += 1) {
      watch.check();
      clock.advance(MINUTE);
    }
    state.ready = true;
    watch.check();
    const before = said.alerts.length;

    state.ready = false;
    for (let minute = 0; minute <= 12; minute += 1) {
      watch.check();
      clock.advance(MINUTE);
    }

    expect(said.alerts.length - before).toBe(3);
    expect(said.alerts.at(-1)).toContain("12 min");
  });

  describe("after a wake", () => {
    it("stays quiet through the blind settle window, then watches normally", () => {
      const { said, state, clock, make } = watched(false);
      state.reason = "NSOL-PERP hedge is blind";

      const afterWake = make();
      afterWake.check();
      clock.advance(10_000);
      afterWake.check();
      expect(said).toEqual({ alerts: [], notices: [] });

      state.ready = true;
      afterWake.check();
      expect(said).toEqual({ alerts: [], notices: [] });

      state.ready = false;
      afterWake.check();
      expect(said.alerts).toHaveLength(1);
    });

    it("stays quiet on each wake of a sleep and wake cycle", () => {
      const { said, state, make } = watched();
      state.ready = true;
      const first = make();
      first.check();

      state.ready = false;
      state.reason = "NSOL-PERP hedge is blind";
      const second = make();
      second.check();
      state.ready = true;
      second.check();

      expect(said).toEqual({ alerts: [], notices: [] });
    });

    it("alerts across repeated short wakes while trading stays not ready", () => {
      const { said, state, clock, watch } = watched();
      watch.check();
      state.ready = false;
      state.reason = "NSOL-PERP quotes would be refused: its mark is 90 s old";
      watch.check();
      expect(said.alerts).toHaveLength(1);

      for (let wake = 0; wake < 3; wake += 1) {
        clock.advance(MINUTE);
        watch.resume();
        watch.check();
        clock.advance(30_000);
        watch.check();
      }

      expect(said.alerts.some((line) => line.includes("has not been ready for"))).toBe(true);
    });

    it("alerts across short wakes of a service that never became ready", () => {
      const { said, state, clock, watch } = watched(false);
      state.reason = "NSOL-PERP hedge is blind";

      for (let wake = 0; wake < 3; wake += 1) {
        watch.resume();
        watch.check();
        clock.advance(50_000);
        watch.check();
      }

      expect(said.alerts).toHaveLength(1);
      expect(said.alerts[0]).toContain("has not been ready for 2 min");
    });

    it("stays quiet for a blind hedge that settles after a wake when trading was ready before it", () => {
      const { said, state, clock, watch } = watched();
      watch.check();

      watch.resume();
      state.ready = false;
      state.reason = "NSOL-PERP hedge is blind";
      watch.check();
      clock.advance(30_000);
      watch.check();
      state.ready = true;
      watch.check();

      expect(said.alerts).toEqual([]);
    });

    it("still alerts when trading never becomes ready after a wake", () => {
      const { said, state, clock, make } = watched(false);
      state.reason = "NSOL-PERP hedge is blind";
      const afterWake = make();

      afterWake.check();
      clock.advance(2 * MINUTE);
      afterWake.check();

      expect(said.alerts).toHaveLength(1);
      expect(said.alerts[0]).toContain("2 min");
    });
  });
});
