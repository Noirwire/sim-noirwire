import { STILL_STARTING } from "../../engine/venue-not-ready.js";
import type { AppContext } from "../context.js";

/**
 * Why a desk cannot be asked right now, or null. The request that got here
 * already asked for activity, so a service that is asleep is waking.
 */
export const deskUnavailable = (ctx: AppContext): string | null => {
  const readiness = ctx.readiness?.();
  if (ctx.startUp && !ctx.startUp.ready) return STILL_STARTING;
  if (readiness && !readiness.botsFunded) return STILL_STARTING;
  if (ctx.activity.phase !== "awake") return "the service is waking up, try again in a few seconds";
  if (readiness && !readiness.connected) {
    return "the rollup cannot be reached right now, try again";
  }
  return null;
};
