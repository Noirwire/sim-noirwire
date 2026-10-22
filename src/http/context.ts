import type { Activity } from "../activity/activity.js";
import type { Config } from "../config/config.js";
import type { CandleAggregator } from "../data/candles.js";
import type { FundLedger } from "../data/fund-ledger.js";
import type { StatsTracker } from "../data/stats.js";
import type { TapeStore } from "../data/tape-store.js";
import type { Venue } from "../engine/types.js";
import type { StartUp } from "../scheduling/start-up.js";
import type { FundRequests } from "../rollup/fund-desk.js";
import type { OpenRequests } from "../rollup/open-desk.js";
import type { PublicDeployment } from "../rollup/public-deployment.js";
import type { Readiness } from "../rollup/rollup-venue.js";
import type { Hub } from "./hub.js";

/** VENUE=rollup only: what the routes need of the on-chain venue. */
export interface RollupRoutes {
  /** Opens and funds a user's account on chain. */
  fundDesk: FundRequests;
  /** Mainnet only: opens an account for an invited user, and funds nothing. */
  openDesk: OpenRequests;
  /** Whether the service is connected, pricing and funded. */
  readiness: () => Readiness;
  /** What a browser needs to trade on the program directly, or null until the service has connected. */
  deployment: () => PublicDeployment | null;
}

/** Where a route reports what went wrong that its caller is not told. */
export interface RouteProblems {
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
}

export interface AppContext extends Partial<RollupRoutes> {
  config: Config;
  /** The service's problem log. Without it a route's unexpected failures are not logged. */
  problems?: RouteProblems;
  venue: Venue;
  tape: TapeStore;
  candles: CandleAggregator;
  stats: StatsTracker;
  fundLedger: FundLedger;
  hub: Hub;
  /** Whether anybody wants the service to be busy. */
  activity: Activity;
  /** VENUE=rollup only: the one-time work that has to finish before the service is useful. */
  startUp?: Pick<StartUp, "ready" | "problem">;
}
