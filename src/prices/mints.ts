import type { MarketId } from "../engine/types.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

/** The real token whose price each market mirrors. */
export const MARKETS_PRICED_BY: Record<string, MarketId[]> = {
  [SOL_MINT]: ["NSOL-PERP", "NSOL-NUSD"],
  [NVDAX_MINT]: ["NNVDA-PERP"],
};
