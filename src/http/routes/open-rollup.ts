import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Opened, OpenRequests, SignedOpenRequests } from "../../rollup/open-desk.js";
import type { AppContext } from "../context.js";
import { base58Address } from "../schemas.js";
import { deskUnavailable } from "./desk-availability.js";

const DESK_UNREACHABLE = "the rollup did not answer, try again";
const DESK_BUSY = "the desk is busy with another request, try again";
const ORDER_KEYS_PER_TRADER = 4;
/** Well above an open transaction in base64, well below anything worth parsing. */
const MAX_TRANSACTION_CHARS = 4_096;

const prepareSchema = z.object({
  owner: base58Address,
  orderKeys: z.array(base58Address).length(ORDER_KEYS_PER_TRADER),
  invite: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be the invite code you were given")
    .optional(),
});

const submitSchema = z.object({
  owner: base58Address,
  transaction: z
    .string()
    .min(1)
    .max(MAX_TRANSACTION_CHARS)
    .regex(/^[A-Za-z0-9+/]+=*$/, "must be base64"),
});

/** SIGNED_OWNER_ACTIONS on a desk that cannot take a signature is a wiring mistake: stop at start-up. */
const signedRequestsOf = (desk: Partial<SignedOpenRequests>): SignedOpenRequests => {
  if (!takesSignedMessages(desk)) {
    throw new Error("SIGNED_OWNER_ACTIONS is on but the open desk cannot take a signed message");
  }
  return desk;
};

const takesSignedMessages = (desk: Partial<SignedOpenRequests>): desk is SignedOpenRequests =>
  desk.prepareMessage !== undefined && desk.submitSigned !== undefined;

/** An Ed25519 signature is 64 bytes: 88 characters of base64. */
const SIGNATURE_BASE64_CHARS = 88;
const SIGNATURE_BYTES = 64;

const signedSubmitSchema = z.object({
  owner: base58Address,
  signature: z
    .string()
    .length(SIGNATURE_BASE64_CHARS)
    .regex(/^[A-Za-z0-9+/]+=*$/, "must be base64")
    .refine((text) => Buffer.from(text, "base64").length === SIGNATURE_BYTES, "must be 64 bytes"),
  expiresAt: z.number().int().positive(),
});

/**
 * Opening an account on mainnet, in two steps, for invited people. `prepare`
 * returns the one transaction that opens the caller's account (no funds: the
 * caller deposits in a transaction of their own); `submit` takes it back
 * signed by the owner and sends it. The gate signs the transaction at
 * `prepare`, only after the invite list and the day's limits say yes and the
 * seat is written down, so a wallet sees it already signed and leaves its
 * message alone; `submit` asks the invite list and the limits again before it
 * sends.
 *
 * With `SIGNED_OWNER_ACTIONS` the owner signs a message instead: `prepare`
 * answers the expiry the message must carry and signs nothing, and `submit`
 * takes the owner's signature, checks it, and builds, signs and sends the
 * transaction itself.
 */
export const registerOpenRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  desk: OpenRequests & Partial<SignedOpenRequests>,
): void => {
  const signedDesk = ctx.config.SIGNED_OWNER_ACTIONS ? signedRequestsOf(desk) : null;
  /**
   * One prepare at a time, so a burst cannot all pass the limits before the first is written down.
   * A submit does not take part: it sends a seat that is already written down, the desk allows one
   * send per owner, and it may wait for the rollup to confirm for many seconds, which must not
   * turn other people's prepares and submits away.
   */
  let preparing = false;

  /** The desk's answer, or null when it failed: the failure is logged, and the caller is only told to retry. */
  const asked = async <T>(what: string, ask: () => Promise<T>): Promise<T | null> => {
    try {
      const answer = await ask();
      ctx.problems?.onRecovered(what);
      return answer;
    } catch (error) {
      ctx.problems?.onError(what, error);
      return null;
    }
  };

  app.post("/v1/open/prepare", async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const reason = deskUnavailable(ctx) ?? (preparing ? DESK_BUSY : null);
    if (reason) return reply.status(503).send({ error: reason });

    preparing = true;
    const ask = { ...parsed.data, ip: request.ip };
    const prepared = await asked("opening an account (prepare)", async () =>
      signedDesk ? signedDesk.prepareMessage(ask) : desk.prepare(ask),
    ).finally(() => {
      preparing = false;
    });
    if (!prepared) return reply.status(502).send({ error: DESK_UNREACHABLE });
    if (!prepared.ok) return reply.status(prepared.status).send({ error: prepared.reason });
    if (!("transaction" in prepared)) {
      return {
        ownerAuth: "message",
        expiresAt: prepared.expiresAt,
        expiresAtMs: prepared.expiresAtMs,
      };
    }
    return {
      ownerAuth: "transaction",
      transaction: prepared.transaction,
      expiresAtMs: prepared.expiresAtMs,
    };
  });

  const answered = async (reply: FastifyReply, owner: string, open: () => Promise<Opened>) => {
    const reason = deskUnavailable(ctx);
    if (reason) return reply.status(503).send({ error: reason });
    const opened = await asked("opening an account (submit)", open);
    if (!opened) return reply.status(502).send({ error: DESK_UNREACHABLE });
    if (!opened.ok) return reply.status(opened.status).send({ error: opened.reason });
    ctx.stats.recordTrader(owner);
    return { reference: opened.signature };
  };

  app.post("/v1/open/submit", async (request, reply) => {
    if (signedDesk) {
      const parsed = signedSubmitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
      }
      const { owner, signature, expiresAt } = parsed.data;
      return answered(reply, owner, () =>
        signedDesk.submitSigned(owner, signature, expiresAt, request.ip),
      );
    }
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { owner, transaction } = parsed.data;
    return answered(reply, owner, () => desk.submit(owner, transaction, request.ip));
  });
};
