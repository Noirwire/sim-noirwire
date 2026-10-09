import type { Clock } from "../engine/clock.js";
import type { MarketId, Venue } from "../engine/types.js";

export interface FundingUpdaterOptions {
  markets: MarketId[];
  intervalMs: number;
  clock: Clock;
}

/** Calls `updateFunding` for every perp market once per configured interval. */
export class FundingUpdater {
  private nextDueAtMs = -Infinity;

  constructor(private readonly options: FundingUpdaterOptions) {}

  async tick(venue: Venue): Promise<void> {
    const now = this.options.clock.nowMs();
    if (now < this.nextDueAtMs) return;
    for (const market of this.options.markets) {
      await venue.updateFunding(market);
    }
    this.nextDueAtMs = now + this.options.intervalMs;
  }
}
