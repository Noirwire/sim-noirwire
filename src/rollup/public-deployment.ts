import { type Config, isMainnet } from "../config/config.js";
import type { ChainMarket, PublicAddresses } from "./chain-types.js";
import type { Deployment } from "./settings.js";

interface PublicToken {
  symbol: string;
  mint: string;
  decimals: number;
}

interface PublicMarket {
  /** The id every instruction and address of this market is built from. */
  marketId: number;
  /** This service's id for the market, the one `/v1/markets` uses, whatever the deployment calls it. */
  symbol: string;
  kind: "spot" | "perp";
  market: string;
  tape: string;
  priceFeed: string;
  /** Null on a perpetual: its base is not a token anyone holds. */
  baseToken: PublicToken | null;
  quoteToken: PublicToken;
  baseDecimals: number;
  quoteDecimals: number;
  /** Base atoms in one lot. A size on chain is a whole number of lots. */
  lotSize: string;
  /** Quote atoms per lot in one price step. */
  tick: string;
}

/** What a browser needs to trade on the program directly. Every value is public on chain. */
export interface PublicDeployment {
  network: string;
  programId: string;
  solanaRpcUrl: string;
  rollupRpcUrl: string;
  rollupWsUrl: string;
  exchange: string;
  stats: string;
  markets: PublicMarket[];
}

export interface BrowserUrls {
  solanaRpcUrl: string;
  rollupRpcUrl: string;
  rollupWsUrl: string;
}

/**
 * The addresses a browser is told. Off mainnet they default to the service's
 * own. On mainnet those may carry an API key, so only the PUBLIC_ addresses
 * are ever used and a missing one is an error, never a fallback.
 */
export const browserUrlsFor = (
  config: Pick<
    Config,
    "NETWORK" | "PUBLIC_SOLANA_RPC_URL" | "PUBLIC_ROLLUP_RPC_URL" | "PUBLIC_ROLLUP_WS_URL"
  >,
  own: BrowserUrls,
): BrowserUrls => {
  const pick = (name: string, configured: string | undefined, fallback: string): string => {
    if (configured) return configured;
    if (isMainnet(config)) {
      throw new Error(
        `${name} is not set, and on mainnet the service never tells browsers its private address. Set ${name}.`,
      );
    }
    return fallback;
  };
  return {
    solanaRpcUrl: pick("PUBLIC_SOLANA_RPC_URL", config.PUBLIC_SOLANA_RPC_URL, own.solanaRpcUrl),
    rollupRpcUrl: pick("PUBLIC_ROLLUP_RPC_URL", config.PUBLIC_ROLLUP_RPC_URL, own.rollupRpcUrl),
    rollupWsUrl: pick("PUBLIC_ROLLUP_WS_URL", config.PUBLIC_ROLLUP_WS_URL, own.rollupWsUrl),
  };
};

/**
 * Built field by field from what is public: nothing of the deployment
 * description or of this service's settings is passed through whole, so a
 * key or an internal URL cannot ride along.
 */
export const publicDeployment = (
  deployment: Deployment,
  urls: BrowserUrls,
  markets: { chain: ChainMarket; symbol: string; addresses: PublicAddresses }[],
): PublicDeployment => {
  const token = (index: number): PublicToken => {
    const found = deployment.tokens.find((entry) => entry.index === index);
    if (!found) throw new Error(`the deployment has no token ${index}`);
    return { symbol: found.symbol, mint: found.mint, decimals: found.decimals };
  };
  const first = markets[0];
  if (!first) throw new Error("no markets to describe");
  return {
    network: deployment.network,
    programId: deployment.programId,
    solanaRpcUrl: urls.solanaRpcUrl,
    rollupRpcUrl: urls.rollupRpcUrl,
    rollupWsUrl: urls.rollupWsUrl,
    exchange: first.addresses.exchange,
    stats: first.addresses.stats,
    markets: markets.map(({ chain, symbol, addresses }) => {
      const described = deployment.markets.find((market) => market.id === chain.marketId);
      if (!described) throw new Error(`the deployment has no market ${chain.marketId}`);
      const quoteToken = token(chain.quoteToken);
      return {
        marketId: chain.marketId,
        symbol,
        kind: chain.kind,
        market: addresses.market,
        tape: addresses.tape,
        priceFeed: addresses.priceFeed,
        baseToken: chain.kind === "spot" ? token(chain.baseToken) : null,
        quoteToken,
        baseDecimals: described.baseDecimals,
        quoteDecimals: quoteToken.decimals,
        lotSize: chain.baseLot.toString(),
        tick: chain.tick.toString(),
      };
    }),
  };
};
