import type { CandleAggregator } from "../data/candles.js";
import type { FundLedger } from "../data/fund-ledger.js";
import type { StatsTracker } from "../data/stats.js";
import type { TapeStore } from "../data/tape-store.js";
import type { Config } from "../config/config.js";
import type { Venue } from "../engine/types.js";
import type { FundingDesk } from "../rollup/funding-desk.js";
import type { Readiness } from "../rollup/rollup-venue.js";
import type { Hub } from "./hub.js";

export interface AppContext {
  config: Config;
  venue: Venue;
  tape: TapeStore;
  candles: CandleAggregator;
  stats: StatsTracker;
  fundLedger: FundLedger;
  hub: Hub;
  /** VENUE=rollup only: opens and funds a user's account on chain. */
  funding?: FundingDesk;
  /** VENUE=rollup only: whether the service is connected, pricing and funded. */
  readiness?: () => Readiness;
}
