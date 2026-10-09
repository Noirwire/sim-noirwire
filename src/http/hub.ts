import type { Candle, CandleInterval } from "../data/candles.js";
import type { PublicStats } from "../data/stats.js";
import type { Fill, MarketId } from "../engine/types.js";
import { money, tagString } from "./serialize.js";

interface Subscriber {
  market: MarketId;
  send: (payload: string) => void;
}

export type StreamMessage =
  | { type: "price"; market: MarketId; price: string; publishedAtMs: number }
  | {
      type: "fill";
      market: MarketId;
      price: string;
      size: string;
      takerSide: Fill["takerSide"];
      takerTag: string;
      makerTag: string;
      timestampMs: number;
      sequence: number;
    }
  | { type: "candle"; market: MarketId; interval: CandleInterval; candle: SerializedCandle }
  | { type: "stats"; stats: SerializedStats };

interface SerializedCandle {
  startMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface SerializedStats {
  user: { orders: number; fills: number; volume: string };
  bot: { orders: number; fills: number; volume: string };
  tradersTotal: number;
  latency: PublicStats["latency"];
  updatedAtMs: number;
}

const serializeCandle = (candle: Candle): SerializedCandle => ({
  startMs: candle.startMs,
  open: money(candle.open),
  high: money(candle.high),
  low: money(candle.low),
  close: money(candle.close),
  volume: money(candle.volume),
});

const serializeStats = (stats: PublicStats): SerializedStats => ({
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

  private sendToMarket(market: MarketId, message: StreamMessage): void {
    const payload = JSON.stringify(message);
    for (const subscriber of this.subscribers) {
      if (subscriber.market === market) subscriber.send(payload);
    }
  }

  broadcastPrice(market: MarketId, price: bigint, publishedAtMs: number): void {
    this.sendToMarket(market, { type: "price", market, price: money(price), publishedAtMs });
  }

  broadcastFill(fill: Fill): void {
    this.sendToMarket(fill.market, {
      type: "fill",
      market: fill.market,
      price: money(fill.price),
      size: money(fill.size),
      takerSide: fill.takerSide,
      takerTag: tagString(fill.takerTag),
      makerTag: tagString(fill.makerTag),
      timestampMs: fill.timestampMs,
      sequence: fill.sequence,
    });
  }

  broadcastCandle(market: MarketId, interval: CandleInterval, candle: Candle): void {
    this.sendToMarket(market, {
      type: "candle",
      market,
      interval,
      candle: serializeCandle(candle),
    });
  }

  broadcastStats(stats: PublicStats): void {
    const payload = JSON.stringify({
      type: "stats",
      stats: serializeStats(stats),
    } satisfies StreamMessage);
    for (const subscriber of this.subscribers) subscriber.send(payload);
  }
}
