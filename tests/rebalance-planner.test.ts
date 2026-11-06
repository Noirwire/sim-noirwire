import { describe, expect, it } from "vitest";
import {
  DEFAULT_BANDS,
  type PlannerSettings,
  planRebalance,
  ratioBps,
} from "../src/rebalance/planner.js";

const USDC = 1_000_000n;
const R = 1_000n * USDC;
const settings: PlannerSettings = {
  bands: DEFAULT_BANDS,
  stepAtoms: 25n * USDC,
  maxRequestAtoms: 500n * USDC,
  minRequirementAtoms: 0n,
};

/** A seat with this equity (as bps of R), all of it collateral. */
const at = (bps: bigint) => {
  const equity = (bps * R) / 10_000n;
  return { collateral: equity, equity, initialMargin: 0n, withdrawable: equity };
};

describe("the rebalance planner", () => {
  it("measures the ratio in bps", () => {
    expect(ratioBps(at(22_000n).equity, R)).toBe(22_000n);
    expect(ratioBps(1n, 0n)).toBeNull();
  });

  it("does nothing on the band edges and inside the dead zone", () => {
    expect(planRebalance(at(15_000n), R, settings)).toBeNull();
    expect(planRebalance(at(22_000n), R, settings)).toBeNull();
    expect(planRebalance(at(35_000n), R, settings)).toBeNull();
  });

  it("asks for collateral just below the low band, up to the target, rounded up", () => {
    const plan = planRebalance({ ...at(14_999n) }, R, settings);
    // target 2200 USDC less equity 1499.9 USDC = 700.1, capped at 500
    expect(plan).toEqual({ direction: "in", amount: 500n * USDC, urgent: false });
  });

  it("rounds an ask up to the step", () => {
    const plan = planRebalance(
      {
        collateral: 1_450n * USDC,
        equity: 1_450n * USDC + 1n,
        initialMargin: 0n,
        withdrawable: 0n,
      },
      1_000n * USDC,
      { ...settings, maxRequestAtoms: 5_000n * USDC },
    );
    // wants 2200 - 1450.000001 = 749.999999 -> 750
    expect(plan?.amount).toBe(750n * USDC);
  });

  it("marks the ask urgent only below the urgent band", () => {
    expect(planRebalance(at(12_000n), R, settings)?.urgent).toBe(false);
    expect(planRebalance(at(11_999n), R, settings)?.urgent).toBe(true);
    expect(planRebalance(at(11_999n), R, settings)?.direction).toBe("in");
  });

  it("offers surplus just above the surplus band, down to the target, rounded down", () => {
    const plan = planRebalance(at(35_001n), R, { ...settings, maxRequestAtoms: 5_000n * USDC });
    // equity 3500.1 - target 2200 = 1300.1 -> 1300, collateral - 1.1R = 2400.1 leaves room
    expect(plan).toEqual({ direction: "out", amount: 1_300n * USDC, urgent: false });
  });

  it("caps a request at the maximum, rounded down to the step", () => {
    expect(
      planRebalance(at(60_000n), R, { ...settings, maxRequestAtoms: 510n * USDC })?.amount,
    ).toBe(500n * USDC);
  });

  it("never offers more than can be withdrawn or than leaves 1.1 times the requirement in collateral", () => {
    const base = at(40_000n);
    expect(planRebalance({ ...base, withdrawable: 60n * USDC }, R, settings)?.amount).toBe(
      50n * USDC,
    );
    expect(planRebalance({ ...base, collateral: 1_120n * USDC }, R, settings)).toBeNull();
    expect(planRebalance({ ...base, collateral: 1_200n * USDC }, R, settings)?.amount).toBe(
      100n * USDC,
    );
  });

  it("offers nothing when less than a step is spare", () => {
    expect(planRebalance({ ...at(40_000n), withdrawable: 24n * USDC }, R, settings)).toBeNull();
  });

  it("ignores small PnL swings when the requirement is tiny", () => {
    const floored = { ...settings, minRequirementAtoms: 1_000n * USDC };
    const tiny = 5n * USDC;
    for (const equity of [2_199n * USDC, 2_200n * USDC, 2_201n * USDC]) {
      const reading = { collateral: equity, equity, initialMargin: 0n, withdrawable: equity };
      expect(planRebalance(reading, tiny, floored)).toBeNull();
    }
    expect(planRebalance(at(22_000n), tiny, settings)).not.toBeNull();
  });

  it("behaves as before when the requirement is above the floor", () => {
    const floored = { ...settings, minRequirementAtoms: 1_000n * USDC };
    const big = 4_000n * USDC;
    for (const bps of [5_000n, 11_999n, 14_999n, 22_000n, 35_001n, 90_000n]) {
      const equity = (bps * big) / 10_000n;
      const reading = { collateral: equity, equity, initialMargin: 0n, withdrawable: equity };
      expect(planRebalance(reading, big, floored)).toEqual(planRebalance(reading, big, settings));
    }
  });

  it("keeps the real requirement for the collateral guard", () => {
    const floored = { ...settings, minRequirementAtoms: 1_000n * USDC };
    const reading = {
      collateral: 6n * USDC,
      equity: 4_000n * USDC,
      initialMargin: 0n,
      withdrawable: 4_000n * USDC,
    };
    expect(planRebalance(reading, 5n * USDC, floored)).toBeNull();
  });

  it("does nothing without a requirement", () => {
    expect(planRebalance(at(40_000n), 0n, settings)).toBeNull();
  });
});
