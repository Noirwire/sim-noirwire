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

export const buildServer = async (ctx: AppContext): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: ctx.config.ALLOWED_ORIGINS });
  await app.register(websocket);

  registerHealthRoute(app, ctx);
  if (ctx.deployment) registerDeploymentRoute(app, ctx.deployment);
  registerMarketsRoute(app, ctx);
  registerTapeRoute(app, ctx);
  registerCandlesRoute(app, ctx);
  registerStatsRoute(app, ctx);
  if (ctx.funding) registerRollupFundRoutes(app, ctx, ctx.funding);
  else registerFundRoute(app, ctx);
  registerStreamRoute(app, ctx);

  if (ctx.config.VENUE === "memory" && ctx.config.DEV_TRADING) {
    registerDevTradingRoutes(app, ctx);
  }

  return app;
};
