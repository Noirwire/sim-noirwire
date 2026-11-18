import { z } from "zod";
import { STILL_STARTING } from "../../engine/venue-not-ready.js";
import type { AppContext } from "../context.js";
import { base58Address } from "../schemas.js";

export const DESK_UNREACHABLE = "the rollup did not answer, try again";
export const DESK_BUSY = "the desk is busy with another request, try again";
const ORDER_KEYS_PER_TRADER = 4;
/** Well above an open or open-and-fund transaction in base64, well below anything worth parsing. */
const MAX_TRANSACTION_CHARS = 4_096;

export const ownerAndOrderKeys = {
  owner: base58Address,
  orderKeys: z.array(base58Address).length(ORDER_KEYS_PER_TRADER),
};

export const submitSchema = z.object({
  owner: base58Address,
  transaction: z
    .string()
    .min(1)
    .max(MAX_TRANSACTION_CHARS)
    .regex(/^[A-Za-z0-9+/]+=*$/, "must be base64"),
});

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
