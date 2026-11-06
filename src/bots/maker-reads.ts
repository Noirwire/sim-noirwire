import type { MarketConfig } from "../engine/markets.js";
import type { MarketId, Venue } from "../engine/types.js";
import { makerTraderKey } from "./bot-traders.js";

/** Raised for a market that has no house maker here. */
export class NoMakerFor extends Error {
  constructor(readonly market: string) {
    super(`there is no house maker for ${market}`);
    this.name = "NoMakerFor";
  }
}

/** What an outside reader may ask of the house makers: numbers only, never a key. */
export interface MakerReads {
  /** The maker's signed position on the market in base units, scaled by 1e6: long is positive, short negative. */
  position(market: MarketId): Promise<bigint>;
  /**
   * The makers' equity in quote atoms (six decimals): the one market's maker, or every maker's
   * seat added together when no market is named.
   */
  equity(market?: MarketId): Promise<bigint>;
}

export const makerReadsOf = (
  venue: Pick<Venue, "traderState">,
  markets: readonly MarketConfig[],
): MakerReads => {
  const makerOf = (market: MarketId): MarketConfig => {
    const found = markets.find(({ id }) => id === market);
    if (!found) throw new NoMakerFor(market);
    return found;
  };
  return {
    position: async (market) => {
      const { id } = makerOf(market);
      const state = await venue.traderState(makerTraderKey(id));
      return state.positions[id]?.size ?? 0n;
    },
    equity: async (market) => {
      const makers = market === undefined ? markets : [makerOf(market)];
      let total = 0n;
      for (const { id } of makers) {
        total += (await venue.traderState(makerTraderKey(id))).equity;
      }
      return total;
    },
  };
};
