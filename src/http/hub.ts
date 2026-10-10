import type { Candle, CandleInterval } from "../data/candles.js";
import type { PublicStats } from "../data/stats.js";
import type { Fill, MarketId } from "../engine/types.js";
import { money, serializeCandle, serializeFill } from "./serialize.js";

interface Subscriber {
  market: MarketId;
  send: (payload: string) => void;
}

type StreamMessage =
  | { type: "price"; market: MarketId; price: string; publishedAtMs: number }
  | ({ type: "fill" } & ReturnType<typeof serializeFill>)
  | {
      type: "candle";
      market: MarketId;
      interval: CandleInterval;
      candle: ReturnType<typeof serializeCandle>;
    }
  | { type: "stats"; stats: ReturnType<typeof serializeStats> };

const serializeStats = (stats: PublicStats) => ({
  user: { orders: stats.user.orders, fills: stats.user.fills, volume: money(stats.user.volume) },
  bot: { orders: stats.bot.orders, fills: stats.bot.fills, volume: money(stats.bot.volume) },
  tradersTotal: stats.tradersTotal,
  latency: stats.latency,
  updatedAtMs: stats.updatedAtMs,
});

/** Fans out price, fill, candle and stats messages to websocket clients, each subscribed to one market. */
export class Hub {
  private readonly subscribers = new Set<Subscriber>();

  subscribe(market: MarketId, send: (payload: string) => void): () => void {
    const subscriber: Subscriber = { market, send };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private send(message: StreamMessage, market?: MarketId): void {
    const payload = JSON.stringify(message);
    for (const subscriber of this.subscribers) {
      if (market === undefined || subscriber.market === market) subscriber.send(payload);
    }
  }

  broadcastPrice(market: MarketId, price: bigint, publishedAtMs: number): void {
    this.send({ type: "price", market, price: money(price), publishedAtMs }, market);
  }

  broadcastFill(fill: Fill): void {
    this.send({ type: "fill", ...serializeFill(fill) }, fill.market);
  }

  broadcastCandle(market: MarketId, interval: CandleInterval, candle: Candle): void {
    this.send({ type: "candle", market, interval, candle: serializeCandle(candle) }, market);
  }

  /** Stats go to every subscriber, whatever its market. */
  broadcastStats(stats: PublicStats): void {
    this.send({ type: "stats", stats: serializeStats(stats) });
  }
}
