import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { isMainnet } from "../config/config.js";
import { systemClock } from "../engine/clock.js";
import type { AppContext } from "./context.js";
import { RateLimiter, SocketLimiter } from "./rate-limit.js";
import { registerCandlesRoute } from "./routes/candles.js";
import { registerDevTradingRoutes } from "./routes/dev-trading.js";
import { registerFundRoute } from "./routes/fund.js";
import { registerRollupFundRoutes } from "./routes/fund-rollup.js";
import { registerOpenRoutes } from "./routes/open-rollup.js";
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

/**
 * Mainnet serves the read-only market data and one write: opening an account
 * for an invited person (`/v1/open`). It has no fund routes and no test
 * trading. Every address is limited in requests per minute and in open
 * stream sockets.
 */
export const buildServer = async (ctx: AppContext): Promise<FastifyInstance> => {
  const { config } = ctx;
  const mainnet = isMainnet(config);
  const hops = config.TRUSTED_PROXY_HOPS ?? 0;
  // The address a caller really has is the one `hops` proxies in: those nearest the service are trusted to say so.
  const app = Fastify({
    logger: false,
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
  });

  await app.register(cors, { origin: config.ALLOWED_ORIGINS });
  await app.register(websocket);

  if (mainnet) {
    const requests = new RateLimiter(config.PUBLIC_RATE_LIMIT_PER_MINUTE, systemClock);
    // Before the hook below, so a request that is turned away does not wake anything.
    app.addHook("onRequest", async (request, reply) => {
      const waitSeconds = requests.hit(request.ip);
      if (waitSeconds === 0) return;
      return reply
        .status(429)
        .header("retry-after", String(waitSeconds))
        .send({
          error: `too many requests from this address: wait ${waitSeconds} s and try again`,
        });
    });
  }

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
  if (mainnet) {
    if (ctx.openDesk) registerOpenRoutes(app, ctx, ctx.openDesk);
  } else if (ctx.fundDesk) registerRollupFundRoutes(app, ctx, ctx.fundDesk);
  else registerFundRoute(app, ctx);
  registerStreamRoute(
    app,
    ctx,
    mainnet ? new SocketLimiter(config.PUBLIC_SOCKETS_PER_IP) : undefined,
  );

  if (config.VENUE === "memory" && config.DEV_TRADING && !mainnet) {
    registerDevTradingRoutes(app, ctx);
  }

  return app;
};
