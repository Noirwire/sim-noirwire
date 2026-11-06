import type { MarginReading } from "./free-collateral.js";

const BPS = 10_000n;
/** The share of the requirement a maker keeps in collateral after sending surplus out, in tenths. */
const COLLATERAL_KEPT_TENTHS = 11n;

/** Where equity sits against the larger of the initial margin now and the margin of the full ladder, in bps. */
export interface Bands {
  urgentBps: number;
  lowBps: number;
  targetBps: number;
  surplusBps: number;
}

export const DEFAULT_BANDS: Bands = {
  urgentBps: 12_000,
  lowBps: 15_000,
  targetBps: 22_000,
  surplusBps: 35_000,
};

export interface PlannerSettings {
  bands: Bands;
  /** Amounts are whole multiples of this, in quote atoms. */
  stepAtoms: bigint;
  /** The most one request may ask for, in quote atoms. */
  maxRequestAtoms: bigint;
}

export type Direction = "out" | "in";

export interface RebalancePlan {
  direction: Direction;
  amount: bigint;
  /** Below the urgent band: waiting out a cooldown is not worth it. */
  urgent: boolean;
}

const roundUp = (value: bigint, step: bigint): bigint => ((value + step - 1n) / step) * step;
const roundDown = (value: bigint, step: bigint): bigint => (value / step) * step;

/** The ratio of equity to `requirement` in bps, rounded down; null when nothing is required. */
export const ratioBps = (equity: bigint, requirement: bigint): bigint | null =>
  requirement > 0n ? (equity * BPS) / requirement : null;

/**
 * Whether to ask for collateral in or out, and how much, or null inside the dead zone.
 * `requirement` is the larger of the initial margin now and that of the full ladder.
 * Equity below the low band asks for the amount that brings it to the target, rounded up to
 * the step; equity above the surplus band offers the amount above the target, rounded down,
 * and never more than can be withdrawn.
 */
export const planRebalance = (
  reading: MarginReading,
  requirement: bigint,
  settings: PlannerSettings,
): RebalancePlan | null => {
  if (requirement <= 0n) return null;
  const { bands, stepAtoms, maxRequestAtoms } = settings;
  const cap = roundDown(maxRequestAtoms, stepAtoms);
  const { equity, collateral, withdrawable } = reading;
  const target = (BigInt(bands.targetBps) * requirement) / BPS;
  if (equity * BPS < BigInt(bands.lowBps) * requirement) {
    const wanted = roundUp(target - equity, stepAtoms);
    const amount = wanted > cap ? cap : wanted;
    if (amount < stepAtoms) return null;
    return {
      direction: "in",
      amount,
      urgent: equity * BPS < BigInt(bands.urgentBps) * requirement,
    };
  }
  if (equity * BPS > BigInt(bands.surplusBps) * requirement) {
    const keepCollateral = (requirement * COLLATERAL_KEPT_TENTHS + 9n) / 10n;
    const limits = [equity - target, collateral - keepCollateral, withdrawable];
    const spare = limits.reduce((least, limit) => (limit < least ? limit : least));
    const offered = roundDown(spare > 0n ? spare : 0n, stepAtoms);
    const amount = offered > cap ? cap : offered;
    if (amount < stepAtoms) return null;
    return { direction: "out", amount, urgent: false };
  }
  return null;
};
