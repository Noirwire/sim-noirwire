import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FundingDesk } from "../../rollup/funding-desk.js";
import type { AppContext } from "../context.js";
import { money } from "../serialize.js";

const address = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must look like a base58 address");

const prepareSchema = z.object({ owner: address, orderKeys: z.array(address).length(4) });

const submitSchema = z.object({
  owner: address,
  transaction: z
    .string()
    .min(1)
    .max(4_096)
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
  funding: FundingDesk,
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

    const prepared = await funding.prepare(owner, orderKeys);
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

    const funded = await funding.submit(owner, transaction);
    if (!funded.ok) return reply.status(funded.status).send({ error: funded.reason });
    ctx.fundLedger.record(owner, request.ip);
    ctx.stats.recordTrader(owner);
    return { amount: money(ctx.config.FUND_AMOUNT_NUSD), reference: funded.signature };
  });
};
