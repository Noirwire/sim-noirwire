import type { Deployment } from "./settings.js";

export type DeployedToken = Deployment["tokens"][number];

/** The collateral of every perpetual, and the quote of every market. */
export const COLLATERAL_TOKEN = "nUSD";

/**
 * This service's token names and the symbols a deployment may give them: the
 * test mints of a test network, or the quote token of a mainnet-profile
 * deployment, which is USDC (a test mint of the same decimals off mainnet).
 */
const CHAIN_SYMBOLS_OF: Record<string, string[]> = { nUSD: ["nUSD", "USDC"], SOL: ["nSOL"] };

export const deployedToken = (
  deployment: Deployment,
  simToken: string,
): DeployedToken | undefined =>
  deployment.tokens.find((token) => CHAIN_SYMBOLS_OF[simToken]?.includes(token.symbol));

export const simTokenOf = (chainSymbol: string): string | undefined =>
  Object.keys(CHAIN_SYMBOLS_OF).find((name) => CHAIN_SYMBOLS_OF[name]?.includes(chainSymbol));
