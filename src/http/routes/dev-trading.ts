import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MARKETS } from "../../engine/markets.js";
import { fromDecimalString } from "../../engine/money.js";
import type { Fill } from "../../engine/types.js";
import type { AppContext } from "../context.js";
import { money, tagString } from "../serialize.js";

const MARKET_IDS = MARKETS.map((m) => m.id) as [string, ...string[]];

const decimalAmount = z.string().regex(/^\d+(\.\d+)?$/, "must be a plain decimal number");

const orderBodySchema = z.object({
  address: z.string().min(1),
  market: z.enum(MARKET_IDS),
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "postOnly", "ioc", "market"]),
  price: decimalAmount.optional(),
  size: decimalAmount,
  reduceOnly: z.boolean().optional(),
});

const cancelAllBodySchema = z.object({
  address: z.string().min(1),
  market: z.enum(MARKET_IDS),
});

const traderQuerySchema = z.object({
  address: z.string().min(1),
});

/**
 * Lets a browser trade against MemoryVenue before the on-chain client
 * exists. Only ever registered when VENUE=memory and DEV_TRADING=1: see the
 * guard at the call site in server.ts.
 */
export const registerDevTradingRoutes = (app: FastifyInstance, ctx: AppContext): void => {
  app.post("/v1/dev/orders", async (request, reply) => {
    const parsed = orderBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid order", issues: parsed.error.issues });
    }
    const { address, market, side, type, price, size, reduceOnly } = parsed.data;
    await ctx.venue.openTrader(address);
    ctx.stats.recordOrder(address);

    // A fill carries no trader identity by the time any other listener sees
    // it, so it is classified as user activity right here, while this
    // order's own trader is still known - registering it after the call
    // resolves would be too late, since fills fire synchronously inside it.
    const fillsFromThisOrder: Fill[] = [];
    const unsubscribe = ctx.venue.onFill((fill) => fillsFromThisOrder.push(fill));
    let result;
    try {
      result = await ctx.venue.placeOrder(address, {
        market,
        side,
        type,
        price: price === undefined ? undefined : fromDecimalString(price),
        size: fromDecimalString(size),
        reduceOnly,
      });
    } finally {
      unsubscribe();
    }
    for (const fill of fillsFromThisOrder) ctx.stats.recordFill(fill, "user");
    return {
      orderId: result.orderId,
      tag: tagString(result.tag),
      status: result.status,
      filledSize: money(result.filledSize),
      remainingSize: money(result.remainingSize),
      reason: result.reason ?? null,
    };
  });

  app.post("/v1/dev/cancel-all", async (request, reply) => {
    const parsed = cancelAllBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid request", issues: parsed.error.issues });
    }
    const { address, market } = parsed.data;
    const cancelled = await ctx.venue.cancelAll(address, market);
    return { cancelled };
  });

  app.get("/v1/dev/trader", async (request, reply) => {
    const parsed = traderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const state = await ctx.venue.traderState(parsed.data.address);
    const balances: Record<string, { balance: string; locked: string }> = {};
    for (const [token, balance] of Object.entries(state.balances)) {
      balances[token] = { balance: money(balance.balance), locked: money(balance.locked) };
    }
    const positions: Record<string, { size: string; entryPrice: string }> = {};
    for (const [marketId, position] of Object.entries(state.positions)) {
      positions[marketId] = { size: money(position.size), entryPrice: money(position.entryPrice) };
    }
    return {
      trader: state.trader,
      equity: money(state.equity),
      balances,
      positions,
      openOrders: state.openOrders.map((order) => ({
        orderId: order.orderId,
        tag: tagString(order.tag),
        market: order.market,
        side: order.side,
        type: order.type,
        price: order.price === null ? null : money(order.price),
        size: money(order.size),
        remainingSize: money(order.remainingSize),
        reduceOnly: order.reduceOnly,
      })),
    };
  });
};
