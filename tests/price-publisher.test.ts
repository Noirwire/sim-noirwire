import { type Connection, Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MARKETS } from "../src/engine/markets.js";
import type { ChainMarket } from "../src/rollup/chain-types.js";
import { Session } from "../src/rollup/connections.js";
import { PricePublisher } from "../src/rollup/price-publisher.js";
import { publishTimeIsNew } from "../src/rollup/price-walk.js";
import { RollupMarket } from "../src/rollup/rollup-market.js";
import { dollars } from "./helpers.js";

const SOL_PERP: ChainMarket = {
  marketId: 0,
  kind: "perp",
  tick: 100n,
  baseLot: 1_000_000n,
  minNotional: 1_000_000n,
  bandBps: 400,
  initialMarginBps: 1_000,
  maxMoveBps: 250,
  maxPriceAgeSeconds: 10,
  fundingIntervalSeconds: 60,
  baseToken: 1,
  quoteToken: 0,
};

/** A market whose feed last took 150 at second 1,000 and whose real price is 151. */
const marketAwayFromItsTarget = (): RollupMarket => {
  const market = new RollupMarket(MARKETS[0], SOL_PERP, 9);
  market.acceptPrice({ price: 150_000n, publishTimeSeconds: 1_000 });
  market.setTarget(dollars(151));
  return market;
};

const publisherOn = (market: RollupMarket, rollup: { clockSeconds: number; refuses?: boolean }) => {
  const publishTimes: number[] = [];
  const publisher = new PricePublisher({
    program: {
      clockSeconds: async () => rollup.clockSeconds,
      publishPrice: async (_connection, _oracle, _marketId, _price, publishTimeSeconds) => {
        if (rollup.refuses) throw new Error("the rollup did not confirm");
        publishTimes.push(publishTimeSeconds);
      },
      updateFunding: async () => {},
    },
    oracle: Session.of({} as Connection),
    oracleKey: Keypair.generate(),
    markets: [market],
    intervalMs: 2_000,
    onError: () => {},
  });
  return { publisher, publishTimes };
};

describe("publishing a market's price", () => {
  it("skips a publish while the rollup's clock still shows the second of the last accepted one", async () => {
    const market = marketAwayFromItsTarget();
    const rollup = { clockSeconds: 1_001 };
    const { publisher, publishTimes } = publisherOn(market, rollup);

    await publisher.publishOnce(market);
    await publisher.publishOnce(market);
    expect(publishTimes).toEqual([1_001]);

    rollup.clockSeconds = 1_002;
    await publisher.publishOnce(market);
    expect(publishTimes).toEqual([1_001, 1_002]);
  });

  it("skips a publish at a second the chain's own feed has already taken", async () => {
    const market = marketAwayFromItsTarget();
    const { publisher, publishTimes } = publisherOn(market, { clockSeconds: 1_000 });

    await publisher.publishOnce(market);
    expect(publishTimes).toEqual([]);
    expect(publisher.lastPublishedAtMs(market)).toBe(0);
  });

  it("tries the same second again after a publish the rollup did not confirm", async () => {
    const market = marketAwayFromItsTarget();
    const rollup = { clockSeconds: 1_001, refuses: true };
    const { publisher, publishTimes } = publisherOn(market, rollup);

    await expect(publisher.publishOnce(market)).rejects.toThrow();
    rollup.refuses = false;
    await publisher.publishOnce(market);
    expect(publishTimes).toEqual([1_001]);
  });

  it("takes only a time after the last accepted one as new", () => {
    expect(publishTimeIsNew(1_001, 1_000)).toBe(true);
    expect(publishTimeIsNew(1_000, 1_000)).toBe(false);
    expect(publishTimeIsNew(999, 1_000)).toBe(false);
  });
});
