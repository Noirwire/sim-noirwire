import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { marketId } from "../schemas.js";

const POLICY_VIOLATION = 1008;

const querySchema = z.object({ market: marketId });

/** `WS /v1/stream?market=<id>`: price, fill, candle and stats messages for one market. */
export const registerStreamRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      socket.close(POLICY_VIOLATION, "unknown or missing market");
      return;
    }
    const unsubscribe = ctx.hub.subscribe(parsed.data.market, (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    });
    socket.on("close", unsubscribe);
  });
};
