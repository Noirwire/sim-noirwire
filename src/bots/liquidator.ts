import type { MarketId, TraderKey, Venue } from "../engine/types.js";
import { liquidatorTraderKey } from "./bot-traders.js";

export interface LiquidatorOptions {
  markets: MarketId[];
  startingQuoteBalance: bigint;
}

/**
 * Asks the venue to liquidate each target on each perpetual market. The
 * venue alone decides who qualifies and at what price; this is the scan loop.
 */
export class Liquidator {
  private readonly trader = liquidatorTraderKey;
  private opened = false;

  constructor(private readonly options: LiquidatorOptions) {}

  async tick(venue: Venue, targets: Iterable<TraderKey>): Promise<void> {
    if (!this.opened) {
      await venue.openTrader(this.trader);
      await venue.deposit(this.trader, "nUSD", this.options.startingQuoteBalance);
      this.opened = true;
    }

    for (const market of this.options.markets) {
      for (const target of targets) {
        if (target !== this.trader) await venue.liquidate(this.trader, target, market);
      }
    }
  }
}
