import type { CandleAggregator } from "../data/candles.js";
import type { SnapshotData } from "../data/snapshot.js";
import type { StatsTracker } from "../data/stats.js";
import type { TapeStore } from "../data/tape-store.js";
import type { MarketConfig } from "../engine/markets.js";
import type { Fill, MarketId, TraderKey, Venue } from "../engine/types.js";
import type { RollupRoutes } from "../http/context.js";
import type { Hub } from "../http/hub.js";

export interface PublicData {
  tape: TapeStore;
  candles: CandleAggregator;
  stats: StatsTracker;
  hub: Hub;
}

export interface BotSizes {
  makerLevel: bigint;
  takerMin: bigint;
  takerMax: bigint;
  lotSize: bigint;
  takerStartingBase: bigint;
}

/** What differs between the two venues when the service is put together. */
export interface VenueWiring {
  venue: Venue;
  /** The venue as the bots use it, with their orders counted as bot activity. */
  botVenue: Venue;
  rollupRoutes: Partial<RollupRoutes>;
  botSizes(market: MarketConfig): Promise<BotSizes>;
  liquidationTargets(): TraderKey[];
  /** Runs once every maker is open and funded, before the first bot tick. */
  afterMakersOpen(): Promise<void>;
  acceptPricePoint(market: MarketId, price: bigint, atMs: number): void;
  /** False when the venue advances perpetual funding itself. */
  needsFundingUpdater: boolean;
  snapshotExtras(): Partial<SnapshotData>;
  stop(): Promise<void>;
}

/** A fill that is news: onto the tape, into the candles and out over the websocket. */
export const recordAndBroadcastFill = (fill: Fill, { tape, candles, hub }: PublicData): void => {
  tape.record(fill);
  candles.record(fill);
  hub.broadcastFill(fill);
  const [latestMinute] = candles.candles(fill.market, "1m", 1);
  if (latestMinute) hub.broadcastCandle(fill.market, "1m", latestMinute);
};
