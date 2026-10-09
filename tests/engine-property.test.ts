import { describe, expect, it } from "vitest";
import { SeededRandom } from "../src/bots/rng.js";
import { MemoryVenue, HOUSE_FEES, HOUSE_INSURANCE } from "../src/engine/memory-venue.js";
import type { MarketId, Side, OrderType } from "../src/engine/types.js";
import { dollars, makeVenue } from "./helpers.js";

const SPOT = "NSOL-NUSD";
const PERPS: MarketId[] = ["NSOL-PERP", "NNVDA-PERP"];
const ALL_MARKETS: MarketId[] = [SPOT, ...PERPS];
const TRADER_COUNT = 6;
const OPERATIONS = 3_000;
const TOKENS = ["nUSD", "SOL", "NVDAx"];
const ORDER_TYPES: OrderType[] = ["limit", "postOnly", "ioc", "market"];

const traderKey = (i: number): string => `property-trader-${i}`;

async function totalBalance(venue: MemoryVenue, traders: string[], token: string): Promise<bigint> {
  let total = 0n;
  for (const trader of traders) {
    const state = await venue.traderState(trader);
    const entry = state.balances[token];
    if (entry) total += entry.balance + entry.locked;
  }
  return total;
}

async function assertInvariants(
  venue: MemoryVenue,
  traders: string[],
  depositedTotals: Record<string, bigint>,
): Promise<void> {
  const allAccounts = [...traders, HOUSE_FEES, HOUSE_INSURANCE];

  for (const token of TOKENS) {
    const total = await totalBalance(venue, allAccounts, token);
    expect(total).toBe(depositedTotals[token] ?? 0n);
  }

  for (const trader of allAccounts) {
    const state = await venue.traderState(trader);
    for (const [token, entry] of Object.entries(state.balances)) {
      expect(entry.balance >= 0n, `${trader}'s ${token} balance went negative`).toBe(true);
      expect(entry.locked >= 0n, `${trader}'s ${token} locked went negative`).toBe(true);
    }
  }

  for (const market of PERPS) {
    let totalSize = 0n;
    for (const trader of allAccounts) {
      const state = await venue.traderState(trader);
      totalSize += state.positions[market]?.size ?? 0n;
    }
    expect(totalSize).toBe(0n);
  }
}

describe("MemoryVenue property test", () => {
  it(
    "holds balance conservation, position symmetry and no negative balance across thousands of random operations",
    { timeout: 30_000 },
    async () => {
      const { venue, clock } = makeVenue();
      const random = new SeededRandom(20261009);
      const traders = Array.from({ length: TRADER_COUNT }, (_, i) => traderKey(i));
      const depositedTotals: Record<string, bigint> = {
        nUSD: dollars(10_000_000), // the insurance seed
      };

      for (const trader of traders) {
        await venue.openTrader(trader);
      }
      for (const market of PERPS) {
        await venue.publishPrice(market, dollars(100), clock.nowMs());
      }

      await assertInvariants(venue, traders, depositedTotals);

      for (let op = 0; op < OPERATIONS; op += 1) {
        clock.advance(random.nextInt(0, 2_000));

        const roll = random.next();
        if (roll < 0.1) {
          const trader = random.pick(traders);
          const token = random.pick(TOKENS);
          const amount = dollars(random.nextInt(1, 500));
          await venue.deposit(trader, token, amount);
          depositedTotals[token] = (depositedTotals[token] ?? 0n) + amount;
        } else if (roll < 0.15) {
          const market = random.pick(PERPS);
          const drift = random.nextInt(-3, 3);
          const markets = await venue.markets();
          const current = markets.find((m) => m.id === market)!.markPrice ?? dollars(100);
          const next = current + dollars(drift);
          if (next > 0n) await venue.publishPrice(market, next, clock.nowMs());
        } else if (roll < 0.2) {
          const market = random.pick(PERPS);
          await venue.updateFunding(market);
        } else if (roll < 0.25) {
          const market = random.pick(PERPS);
          const liquidator = random.pick(traders);
          const target = random.pick(traders);
          if (liquidator !== target) await venue.liquidate(liquidator, target, market);
        } else {
          const trader = random.pick(traders);
          const market = random.pick(ALL_MARKETS);
          const side: Side = random.nextBool() ? "buy" : "sell";
          const type = random.pick(ORDER_TYPES);
          const lotSize = market === "NNVDA-PERP" ? 100n : 1_000n;
          const size = lotSize * BigInt(random.nextInt(1, 20));
          const priceDrift = random.nextInt(-5, 5);
          const price = dollars(100 + priceDrift);
          const reduceOnly = market !== SPOT && random.nextBool();

          await venue.placeOrder(trader, {
            market,
            side,
            type,
            price:
              type === "limit" || type === "postOnly" || type === "ioc" || type === "market"
                ? price
                : undefined,
            size,
            reduceOnly,
          });
        }

        await assertInvariants(venue, traders, depositedTotals);
      }
    },
  );
});
