import type { FastifyInstance } from "fastify";
import { MARKETS } from "../../engine/markets.js";
import type { AppContext } from "../context.js";

const MARKET_IDS = new Set(MARKETS.map((m) => m.id));

/** `WS /v1/stream?market=<id>`: price, fill, candle and stats messages for one market. */
export const registerStreamRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    const market = (request.query as { market?: string }).market;
    if (!market || !MARKET_IDS.has(market)) {
      socket.close(1008, "unknown or missing market");
      return;
    }

    const unsubscribe = ctx.hub.subscribe(market, (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    });

    socket.on("close", unsubscribe);
  });
};
