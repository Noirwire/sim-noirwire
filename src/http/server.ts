import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { AppContext } from "./context.js";
import { registerCandlesRoute } from "./routes/candles.js";
import { registerDevTradingRoutes } from "./routes/dev-trading.js";
import { registerFundRoute } from "./routes/fund.js";
import { registerRollupFundRoutes } from "./routes/fund-rollup.js";
import { registerDeploymentRoute } from "./routes/deployment.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerMarketsRoute } from "./routes/markets.js";
import { registerStatsRoute } from "./routes/stats.js";
import { registerStreamRoute } from "./routes/stream.js";
import { registerTapeRoute } from "./routes/tape.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** False on a route whose requests are no reason for the service to be busy. */
    wakes?: boolean;
  }
}

export const buildServer = async (ctx: AppContext): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: ctx.config.ALLOWED_ORIGINS });
  await app.register(websocket);

  // Any request that reaches a route of the public API wakes the service. A
  // path that matches none (a scanner's probe) and the health route do not.
  app.addHook("onRequest", async (request) => {
    if (request.is404 || request.routeOptions.config.wakes === false) return;
    ctx.activity.touch();
  });

  registerHealthRoute(app, ctx);
  if (ctx.deployment) registerDeploymentRoute(app, ctx.deployment);
  registerMarketsRoute(app, ctx);
  registerTapeRoute(app, ctx);
  registerCandlesRoute(app, ctx);
  registerStatsRoute(app, ctx);
  if (ctx.fundDesk) registerRollupFundRoutes(app, ctx, ctx.fundDesk);
  else registerFundRoute(app, ctx);
  registerStreamRoute(app, ctx);

  if (ctx.config.VENUE === "memory" && ctx.config.DEV_TRADING) {
    registerDevTradingRoutes(app, ctx);
  }

  return app;
};
