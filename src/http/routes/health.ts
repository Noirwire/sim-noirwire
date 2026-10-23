import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

/**
 * With VENUE=rollup the service is healthy when its start-up work is done
 * and its bots are funded, and, while it is awake, when it is also connected
 * to the rollup and every market's price on chain is fresh. An asleep service
 * sends nothing, so stale prices are expected and do not count against it.
 * Until then the answer is 503 with what is missing. This route never wakes
 * the service, so an uptime probe can poll it freely.
 *
 * While awake the answer also carries `trading: { ready, reason? }`, which is
 * not `ok`: a blind hedge or a stopped maker makes it not ready but leaves the
 * status code alone, so a probe does not restart a process that restarting
 * cannot help. Alert on `trading.ready` instead.
 */
export const registerHealthRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/health", { config: { wakes: false } }, async (_request, reply) => {
    const base = {
      venue: ctx.config.VENUE,
      network: ctx.config.NETWORK,
      awake: ctx.activity.awake,
    };
    const trading = ctx.activity.awake ? ctx.trading?.() : undefined;
    const tradingField = trading ? { trading } : {};
    if (!ctx.readiness) return { ok: true, ...base, ...tradingField };
    const readiness = ctx.readiness();
    const started = ctx.startUp?.ready ?? true;
    const reason =
      ctx.startUp?.problem ?? ctx.activity.wakeFailure ?? (started ? null : "starting up");
    const ok =
      reason === null &&
      readiness.botsFunded &&
      (!ctx.activity.awake || (readiness.connected && readiness.pricesFresh));
    return reply
      .status(ok ? 200 : 503)
      .send({ ok, ...base, ...readiness, ...tradingField, ...(reason === null ? {} : { reason }) });
  });
};
