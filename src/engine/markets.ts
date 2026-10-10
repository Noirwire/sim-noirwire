import type { MarketId, MarketKind } from "./types.js";

export interface MarketConfig {
  id: MarketId;
  kind: MarketKind;
  base: string;
  quote: string;
  tickSize: bigint;
  lotSize: bigint;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationPenaltyBps: number;
  takerFeeBps: number;
  maxStalePriceMs: number;
}

export const MARKETS: readonly MarketConfig[] = [
  {
    id: "NSOL-PERP",
    kind: "perp",
    base: "SOL",
    quote: "nUSD",
    tickSize: 10_000n,
    lotSize: 1_000n,
    initialMarginBps: 1_000,
    maintenanceMarginBps: 500,
    liquidationPenaltyBps: 100,
    takerFeeBps: 5,
    maxStalePriceMs: 30_000,
  },
  {
    id: "NNVDA-PERP",
    kind: "perp",
    base: "NVDAx",
    quote: "nUSD",
    tickSize: 10_000n,
    lotSize: 100n,
    initialMarginBps: 1_000,
    maintenanceMarginBps: 500,
    liquidationPenaltyBps: 100,
    takerFeeBps: 5,
    maxStalePriceMs: 30_000,
  },
  {
    id: "NSOL-NUSD",
    kind: "spot",
    base: "SOL",
    quote: "nUSD",
    tickSize: 10_000n,
    lotSize: 1_000n,
    initialMarginBps: 0,
    maintenanceMarginBps: 0,
    liquidationPenaltyBps: 0,
    takerFeeBps: 5,
    maxStalePriceMs: 30_000,
  },
];

export const MARKET_IDS = MARKETS.map((market) => market.id) as [MarketId, ...MarketId[]];

export const PERP_MARKET_IDS = MARKETS.filter((market) => market.kind === "perp").map(
  (market) => market.id,
);

export const marketById = (id: MarketId): MarketConfig | undefined =>
  MARKETS.find((market) => market.id === id);

const BPS_PER_WHOLE = 10_000;

/** A market with no margin requirement has no leverage to speak of. */
export const maxLeverageAt = (initialMarginBps: number): number =>
  initialMarginBps === 0 ? 0 : Math.floor(BPS_PER_WHOLE / initialMarginBps);
