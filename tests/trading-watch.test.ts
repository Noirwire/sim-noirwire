import { describe, expect, it } from "vitest";
import { TradingWatch } from "../src/wiring/trading-watch.js";

const watched = () => {
  const said = { alerts: [] as string[], notices: [] as string[] };
  const state: { ready: boolean; reason?: string } = { ready: true };
  const watch = new TradingWatch(() => state, {
    alert: (message) => said.alerts.push(message),
    notice: (message) => said.notices.push(message),
  });
  return { said, state, watch };
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

    state.ready = false;
    watch.check();
    state.ready = true;
    watch.check();
    state.ready = false;
    watch.check();

    expect(said.alerts).toHaveLength(2);
  });
});
