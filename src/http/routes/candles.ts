import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { marketId } from "../schemas.js";
import { serializeCandle } from "../serialize.js";

const MAX_CANDLES = 1_000;
const DEFAULT_CANDLES = 200;

const querySchema = z.object({
  market: marketId,
  interval: z.enum(["1m", "5m", "15m", "1h"]),
  limit: z.coerce.number().int().positive().max(MAX_CANDLES).default(DEFAULT_CANDLES),
});

export const registerCandlesRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/candles", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const { market, interval, limit } = parsed.data;
    return {
      network: ctx.config.NETWORK,
      simulated: true,
      candles: ctx.candles.candles(market, interval, limit).map(serializeCandle),
    };
  });
};
