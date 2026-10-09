import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { money, moneyOrNull } from "../serialize.js";

export const registerMarketsRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/markets", async () => {
    const markets = await ctx.venue.markets();
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
        warmingUp: market.warmingUp ?? false,
        change24hPercent: market.change24h,
        volume24h: money(market.volume24h),
        openInterest: moneyOrNull(market.openInterest),
      })),
    };
  });
};
