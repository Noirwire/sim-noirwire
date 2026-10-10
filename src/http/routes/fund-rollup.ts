import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FundDesk } from "../../rollup/fund-desk.js";
import type { AppContext } from "../context.js";
import { base58Address } from "../schemas.js";
import { money } from "../serialize.js";

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
  fundDesk: FundDesk,
): void => {
  const refusal = (owner: string, ip: string) => {
    if (ctx.readiness && !ctx.readiness().botsFunded) {
      return { status: 503 as const, reason: "the service is still starting, try again" };
    }
    const decision = ctx.fundLedger.check(owner, ip);
    return decision.ok ? null : decision;
  };

  app.post("/v1/fund/prepare", async (request, reply) => {
    const parsed = prepareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { owner, orderKeys } = parsed.data;
    const refused = refusal(owner, request.ip);
    if (refused) return reply.status(refused.status).send({ error: refused.reason });

    const prepared = await fundDesk.prepare(owner, orderKeys);
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
    const refused = refusal(owner, request.ip);
    if (refused) return reply.status(refused.status).send({ error: refused.reason });

    const funded = await fundDesk.submit(owner, transaction);
    if (!funded.ok) return reply.status(funded.status).send({ error: funded.reason });
    ctx.fundLedger.record(owner, request.ip);
    ctx.stats.recordTrader(owner);
    return { amount: money(ctx.config.FUND_AMOUNT_NUSD), reference: funded.signature };
  });
};
