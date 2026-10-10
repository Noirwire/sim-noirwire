import { z } from "zod";
import { MARKET_IDS } from "../engine/markets.js";

export const marketId = z.enum(MARKET_IDS);

export const base58Address = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must look like a base58 address");
