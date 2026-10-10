import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { marketId } from "../schemas.js";
import { serializeFill } from "../serialize.js";

const MAX_FILLS = 500;
const DEFAULT_FILLS = 100;

const querySchema = z.object({
  market: marketId,
  limit: z.coerce.number().int().positive().max(MAX_FILLS).default(DEFAULT_FILLS),
});

export const registerTapeRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/tape", async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const { market, limit } = parsed.data;
    return {
      network: ctx.config.NETWORK,
      simulated: true,
      fills: ctx.tape.recent(market, limit).map(serializeFill),
    };
  });
};
