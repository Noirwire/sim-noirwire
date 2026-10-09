import type { MarketId, TraderKey, Venue } from "../engine/types.js";
import { liquidatorTraderKey } from "./bot-traders.js";

export interface LiquidatorOptions {
  markets: MarketId[];
  startingBalanceQuote: bigint;
}

/**
 * Walks every known perpetual trader on every perp market and asks the
 * venue to liquidate anyone who qualifies. The venue itself is the only
 * place that decides eligibility (equity vs. maintenance margin) and the
 * execution price; this bot is just the scan loop that calls it.
 */
export class Liquidator {
  private readonly trader = liquidatorTraderKey;
  private opened = false;

  constructor(private readonly options: LiquidatorOptions) {}

  async tick(venue: Venue, knownTraders: Iterable<TraderKey>): Promise<number> {
    if (!this.opened) {
      await venue.openTrader(this.trader);
      await venue.deposit(this.trader, "nUSD", this.options.startingBalanceQuote);
      this.opened = true;
    }

    let liquidations = 0;
    for (const market of this.options.markets) {
      for (const target of knownTraders) {
        if (target === this.trader) continue;
        const liquidated = await venue.liquidate(this.trader, target, market);
        if (liquidated) liquidations += 1;
      }
    }
    return liquidations;
  }
}
