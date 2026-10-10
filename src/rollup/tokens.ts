import type { Deployment } from "./settings.js";

export type DeployedToken = Deployment["tokens"][number];

/** The collateral of every perpetual, and the quote of every market. */
export const COLLATERAL_TOKEN = "nUSD";

/** This service's token names and the symbols a deployment gives the test mints. */
const CHAIN_SYMBOL_OF: Record<string, string> = { nUSD: "nUSD", SOL: "nSOL" };

export const deployedToken = (
  deployment: Deployment,
  simToken: string,
): DeployedToken | undefined =>
  deployment.tokens.find((token) => token.symbol === CHAIN_SYMBOL_OF[simToken]);

export const simTokenOf = (chainSymbol: string): string | undefined =>
  Object.keys(CHAIN_SYMBOL_OF).find((name) => CHAIN_SYMBOL_OF[name] === chainSymbol);
