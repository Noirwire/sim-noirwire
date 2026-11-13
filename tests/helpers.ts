import { ManualClock } from "../src/engine/clock.js";
import { SCALE } from "../src/engine/money.js";
import { MemoryVenue, type MemoryVenueOptions } from "../src/engine/memory-venue.js";
import type { MarketConfig } from "../src/engine/markets.js";
import type { MarketId, TraderKey, Venue } from "../src/engine/types.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";

export const dollars = (amount: number): bigint => BigInt(Math.round(amount * Number(SCALE)));

export const makeVenue = (
  options: MemoryVenueOptions = {},
): { venue: MemoryVenue; clock: ManualClock } => {
  const clock = new ManualClock(1_000_000);
  const venue = new MemoryVenue({ clock, ...options });
  return { venue, clock };
};

export const makerWiring = (
  venue: Venue,
  botMarket: MarketConfig,
  botVenue: Venue = venue,
): VenueWiring =>
  ({
    venue,
    botVenue,
    botMarkets: [botMarket],
    botSizes: async () => ({
      makerLevel: dollars(0.3),
      takerMin: 0n,
      takerMax: 0n,
      lotSize: dollars(0.001),
      takerStartingBase: 0n,
    }),
    afterMakersOpen: async () => {},
    needsFundingUpdater: false,
    liquidationTargets: () => [],
  }) as unknown as VenueWiring;

export const openFunded = async (
  venue: MemoryVenue,
  trader: TraderKey,
  deposits: Record<string, number>,
): Promise<void> => {
  await venue.openTrader(trader);
  for (const [token, amount] of Object.entries(deposits)) {
    await venue.deposit(trader, token, dollars(amount));
  }
};

export const publish = async (
  venue: MemoryVenue,
  clock: ManualClock,
  market: MarketId,
  price: number,
): Promise<void> => {
  await venue.publishPrice(market, dollars(price), clock.nowMs());
};
