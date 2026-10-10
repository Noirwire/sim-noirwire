import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DECIMAL_TEXT, fromDecimalString } from "../../engine/money.js";
import { placeOrderWithItsFills } from "../../engine/venue-orders.js";
import type { AppContext } from "../context.js";
import { marketId } from "../schemas.js";
import { money, moneyOrNull, tagString } from "../serialize.js";

const decimalAmount = z.string().regex(DECIMAL_TEXT, "must be a plain decimal number");

const orderBodySchema = z.object({
  address: z.string().min(1),
  market: marketId,
  side: z.enum(["buy", "sell"]),
  type: z.enum(["limit", "postOnly", "ioc", "market"]),
  price: decimalAmount.optional(),
  size: decimalAmount,
  reduceOnly: z.boolean().optional(),
});

const cancelAllBodySchema = z.object({ address: z.string().min(1), market: marketId });

const traderQuerySchema = z.object({ address: z.string().min(1) });

const mapValues = <In, Out>(record: Record<string, In>, map: (value: In) => Out) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));

/**
 * Lets a browser trade against the in-memory venue directly, as a user.
 * Security: the caller names any address it likes and no signature is asked
 * for, so `server.ts` registers these only with VENUE=memory and DEV_TRADING=1.
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
    const { result, fills } = await placeOrderWithItsFills(ctx.venue, address, {
      market,
      side,
      type,
      price: price === undefined ? undefined : fromDecimalString(price),
      size: fromDecimalString(size),
      reduceOnly,
    });
    for (const fill of fills) ctx.stats.recordFill(fill, "user");
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
    return { cancelled: await ctx.venue.cancelAll(address, market) };
  });

  app.get("/v1/dev/trader", async (request, reply) => {
    const parsed = traderQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query", issues: parsed.error.issues });
    }
    const state = await ctx.venue.traderState(parsed.data.address);
    return {
      trader: state.trader,
      equity: money(state.equity),
      balances: mapValues(state.balances, ({ balance, locked }) => ({
        balance: money(balance),
        locked: money(locked),
      })),
      positions: mapValues(state.positions, ({ size, entryPrice }) => ({
        size: money(size),
        entryPrice: money(entryPrice),
      })),
      openOrders: state.openOrders.map((order) => ({
        orderId: order.orderId,
        tag: tagString(order.tag),
        market: order.market,
        side: order.side,
        type: order.type,
        price: moneyOrNull(order.price),
        size: money(order.size),
        remainingSize: money(order.remainingSize),
        reduceOnly: order.reduceOnly,
      })),
    };
  });
};
