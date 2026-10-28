import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { makerTraderKey } from "../src/bots/bot-traders.js";
import { loadConfig } from "../src/config/config.js";
import { systemClock } from "../src/engine/clock.js";
import { MARKETS } from "../src/engine/markets.js";
import { MemoryVenue } from "../src/engine/memory-venue.js";
import type { NewOrder, Venue } from "../src/engine/types.js";
import { placingOrdersThrough, rejectedOrder } from "../src/engine/venue-orders.js";
import { openBots } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { dollars } from "./helpers.js";

const PERP = "NSOL-PERP";
const ROOT = join("data-test", `maker-two-sided-${Date.now()}`);

afterAll(() => rm(ROOT, { recursive: true, force: true }));

/** A running house maker whose venue refuses the orders of the side it is told to, read through the service's readiness. */
const quotingBots = async (refusing: { side: "buy" | "sell" | null }) => {
  const memory = new MemoryVenue({ clock: systemClock });
  const refuse = (trader: string, order: NewOrder) =>
    trader === makerTraderKey(PERP) && order.side === refusing.side
      ? Promise.resolve(rejectedOrder("refused", 0n, order, "post-only order would match"))
      : memory.placeOrder(trader, order);
  const venue: Venue = placingOrdersThrough(memory, refuse);
  const wiring = {
    venue,
    botVenue: venue,
    botMarkets: [MARKETS[0]],
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
  } as unknown as VenueWiring;
  const dir = join(ROOT, `run-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const config = {
    ...loadConfig({
      VENUE: "memory",
      NOISE_TAKERS_ENABLED: "0",
      LIQUIDATOR_ENABLED: "0",
      HOUSE_MAKER_REQUOTE_INTERVAL_MS: "10000",
      HOUSE_MAKER_TICK_MS: "1000",
      DATA_DIR: dir,
    }),
    NETWORK: "devnet",
  };
  const bots = await openBots(config, wiring, { onError: () => {}, onRecovered: () => {} });
  return { bots, memory };
};

describe("trading readiness of a house maker whose book is one-sided", () => {
  const readyAfter = async (refusing: { side: "buy" | "sell" | null }, seconds: number) => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")));
    try {
      const { bots, memory } = await quotingBots(refusing);
      const loops = bots.start();
      for (let second = 0; second < seconds; second += 1) {
        await memory.publishPrice(PERP, dollars(100), systemClock.nowMs());
        await vi.advanceTimersByTimeAsync(1_000);
      }
      for (const loop of loops) loop.stop();
      return bots.trading();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  };

  it("is ready with both sides resting", async () => {
    expect(await readyAfter({ side: null }, 30)).toEqual({ ready: true });
  });

  it("is ready while one side has been empty for under 15 seconds", async () => {
    expect(await readyAfter({ side: "sell" }, 10)).toEqual({ ready: true });
  });

  it("is not ready once the asks have been empty for over 15 seconds, and says so", async () => {
    const readiness = await readyAfter({ side: "sell" }, 25);

    expect(readiness).toMatchObject({ ready: false });
    expect(readiness.reason).toContain("no asks resting");
  });

  it("names the bids when those are the empty side", async () => {
    const readiness = await readyAfter({ side: "buy" }, 25);

    expect(readiness.reason).toContain("no bids resting");
  });
});
