import type { Config } from "../config/config.js";
import type { CandleAggregator } from "../data/candles.js";
import type { FundLedger } from "../data/fund-ledger.js";
import type { StatsTracker } from "../data/stats.js";
import type { TapeStore } from "../data/tape-store.js";
import type { Venue } from "../engine/types.js";
import type { FundDesk } from "../rollup/fund-desk.js";
import type { PublicDeployment } from "../rollup/public-deployment.js";
import type { Readiness } from "../rollup/rollup-venue.js";
import type { Hub } from "./hub.js";

/** VENUE=rollup only: what the routes need of the on-chain venue. */
export interface RollupRoutes {
  /** Opens and funds a user's account on chain. */
  fundDesk: FundDesk;
  /** Whether the service is connected, pricing and funded. */
  readiness: () => Readiness;
  /** What a browser needs to trade on the program directly. */
  deployment: PublicDeployment;
}

export interface AppContext extends Partial<RollupRoutes> {
  config: Config;
  venue: Venue;
  tape: TapeStore;
  candles: CandleAggregator;
  stats: StatsTracker;
  fundLedger: FundLedger;
  hub: Hub;
}
