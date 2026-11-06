import type { MarketId } from "../engine/types.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

/** The real token whose price each market mirrors. */
export const MARKETS_PRICED_BY: Record<string, MarketId[]> = {
  [SOL_MINT]: ["NSOL-PERP", "NSOL-NUSD"],
  [NVDAX_MINT]: ["NNVDA-PERP"],
};

/** Whether a price source in this process follows the market: the in-memory venue runs only these. */
export const isPricedByMints = (market: MarketId): boolean =>
  Object.values(MARKETS_PRICED_BY).some((markets) => markets.includes(market));
