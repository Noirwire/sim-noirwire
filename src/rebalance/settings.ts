import type { Config } from "../config/config.js";
import type { PlannerSettings } from "./planner.js";

export interface RebalanceSettings {
  url: string;
  token: string;
  bridgeAta: string;
  validator: string;
  planner: PlannerSettings;
  cooldownMs: number;
  checkMs: number;
}

/**
 * The rebalancing settings, or null while REBALANCE_URL is unset: then none of it runs.
 * Throws with the names of whatever is missing or wrong, never a value.
 */
export const rebalanceSettings = (config: Config): RebalanceSettings | null => {
  if (!config.REBALANCE_URL) return null;
  const missing = (
    ["REBALANCE_TOKEN", "REBALANCE_BRIDGE_ATA", "REBALANCE_VALIDATOR"] as const
  ).filter((name) => !config[name]);
  if (missing.length > 0) throw new Error(`REBALANCE_URL needs ${missing.join(", ")}`);
  const bands = {
    urgentBps: config.REBALANCE_URGENT_BPS,
    lowBps: config.REBALANCE_LOW_BPS,
    targetBps: config.REBALANCE_TARGET_BPS,
    surplusBps: config.REBALANCE_SURPLUS_BPS,
  };
  if (!(
    bands.urgentBps < bands.lowBps &&
    bands.lowBps < bands.targetBps &&
    bands.targetBps < bands.surplusBps
  )) {
    throw new Error(
      "REBALANCE_URGENT_BPS, REBALANCE_LOW_BPS, REBALANCE_TARGET_BPS and REBALANCE_SURPLUS_BPS must rise in that order",
    );
  }
  if (
    config.REBALANCE_STEP_USDC <= 0n ||
    config.REBALANCE_MAX_REQUEST_USDC < config.REBALANCE_STEP_USDC
  ) {
    throw new Error(
      "REBALANCE_MAX_REQUEST_USDC must be at least REBALANCE_STEP_USDC, which must be above 0",
    );
  }
  return {
    url: config.REBALANCE_URL,
    token: config.REBALANCE_TOKEN ?? "",
    bridgeAta: config.REBALANCE_BRIDGE_ATA ?? "",
    validator: config.REBALANCE_VALIDATOR ?? "",
    planner: {
      bands,
      stepAtoms: config.REBALANCE_STEP_USDC,
      maxRequestAtoms: config.REBALANCE_MAX_REQUEST_USDC,
    },
    cooldownMs: config.REBALANCE_COOLDOWN_MS,
    checkMs: config.REBALANCE_CHECK_MS,
  };
};
