import { describe, expect, it } from "vitest";
import { DAY_MS, DayVolume, PriceHistory, percentChange } from "../src/engine/day-window.js";

const HOUR_MS = 60 * 60 * 1000;

describe("the 24 hour window both venues report from", () => {
  it("counts the volume of the last 24 hours and nothing older", () => {
    const volume = new DayVolume();
    volume.add(0, 100n);
    volume.add(2 * HOUR_MS, 40n);
    expect(volume.total(2 * HOUR_MS)).toBe(140n);
    expect(volume.total(DAY_MS + HOUR_MS)).toBe(40n);
    expect(volume.total(DAY_MS + 3 * HOUR_MS)).toBe(0n);
  });

  it("measures the change from the oldest price still inside the window", () => {
    const history = new PriceHistory(DAY_MS);
    history.add(0, 100_000_000n);
    history.add(10 * HOUR_MS, 110_000_000n);
    history.add(30 * HOUR_MS, 121_000_000n);
    expect(percentChange(history.firstSince(30 * HOUR_MS - DAY_MS), 121_000_000n)).toBeCloseTo(10);
  });

  it("reports no change at all when there is no price to compare with", () => {
    const history = new PriceHistory(DAY_MS);
    expect(percentChange(history.firstSince(0), 121_000_000n)).toBeNull();
    history.add(0, 100_000_000n);
    expect(percentChange(history.firstSince(DAY_MS), 121_000_000n)).toBeNull();
    expect(history.latest()).toBe(100_000_000n);
  });
});
