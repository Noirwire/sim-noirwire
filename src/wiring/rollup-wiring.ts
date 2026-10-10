import { liquidatorTraderKey, makerTraderKey, takerTraderKey } from "../bots/bot-traders.js";
import type { Config } from "../config/config.js";
import type { SnapshotData } from "../data/snapshot.js";
import { systemClock } from "../engine/clock.js";
import { MARKETS, MARKET_IDS, type MarketConfig } from "../engine/markets.js";
import { divScale, roundUpToStep } from "../engine/money.js";
import { placingOrdersThrough } from "../engine/venue-orders.js";
import type { BotSpec } from "../rollup/bot-accounts.js";
import { executed } from "../rollup/chain-types.js";
import { refuseMainnet } from "../rollup/connections.js";
import { Program } from "../rollup/program.js";
import { RollupVenue } from "../rollup/rollup-venue.js";
import { loadRollupSettings } from "../rollup/settings.js";
import { UserOrderCount } from "./user-order-count.js";
import { type PublicData, type VenueWiring, recordAndBroadcastFill } from "./venue-wiring.js";

export interface RollupWiringOptions {
  config: Config;
  data: PublicData;
  snapshot: SnapshotData | null;
  /** How many user accounts this service has opened, ever. */
  usersEverOpened(): number;
  onError(what: string, error: unknown): void;
}

type BotRole = Omit<BotSpec, "owner">;

/** One maker per market, the takers, and the liquidator: each a trader with a seat of its own. */
const botRoles = (takerKeys: string[]): BotRole[] => [
  ...MARKETS.map((market) => ({
    key: makerTraderKey(market.id),
    tradesPerps: market.kind === "perp",
    tradesSpot: market.kind === "spot",
  })),
  ...takerKeys.map((key) => ({ key, tradesPerps: true, tradesSpot: true })),
  { key: liquidatorTraderKey, tradesPerps: true, tradesSpot: false },
];

export const rollupWiring = async (options: RollupWiringOptions): Promise<VenueWiring> => {
  const { config, data, snapshot, onError } = options;
  const takerKeys = Array.from({ length: config.NOISE_TAKER_COUNT }, (_, i) => takerTraderKey(i));
  const roles = botRoles(takerKeys);
  const settings = loadRollupSettings(config, roles.length, MARKET_IDS);
  await refuseMainnet(settings.solanaRpcUrl);

  // The counters cover what this process saw happen, not what the tape still holds from before.
  const countingSinceMs = Date.now();
  const userOrders = new UserOrderCount();

  const venue = await RollupVenue.connect({
    program: new Program(settings.deployment.programId),
    settings,
    markets: MARKETS,
    bots: roles.map((role, at) => ({ ...role, owner: settings.botOwners[at] })),
    quoteExpirySeconds: config.ROLLUP_QUOTE_EXPIRY_SECONDS,
    publishIntervalMs: config.PRICE_PUBLISH_INTERVAL_MS,
    recordedThrough: snapshot?.tapeCursors ?? {},
    keyCheckpoints: snapshot?.orderKeyCheckpoints ?? {},
    usersEverOpened: options.usersEverOpened,
    handlers: {
      onFill: ({ fill, origin, replayed }) => {
        if (replayed) {
          data.tape.record(fill);
          return;
        }
        recordAndBroadcastFill(fill, data);
        if (fill.timestampMs >= countingSinceMs) data.stats.recordFill(fill, origin);
      },
      onPrice: (market, price, publishedAtMs) =>
        data.hub.broadcastPrice(market, price, publishedAtMs),
      onBotOrder: (trader, outcome) => {
        if (!executed(outcome)) return;
        userOrders.botOrderExecuted();
        data.stats.recordOrder(trader);
        data.stats.recordLatency(outcome.sendToResultMs);
      },
      onBotOrderUnknown: () => data.stats.recordBotOrderUnknown(),
      onBotOrderSettled: (executedAfterAll) => data.stats.recordBotOrderSettled(executedAfterAll),
      onChainStats: (chain) => data.stats.setUserOrders(userOrders.afterChainOrders(chain.orders)),
      onError,
    },
  });
  await venue.start();

  const botVenue = placingOrdersThrough(venue, async (trader, order) => {
    userOrders.botOrderSent();
    try {
      return await venue.placeOrder(trader, order);
    } finally {
      userOrders.botOrderAnswered();
    }
  });

  const botSizes = async (market: MarketConfig) => {
    const info = (await venue.markets()).find((entry) => entry.id === market.id);
    if (!info || info.markPrice === null) {
      throw new Error(`${market.id} has no price on chain yet: the deployment is not set up`);
    }
    const { markPrice, lotSize } = info;
    const lots = (notional: bigint) => roundUpToStep(divScale(notional, markPrice), lotSize);
    return {
      makerLevel: lots(config.ROLLUP_MAKER_LEVEL_NUSD),
      takerMin: lots(config.ROLLUP_TAKER_MIN_NUSD),
      takerMax: lots(config.ROLLUP_TAKER_MAX_NUSD),
      lotSize,
      takerStartingBase: market.kind === "spot" ? config.NOISE_TAKER_STARTING_BASE : 0n,
    };
  };

  const openTakersAndLiquidator = async (): Promise<void> => {
    for (const key of takerKeys) {
      await venue.openTrader(key);
      await venue.deposit(key, "nUSD", config.NOISE_TAKER_STARTING_NUSD);
      await venue.deposit(key, "SOL", config.NOISE_TAKER_STARTING_BASE);
    }
    await venue.openTrader(liquidatorTraderKey);
    await venue.deposit(liquidatorTraderKey, "nUSD", config.LIQUIDATOR_STARTING_NUSD);
    // Quotes a previous run left resting would fill unrecognised as a bot's.
    for (const market of MARKETS) await venue.cancelAll(makerTraderKey(market.id), market.id);
    for (const { key } of roles) data.stats.recordTrader(key);
  };

  return {
    venue,
    botVenue,
    rollupRoutes: {
      fundDesk: venue.fundDesk(config.FUND_AMOUNT_NUSD, systemClock),
      readiness: () => venue.readiness(),
      deployment: venue.publicDeployment({
        solanaRpcUrl: config.PUBLIC_SOLANA_RPC_URL ?? settings.solanaRpcUrl,
        rollupRpcUrl: config.PUBLIC_ROLLUP_RPC_URL ?? settings.rollupRpcUrl,
        rollupWsUrl: config.PUBLIC_ROLLUP_WS_URL ?? settings.rollupWsUrl,
      }),
    },
    botSizes,
    liquidationTargets: () => venue.nextLiquidationTargets(config.LIQUIDATOR_SEATS_PER_TICK),
    afterMakersOpen: openTakersAndLiquidator,
    acceptPricePoint: (market, price) => void venue.publishPrice(market, price),
    needsFundingUpdater: false,
    snapshotExtras: () => ({
      tapeCursors: venue.tapeCursors(),
      orderKeyCheckpoints: venue.keyCheckpoints(),
    }),
    stop: () => venue.stop(),
  };
};
