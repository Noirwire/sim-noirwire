import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { NoMakerFor } from "../../bots/maker-reads.js";
import { VenueNotReady } from "../../engine/venue-not-ready.js";
import type { AppContext } from "../context.js";
import { marketId } from "../schemas.js";
import { money } from "../serialize.js";

const positionQuerySchema = z.object({ market: marketId });
const equityQuerySchema = z.object({ market: marketId.optional() });

const invalidQuery = (reply: FastifyReply, issues: z.ZodIssue[]) =>
  reply.status(400).send({ error: "invalid query", issues });

/**
 * Lets a hedger read the house maker's position and equity. Read-only, and numbers only:
 * no key, seed or address leaves it. Security: the maker's book is public on the tape
 * anyway, but its equity is not, so `server.ts` registers these off mainnet only.
 */
export const registerMakerRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  const reads = ctx.makerReads;
  if (!reads) return;

  const answered = async (reply: FastifyReply, read: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof VenueNotReady) return reply.status(503).send({ error: error.reason });
      if (error instanceof NoMakerFor) return reply.status(404).send({ error: error.message });
      throw error;
    }
  };

  app.get("/v1/maker/position", async (request, reply) => {
    const parsed = positionQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply, parsed.error.issues);
    const { market } = parsed.data;
    return answered(reply, async () => ({
      market,
      size: money(await reads.position(market)),
      observedAt: new Date().toISOString(),
    }));
  });

  app.get("/v1/maker/equity", async (request, reply) => {
    const parsed = equityQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidQuery(reply, parsed.error.issues);
    return answered(reply, async () => ({
      equityUsdc6: (await reads.equity(parsed.data.market)).toString(),
      observedAt: new Date().toISOString(),
    }));
  });
};
