import { ManualClock } from "../src/engine/clock.js";
import { SCALE } from "../src/engine/money.js";
import { MemoryVenue, type MemoryVenueOptions } from "../src/engine/memory-venue.js";
import type { MarketId, TraderKey } from "../src/engine/types.js";

export const dollars = (amount: number): bigint => BigInt(Math.round(amount * Number(SCALE)));

export const makeVenue = (
  options: MemoryVenueOptions = {},
): { venue: MemoryVenue; clock: ManualClock } => {
  const clock = new ManualClock(1_000_000);
  const venue = new MemoryVenue({ clock, ...options });
  return { venue, clock };
};

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
