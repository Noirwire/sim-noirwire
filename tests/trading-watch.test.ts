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
