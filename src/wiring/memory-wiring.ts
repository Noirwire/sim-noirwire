import { withBotTracking } from "../bots/instrumented-venue.js";
import type { Config } from "../config/config.js";
import { MemoryVenue } from "../engine/memory-venue.js";
import { type PublicData, type VenueWiring, recordAndBroadcastFill } from "./venue-wiring.js";

const MAKER_LEVEL_LOTS = 5n;
const TAKER_MIN_LOTS = 1n;
const TAKER_MAX_LOTS = 20n;

export const memoryWiring = (config: Config, data: PublicData): VenueWiring => {
  const venue = new MemoryVenue({
    insuranceSeedBalance: config.INSURANCE_SEED_NUSD,
    maxFundingRateBpsPerUpdate: config.MAX_FUNDING_RATE_BPS_PER_UPDATE,
  });
  venue.onFill((fill) => recordAndBroadcastFill(fill, data));
  return {
    venue,
    botVenue: withBotTracking(venue, data.stats),
    rollupRoutes: {},
    botSizes: async (market) => ({
      makerLevel: market.lotSize * MAKER_LEVEL_LOTS,
      takerMin: market.lotSize * TAKER_MIN_LOTS,
      takerMax: market.lotSize * TAKER_MAX_LOTS,
      lotSize: market.lotSize,
      takerStartingBase: config.NOISE_TAKER_STARTING_BASE,
    }),
    liquidationTargets: () => data.stats.allTraderKeys(),
    afterMakersOpen: async () => {},
    acceptPricePoint: (market, price, atMs) => {
      void venue.publishPrice(market, price, atMs);
      data.hub.broadcastPrice(market, price, atMs);
    },
    needsFundingUpdater: true,
    snapshotExtras: () => ({}),
    stop: async () => {},
  };
};
