import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MARKETS } from "../../engine/markets.js";
import type { AppContext } from "../context.js";
import { money } from "../serialize.js";

const MARKET_IDS = MARKETS.map((m) => m.id) as [string, ...string[]];

const querySchema = z.object({
  market: z.enum(MARKET_IDS),
  interval: z.enum(["1m", "5m", "15m", "1h"]),
  limit: z.coerce.number().int().positive().max(1_000).default(200),
});

export const registerCandlesRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/candles", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const { market, interval, limit } = parsed.data;
    const candles = ctx.candles.candles(market, interval, limit);
    return {
      network: ctx.config.NETWORK,
      simulated: true,
      candles: candles.map((candle) => ({
        startMs: candle.startMs,
        open: money(candle.open),
        high: money(candle.high),
        low: money(candle.low),
        close: money(candle.close),
        volume: money(candle.volume),
      })),
    };
  });
};
