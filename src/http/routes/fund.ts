import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { money } from "../serialize.js";

const bodySchema = z.object({
  address: z
    .string()
    .min(32)
    .max(44)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "must look like a base58 address"),
});

const reference = (): string => `fund-${randomBytes(12).toString("hex")}`;

export const registerFundRoute = (app: FastifyInstance, ctx: AppContext): void => {
  app.post("/v1/fund", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid address", issues: parsed.error.issues });
    }
    const { address } = parsed.data;
    const ip = request.ip;

    const decision = ctx.fundLedger.check(address, ip);
    if (!decision.ok) {
      return reply.status(decision.status).send({ error: decision.reason });
    }

    await ctx.venue.openTrader(address);
    await ctx.venue.deposit(address, "nUSD", ctx.config.FUND_AMOUNT_NUSD);
    ctx.fundLedger.record(address, ip);

    return { amount: money(ctx.config.FUND_AMOUNT_NUSD), reference: reference() };
  });
};
