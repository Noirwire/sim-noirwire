import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OpenRequests } from "../../rollup/open-desk.js";
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

/**
 * Opening an account on mainnet, in two steps, for invited people. `prepare`
 * returns the one transaction that opens the caller's account (no funds: the
 * caller deposits in a transaction of their own); `submit` takes it back
 * signed by the owner and sends it. The gate signs the transaction at
 * `prepare`, only after the invite list and the day's limits say yes and the
 * seat is written down, so a wallet sees it already signed and leaves its
 * message alone; `submit` asks the invite list and the limits again before it
 * sends.
 */
export const registerOpenRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  desk: OpenRequests,
): void => {
  /** The desk takes one call at a time, so a burst cannot all pass the limits before the first is written down. */
  let deskBusy = false;

  const turnedAway = (): string | null => deskUnavailable(ctx) ?? (deskBusy ? DESK_BUSY : null);

  /** The desk's answer, or null when it failed: the failure is logged, and the caller is only told to retry. */
  const asked = async <T>(what: string, ask: () => Promise<T>): Promise<T | null> => {
    deskBusy = true;
    try {
      const answer = await ask();
      ctx.problems?.onRecovered(what);
      return answer;
    } catch (error) {
      ctx.problems?.onError(what, error);
      return null;
    } finally {
      deskBusy = false;
    }
  };

  app.post("/v1/open/prepare", async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const reason = turnedAway();
    if (reason) return reply.status(503).send({ error: reason });

    const prepared = await asked("opening an account (prepare)", () =>
      desk.prepare({ ...parsed.data, ip: request.ip }),
    );
    if (!prepared) return reply.status(502).send({ error: DESK_UNREACHABLE });
    if (!prepared.ok) return reply.status(prepared.status).send({ error: prepared.reason });
    return { transaction: prepared.transaction, expiresAtMs: prepared.expiresAtMs };
  });

  app.post("/v1/open/submit", async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { owner, transaction } = parsed.data;
    const reason = turnedAway();
    if (reason) return reply.status(503).send({ error: reason });

    const opened = await asked("opening an account (submit)", () =>
      desk.submit(owner, transaction, request.ip),
    );
    if (!opened) return reply.status(502).send({ error: DESK_UNREACHABLE });
    if (!opened.ok) return reply.status(opened.status).send({ error: opened.reason });
    ctx.stats.recordTrader(owner);
    return { reference: opened.signature };
  });
};
