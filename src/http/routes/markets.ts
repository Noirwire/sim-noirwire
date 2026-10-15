import type { FastifyInstance } from "fastify";
import { VenueNotReady } from "../../engine/venue-not-ready.js";
import type { AppContext } from "../context.js";
import { money, moneyOrNull } from "../serialize.js";

export const registerMarketsRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/markets", async (_request, reply) => {
    let markets;
    try {
      markets = await ctx.venue.markets();
    } catch (error) {
      if (!(error instanceof VenueNotReady)) throw error;
      return reply.status(503).send({ error: error.reason });
    }
    // A service that is waking has not republished its prices yet: what it shows is last seen, not live.
    const waking = ctx.activity.waking;
    return {
      network: ctx.config.NETWORK,
      simulated: true,
      markets: markets.map((market) => ({
        id: market.id,
        kind: market.kind,
        base: market.base,
        quote: market.quote,
        tickSize: money(market.tickSize),
        lotSize: money(market.lotSize),
        maxLeverage: market.maxLeverage,
        markPrice: moneyOrNull(market.markPrice),
        markPriceUpdatedAtMs: market.markPriceUpdatedAtMs,
        warmingUp: waking || (market.warmingUp ?? false),
        change24hPercent: market.change24h,
        volume24h: money(market.volume24h),
        openInterest: moneyOrNull(market.openInterest),
      })),
    };
  });
};
