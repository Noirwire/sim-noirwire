import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FundRequests } from "../../rollup/fund-desk.js";
import type { AppContext } from "../context.js";
import { deskUnavailable } from "./desk-availability.js";
import { base58Address } from "../schemas.js";
import { money } from "../serialize.js";

const DESK_UNREACHABLE = "the rollup did not answer, try again";
const DESK_COOLING_DOWN = "the rollup did not answer a moment ago, try again in a few seconds";
const DESK_COOLDOWN_MS = 5_000;
const DESK_BUSY = "the desk is busy with another request, try again";
const ORDER_KEYS_PER_TRADER = 4;
/** Well above an open-and-fund transaction in base64, well below anything worth parsing. */
const MAX_TRANSACTION_CHARS = 4_096;

const prepareSchema = z.object({
  owner: base58Address,
  orderKeys: z.array(base58Address).length(ORDER_KEYS_PER_TRADER),
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
 * The fund button on the real program, in two steps. `prepare` returns the
 * one transaction that opens the caller's account and deposits the grant;
 * `submit` takes it back signed by the owner and sends it. One grant per
 * owner address and the per-IP limit apply to both.
 */
export const registerRollupFundRoutes = (
  app: FastifyInstance,
  ctx: AppContext,
  fundDesk: FundRequests,
): void => {
  /** When the rollup last failed the desk: nobody is sent to it again for a few seconds, whoever they are. */
  let deskFailedAtMs = -Infinity;
  /** The desk takes one call at a time, so a burst cannot all pass the gate before the first fails. */
  let deskBusy = false;

  /**
   * Why a request is turned away before it reaches the desk, or null. A
   * `submit` is for a transaction `prepare` made and counted, so the IP limit
   * that `prepare` paid for does not turn it away again.
   */
  const refusal = (owner: string, ip: string, submitting: boolean) => {
    const reason =
      deskUnavailable(ctx) ??
      (deskBusy ? DESK_BUSY : null) ??
      (Date.now() - deskFailedAtMs < DESK_COOLDOWN_MS ? DESK_COOLING_DOWN : null);
    if (reason) return { status: 503 as const, reason };
    const decision = submitting
      ? ctx.fundLedger.checkAddress(owner)
      : ctx.fundLedger.check(owner, ip);
    return decision.ok ? null : decision;
  };

  /**
   * Asks the desk, and answers null if it throws. A throw, or an answer that
   * the rollup could not be reached or refused (502 or 503), starts the
   * cooldown. Every try counts against the sender's IP: in `prepare` when it
   * is asked, in `submit` when it ends without a grant, so a normal user costs
   * one and a burst of failures runs into the limit.
   */
  const asked = async <T extends { ok: boolean; status?: number }>(
    ask: () => Promise<T>,
  ): Promise<T | null> => {
    deskBusy = true;
    try {
      const answer = await ask();
      if (!answer.ok && (answer.status === 502 || answer.status === 503)) {
        deskFailedAtMs = Date.now();
      }
      return answer;
    } catch {
      deskFailedAtMs = Date.now();
      return null;
    } finally {
      deskBusy = false;
    }
  };

  app.post("/v1/fund/prepare", async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { owner, orderKeys } = parsed.data;
    const refused = refusal(owner, request.ip, false);
    if (refused) return reply.status(refused.status).send({ error: refused.reason });

    ctx.fundLedger.countAgainstIp(request.ip);
    const prepared = await asked(() => fundDesk.prepare(owner, orderKeys));
    if (!prepared) return reply.status(502).send({ error: DESK_UNREACHABLE });
    if (!prepared.ok) return reply.status(prepared.status).send({ error: prepared.reason });
    return {
      transaction: prepared.transaction,
      expiresAtMs: prepared.expiresAtMs,
      amount: money(ctx.config.FUND_AMOUNT_NUSD),
    };
  });

  app.post("/v1/fund/submit", async (request, reply) => {
    const parsed = submitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { owner, transaction } = parsed.data;
    const refused = refusal(owner, request.ip, true);
    if (refused) return reply.status(refused.status).send({ error: refused.reason });

    const funded = await asked(() => fundDesk.submit(owner, transaction));
    if (!funded) {
      ctx.fundLedger.countAgainstIp(request.ip);
      return reply.status(502).send({ error: DESK_UNREACHABLE });
    }
    if (!funded.ok) {
      ctx.fundLedger.countAgainstIp(request.ip);
      return reply.status(funded.status).send({ error: funded.reason });
    }
    ctx.fundLedger.recordGrant(owner);
    ctx.stats.recordTrader(owner);
    return { amount: money(ctx.config.FUND_AMOUNT_NUSD), reference: funded.signature };
  });
};
