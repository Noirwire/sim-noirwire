import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { SocketLimiter } from "../rate-limit.js";
import { marketId } from "../schemas.js";

const POLICY_VIOLATION = 1008;
/** A socket that has not answered a ping by the next one is dropped, so a vanished browser stops keeping the service awake. */
const HEARTBEAT_MS = 30_000;

const querySchema = z.object({ market: marketId });

/**
 * `WS /v1/stream?market=<id>`: price, fill, candle and stats messages for one
 * market. The service stays awake while any of these sockets is open.
 */
export const registerStreamRoute = (
  app: FastifyInstance,
  ctx: AppContext,
  socketLimit?: SocketLimiter,
): void => {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      socket.close(POLICY_VIOLATION, "unknown or missing market");
      return;
    }
    const releaseSlot = socketLimit?.acquire(request.ip);
    if (socketLimit && !releaseSlot) {
      socket.close(
        POLICY_VIOLATION,
        "too many open streams from this address: close one and retry",
      );
      return;
    }
    const unsubscribe = ctx.hub.subscribe(parsed.data.market, (payload) => {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    });
    const released = ctx.activity.socketOpened();
    let answered = true;
    socket.on("pong", () => (answered = true));
    const heartbeat = setInterval(() => {
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      socket.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    socket.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      released();
      releaseSlot?.();
    });
  });
};
