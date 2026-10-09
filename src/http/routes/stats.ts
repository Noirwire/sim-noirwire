import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { money } from "../serialize.js";

export const registerStatsRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/stats", async () => {
    const stats = ctx.stats.snapshot(Date.now());
    return {
      network: ctx.config.NETWORK,
      orders: { user: stats.user.orders, bot: stats.bot.orders },
      fills: { user: stats.user.fills, bot: stats.bot.fills },
      volume: { user: money(stats.user.volume), bot: money(stats.bot.volume) },
      tradersTotal: stats.tradersTotal,
      latency: stats.latency,
      ...(ctx.config.VENUE === "rollup"
        ? { botOrdersOutcomeUnknown: stats.botOrdersOutcomeUnknown }
        : {}),
      updatedAtMs: stats.updatedAtMs,
    };
  });
};
