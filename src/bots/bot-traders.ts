import type { MarketId, TraderKey } from "../engine/types.js";

const BOT_PREFIX = "bot:";

export const makerTraderKey = (market: MarketId): TraderKey => `${BOT_PREFIX}maker:${market}`;

export const takerTraderKey = (index: number): TraderKey => `${BOT_PREFIX}taker:${index}`;

export const liquidatorTraderKey: TraderKey = `${BOT_PREFIX}liquidator`;

export const isBotTrader = (trader: TraderKey): boolean => trader.startsWith(BOT_PREFIX);
