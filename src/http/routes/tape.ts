import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MARKETS } from "../../engine/markets.js";
import type { AppContext } from "../context.js";
import { money, tagString } from "../serialize.js";

const MARKET_IDS = MARKETS.map((m) => m.id) as [string, ...string[]];

const querySchema = z.object({
  market: z.enum(MARKET_IDS),
  limit: z.coerce.number().int().positive().max(500).default(100),
});

export const registerTapeRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/tape", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const { market, limit } = parsed.data;
    const fills = ctx.tape.recent(market, limit);
    return {
      network: ctx.config.NETWORK,
      simulated: true,
      fills: fills.map((fill) => ({
        market: fill.market,
        price: money(fill.price),
        size: money(fill.size),
        takerSide: fill.takerSide,
        takerTag: tagString(fill.takerTag),
        makerTag: tagString(fill.makerTag),
        timestampMs: fill.timestampMs,
        sequence: fill.sequence,
      })),
    };
  });
};
