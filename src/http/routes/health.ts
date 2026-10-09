import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * With VENUE=rollup the service is healthy only when it is connected to the
 * rollup, every market's price on chain is fresh and its bots are funded;
 * until then the answer is 503 with what is missing.
 */
export const registerHealthRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/health", async (_request, reply) => {
    const base = { venue: ctx.config.VENUE, network: ctx.config.NETWORK };
    if (!ctx.readiness) return { ok: true, ...base };
    const readiness = ctx.readiness();
    const ok = readiness.connected && readiness.pricesFresh && readiness.botsFunded;
    return reply.status(ok ? 200 : 503).send({ ok, ...base, ...readiness });
  });
};
