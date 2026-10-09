import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export const registerHealthRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/health", async () => ({
    ok: true,
    venue: ctx.config.VENUE,
    network: ctx.config.NETWORK,
  }));
};
