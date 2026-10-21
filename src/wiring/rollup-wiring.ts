import { liquidatorTraderKey, makerTraderKey, takerTraderKey } from "../bots/bot-traders.js";
import type { Config } from "../config/config.js";
import type { SnapshotData } from "../data/snapshot.js";
import { systemClock } from "../engine/clock.js";
import { MARKETS, type MarketConfig } from "../engine/markets.js";
import { divScale, roundUpToStep } from "../engine/money.js";
import type { Venue } from "../engine/types.js";
import { placingOrdersThrough } from "../engine/venue-orders.js";
import { STILL_STARTING, VenueNotReady } from "../engine/venue-not-ready.js";
import type { PublicDeployment } from "../rollup/public-deployment.js";
import type { BotSpec } from "../rollup/bot-accounts.js";
import { executed } from "../rollup/chain-types.js";
import { refuseMainnet } from "../rollup/connections.js";
import type { FundRequests } from "../rollup/fund-desk.js";
import { Program } from "../rollup/program.js";
import { type Readiness, RollupVenue } from "../rollup/rollup-venue.js";
import { deployedMarkets, loadDeployment, loadRollupSettings } from "../rollup/settings.js";
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
};

const NO_FAUCET = {
  ok: false,
  status: 503,
  reason: "this deployment has no faucet: test funds are not handed out here",
} as const;

/** A request that needs the venue before the service has connected to it is refused, not failed. */
const refusedWhileStarting = (error: unknown) => {
  if (!(error instanceof VenueNotReady)) throw error;
  return { ok: false, status: 503, reason: error.reason } as const;
};

/**
 * One maker per market, then the takers and the liquidator when they run:
 * each a trader with a seat of its own. A bot's seed is its place in this
 * list, so the makers keep theirs whichever of the others run.
 */
const botRoles = (
  markets: readonly MarketConfig[],
  takerKeys: string[],
  liquidator: boolean,
): BotRole[] => [
  ...markets.map((market) => ({
    key: makerTraderKey(market.id),
    tradesPerps: market.kind === "perp",
    tradesSpot: market.kind === "spot",
  })),
  ...takerKeys.map((key) => ({ key, tradesPerps: true, tradesSpot: true })),
  ...(liquidator ? [{ key: liquidatorTraderKey, tradesPerps: true, tradesSpot: false }] : []),
];

/**
 * The rollup venue, as soon as the service can reach the rollup. Until `prepare`
 * has succeeded, nothing here is connected: the venue the routes see answers
 * with `VenueNotReady`, and the rest answers as a service that is not ready.
 * Configuration that is wrong still throws here, before anything starts.
 *
 * The marks are the program's own and so is funding: nothing here publishes
 * a price or advances funding. Only the markets the deployment has are followed.
 */
export const rollupWiring = (options: RollupWiringOptions): VenueWiring => {
  const { config, data, snapshot, onError, onRecovered } = options;
  const deployment = loadDeployment(config);
  const markets = deployedMarkets(deployment, MARKETS);
  if (!deployment.faucet && (config.NOISE_TAKERS_ENABLED || config.LIQUIDATOR_ENABLED)) {
    throw new Error(
      "this deployment has no faucet, so only the house makers can run on it: " +
        "set NOISE_TAKERS_ENABLED=0 and LIQUIDATOR_ENABLED=0",
    );
  }
  const takerKeys = config.NOISE_TAKERS_ENABLED
    ? Array.from({ length: config.NOISE_TAKER_COUNT }, (_, i) => takerTraderKey(i))
    : [];
  const roles = botRoles(markets, takerKeys, config.LIQUIDATOR_ENABLED);
  const settings = loadRollupSettings(config, deployment, roles.length);
  for (const [at, market] of markets.entries()) {
    onError(
      `the ${market.id} maker's seat owner is ${settings.botOwners[at]?.publicKey.toBase58()}; ` +
        "on a market with a maker list, the exchange admin lists it with set_seat_access",
      null,
    );
  }

  // The counters cover what this process saw happen, not what the tape still holds from before.
  const countingSinceMs = Date.now();
  const userOrders = new UserOrderCount();

  let rollup: RollupVenue | null = null;
  let mainnetRefused = false;

  const connected = (): RollupVenue => {
    if (!rollup) throw new VenueNotReady(STILL_STARTING);
    return rollup;
  };

  const connect = (): Promise<RollupVenue> =>
    RollupVenue.connect({
      program: new Program(settings.deployment.programId),
      settings,
      markets,
      bots: roles.map((role, at) => ({ ...role, owner: settings.botOwners[at] })),
      quoteExpirySeconds: config.ROLLUP_QUOTE_EXPIRY_SECONDS,
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

  const venue: Venue = {
    markets: () => connected().markets(),
    publishPrice: (market) => connected().publishPrice(market),
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

  const openTheOtherBots = async (): Promise<void> => {
    for (const key of takerKeys) {
      await venue.openTrader(key);
      await venue.deposit(key, "nUSD", config.NOISE_TAKER_STARTING_NUSD);
      await venue.deposit(key, "SOL", config.NOISE_TAKER_STARTING_BASE);
    }
    if (config.LIQUIDATOR_ENABLED) {
      await venue.openTrader(liquidatorTraderKey);
      await venue.deposit(liquidatorTraderKey, "nUSD", config.LIQUIDATOR_STARTING_NUSD);
    }
    // Quotes a previous run left resting would fill unrecognised as a bot's.
    for (const market of markets) await venue.cancelAll(makerTraderKey(market.id), market.id);
    for (const { key } of roles) data.stats.recordTrader(key);
  };

  let fundDesk: FundRequests | null = null;
  const viaDesk = async <T>(ask: (desk: FundRequests) => Promise<T>) => {
    try {
      fundDesk ??= connected().fundDesk(config.FUND_AMOUNT_NUSD, systemClock);
      return fundDesk ? await ask(fundDesk) : NO_FAUCET;
    } catch (error) {
      return refusedWhileStarting(error);
    }
  };
  let publicDescription: PublicDeployment | null = null;

  return {
    venue,
    botVenue,
    botMarkets: markets,
    rollupRoutes: {
      fundDesk: {
        prepare: (owner, orderKeys) => viaDesk((desk) => desk.prepare(owner, orderKeys)),
        submit: (owner, transaction) => viaDesk((desk) => desk.submit(owner, transaction)),
      },
      readiness: () => rollup?.readiness() ?? NOT_CONNECTED,
      deployment: () => {
        if (!rollup) return null;
        publicDescription ??= rollup.publicDeployment({
          solanaRpcUrl: config.PUBLIC_SOLANA_RPC_URL ?? settings.solanaRpcUrl,
          rollupRpcUrl: config.PUBLIC_ROLLUP_RPC_URL ?? settings.rollupRpcUrl,
          rollupWsUrl: config.PUBLIC_ROLLUP_WS_URL ?? settings.rollupWsUrl,
        });
        return publicDescription;
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
    resume: () => connected().resume(),
    rest: async () => {
      await rollup?.rest();
    },
    botSizes,
    liquidationTargets: () => connected().nextLiquidationTargets(config.LIQUIDATOR_SEATS_PER_TICK),
    afterMakersOpen: openTheOtherBots,
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
