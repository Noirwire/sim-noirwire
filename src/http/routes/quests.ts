import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { systemClock } from "../../engine/clock.js";
import type { QuestService, Refused } from "../../quests/quest-service.js";
import { bytesOfBase58 } from "../../rollup/base58.js";
import { RateLimiter } from "../rate-limit.js";
import { base58Address } from "../schemas.js";

const BODY_LIMIT_BYTES = 8_192;
const CHALLENGES_PER_MINUTE = 10;
const DEVICES_PER_MINUTE = 10;
const ORDER_BATCHES_PER_MINUTE = 60;
const MOST_ORDERS_PER_BATCH = 20;
const PUBLIC_KEY_BYTES = 32;

const publicKey = base58Address.refine(
  (text) => bytesOfBase58(text)?.length === PUBLIC_KEY_BYTES,
  "must be a 32-byte public key",
);
const signature = z
  .string()
  .min(64)
  .max(90)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must be base58");
const isoTime = z.string().regex(/^[0-9TZ:.+-]{10,32}$/, "must be an ISO date");
const signedAt = z.number().int().positive();

const challengeBody = z.object({ wallet: publicKey });
const deviceBody = z.object({
  wallet: publicKey,
  deviceKey: publicKey,
  until: isoTime,
  challenge: z.string().regex(/^[0-9a-f]{32}$/),
  signature,
});
const revokeBody = z.object({ deviceKey: publicKey, signedAt, signature });
const ordersBody = z.object({
  deviceKey: publicKey,
  signedAt,
  orders: z
    .array(
      z.object({
        market: z.string().min(1).max(32),
        secret: z.string().regex(/^[0-9a-f]{32}$/),
      }),
    )
    .min(1)
    .max(MOST_ORDERS_PER_BATCH),
  signature,
});

const refuse = (reply: FastifyReply, refusal: Refused) =>
  reply.status(refusal.status).send({ error: refusal.reason });

const notReadable = (reply: FastifyReply) =>
  reply.status(400).send({ error: "the request is not in the form this route takes" });

const limitedBy =
  (limiter: RateLimiter) => async (request: FastifyRequest, reply: FastifyReply) => {
    const waitSeconds = limiter.hit(request.ip);
    if (waitSeconds === 0) return;
    return reply
      .status(429)
      .header("retry-after", String(waitSeconds))
      .send({ error: `too many requests from this address: wait ${waitSeconds} s and try again` });
  };

/**
 * Switching a device on for quests, handing over the secrets of its orders and switching it off.
 * None of these routes says whether a wallet has progress: a claim that does not hold is refused
 * with one answer, and nothing a caller sends is echoed back. None of them wakes the service.
 */
export const registerQuestRoutes = (app: FastifyInstance, quests: QuestService): void => {
  const route = (perMinute: number) => ({
    config: { wakes: false },
    bodyLimit: BODY_LIMIT_BYTES,
    onRequest: limitedBy(new RateLimiter(perMinute, systemClock)),
  });

  app.post("/v1/quests/challenge", route(CHALLENGES_PER_MINUTE), async (request, reply) => {
    const body = challengeBody.safeParse(request.body);
    if (!body.success) return notReadable(reply);
    return quests.issueChallenge(body.data.wallet);
  });

  app.post("/v1/quests/device", route(DEVICES_PER_MINUTE), async (request, reply) => {
    const body = deviceBody.safeParse(request.body);
    if (!body.success) return notReadable(reply);
    const result = await quests.registerDevice(body.data);
    return result.ok ? result : refuse(reply, result);
  });

  app.post("/v1/quests/device/revoke", route(DEVICES_PER_MINUTE), async (request, reply) => {
    const body = revokeBody.safeParse(request.body);
    if (!body.success) return notReadable(reply);
    const result = await quests.revokeDevice(body.data);
    return result.ok ? result : refuse(reply, result);
  });

  app.post("/v1/quests/orders", route(ORDER_BATCHES_PER_MINUTE), async (request, reply) => {
    const body = ordersBody.safeParse(request.body);
    if (!body.success) return notReadable(reply);
    const result = await quests.registerOrders(body.data);
    return result.ok ? { accepted: result.accepted } : refuse(reply, result);
  });
};
