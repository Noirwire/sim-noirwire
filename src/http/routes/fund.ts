import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { base58Address } from "../schemas.js";
import { money } from "../serialize.js";

const bodySchema = z.object({ address: base58Address });

const REFERENCE_BYTES = 12;

const reference = (): string => `fund-${randomBytes(REFERENCE_BYTES).toString("hex")}`;

/** `POST /v1/fund` on the in-memory venue: one grant per address, rate limited per IP. */
export const registerFundRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.post("/v1/fund", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid address", issues: parsed.error.issues });
    }
    const { address } = parsed.data;
    const decision = ctx.fundLedger.check(address, request.ip);
    if (!decision.ok) return reply.status(decision.status).send({ error: decision.reason });

    await ctx.venue.openTrader(address);
    await ctx.venue.deposit(address, "nUSD", ctx.config.FUND_AMOUNT_NUSD);
    ctx.fundLedger.record(address, request.ip);

    return { amount: money(ctx.config.FUND_AMOUNT_NUSD), reference: reference() };
  });
};
