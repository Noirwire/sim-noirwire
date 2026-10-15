import { liquidatorTraderKey, makerTraderKey, takerTraderKey } from "../bots/bot-traders.js";
import type { Config } from "../config/config.js";
import type { SnapshotData } from "../data/snapshot.js";
import { systemClock } from "../engine/clock.js";
import { MARKETS, MARKET_IDS, type MarketConfig } from "../engine/markets.js";
import { divScale, roundUpToStep } from "../engine/money.js";
import type { MarketId, Venue } from "../engine/types.js";
import { placingOrdersThrough } from "../engine/venue-orders.js";
import { STILL_STARTING, VenueNotReady } from "../engine/venue-not-ready.js";
import type { PublicDeployment } from "../rollup/public-deployment.js";
import type { BotSpec } from "../rollup/bot-accounts.js";
import { executed } from "../rollup/chain-types.js";
import { refuseMainnet } from "../rollup/connections.js";
import type { FundRequests } from "../rollup/fund-desk.js";
import { Program } from "../rollup/program.js";
import { type Readiness, RollupVenue } from "../rollup/rollup-venue.js";
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
  onRecovered(what: string): void;
  onUnreachable(): void;
}

type BotRole = Omit<BotSpec, "owner">;

const NOT_CONNECTED: Readiness = {
  connected: false,
  pricesFresh: false,
  botsFunded: false,
  fundingUpdates: {},
};

/** A request that needs the venue before the service has connected to it is refused, not failed. */
const refusedWhileStarting = (error: unknown) => {
  if (!(error instanceof VenueNotReady)) throw error;
  return { ok: false, status: 503, reason: error.reason } as const;
};

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

/**
 * The rollup venue, as soon as the service can reach the rollup. Until `prepare`
 * has succeeded, nothing here is connected: the venue the routes see answers
 * with `VenueNotReady`, and the rest answers as a service that is not ready.
 * Configuration that is wrong still throws here, before anything starts.
 */
export const rollupWiring = (options: RollupWiringOptions): VenueWiring => {
  const { config, data, snapshot, onError, onRecovered } = options;
  const takerKeys = Array.from({ length: config.NOISE_TAKER_COUNT }, (_, i) => takerTraderKey(i));
  const roles = botRoles(takerKeys);
  const settings = loadRollupSettings(config, roles.length, MARKET_IDS);

  // The counters cover what this process saw happen, not what the tape still holds from before.
  const countingSinceMs = Date.now();
  const userOrders = new UserOrderCount();

  let rollup: RollupVenue | null = null;
  let mainnetRefused = false;
  /** Where the real price is, per market, for a venue that has not connected yet to take it. */
  const targets = new Map<MarketId, { price: bigint; atMs: number }>();

  const connected = (): RollupVenue => {
    if (!rollup) throw new VenueNotReady(STILL_STARTING);
    return rollup;
  };

  const connect = async (): Promise<RollupVenue> => {
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
        onChainStats: (chain) =>
          data.stats.setUserOrders(userOrders.afterChainOrders(chain.orders)),
        onError,
        onRecovered,
        onUnreachable: options.onUnreachable,
      },
    });
    for (const [market, { price, atMs }] of targets) void venue.publishPrice(market, price, atMs);
    return venue;
  };

  const venue: Venue = {
    markets: () => connected().markets(),
    publishPrice: (market, price, atMs) => connected().publishPrice(market, price, atMs),
    openTrader: (trader) => connected().openTrader(trader),
    deposit: (trader, token, amount) => connected().deposit(trader, token, amount),
    placeOrder: (trader, order) => connected().placeOrder(trader, order),
    cancelAll: (trader, market) => connected().cancelAll(trader, market),
    traderState: (trader) => connected().traderState(trader),
    updateFunding: () => connected().updateFunding(),
    liquidate: (liquidator, target, market) => connected().liquidate(liquidator, target, market),
    onFill: (listener) => connected().onFill(listener),
  };

  const botVenue = placingOrdersThrough(venue, async (trader, order) => {
    userOrders.botOrderSent();
    try {
      return await connected().placeOrder(trader, order);
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

  let fundDesk: FundRequests | null = null;
  const viaDesk = async <T>(ask: (desk: FundRequests) => Promise<T>) => {
    try {
      fundDesk ??= connected().fundDesk(config.FUND_AMOUNT_NUSD, systemClock);
      return await ask(fundDesk);
    } catch (error) {
      return refusedWhileStarting(error);
    }
  };
  let deployment: PublicDeployment | null = null;

  return {
    venue,
    botVenue,
    rollupRoutes: {
      fundDesk: {
        prepare: (owner, orderKeys) => viaDesk((desk) => desk.prepare(owner, orderKeys)),
        submit: (owner, transaction) => viaDesk((desk) => desk.submit(owner, transaction)),
      },
      readiness: () => rollup?.readiness() ?? NOT_CONNECTED,
      deployment: () => {
        if (!rollup) return null;
        deployment ??= rollup.publicDeployment({
          solanaRpcUrl: config.PUBLIC_SOLANA_RPC_URL ?? settings.solanaRpcUrl,
          rollupRpcUrl: config.PUBLIC_ROLLUP_RPC_URL ?? settings.rollupRpcUrl,
          rollupWsUrl: config.PUBLIC_ROLLUP_WS_URL ?? settings.rollupWsUrl,
        });
        return deployment;
      },
    },
    prepare: async () => {
      if (!mainnetRefused) {
        await refuseMainnet(settings.solanaRpcUrl);
        mainnetRefused = true;
      }
      rollup ??= await connect();
      await rollup.follow();
    },
    resume: (sourceNotBeforeMs) => connected().resume(sourceNotBeforeMs),
    rest: async () => {
      await rollup?.rest();
    },
    botSizes,
    liquidationTargets: () => connected().nextLiquidationTargets(config.LIQUIDATOR_SEATS_PER_TICK),
    afterMakersOpen: openTakersAndLiquidator,
    acceptPricePoint: (market, price, atMs) => {
      targets.set(market, { price, atMs });
      void rollup?.publishPrice(market, price, atMs);
    },
    needsFundingUpdater: false,
    snapshotExtras: () => ({
      tapeCursors: rollup?.tapeCursors() ?? snapshot?.tapeCursors ?? {},
      orderKeyCheckpoints: rollup?.keyCheckpoints() ?? snapshot?.orderKeyCheckpoints ?? {},
    }),
    stop: async () => {
      await rollup?.stop();
    },
  };
};
