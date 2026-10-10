import type { FastifyInstance } from "fastify";
import { liquidatorTraderKey, makerTraderKey, takerTraderKey } from "./bots/bot-traders.js";
import { FundingUpdater } from "./bots/funding-updater.js";
import { HouseMaker } from "./bots/house-maker.js";
import { withBotTracking } from "./bots/instrumented-venue.js";
import { Liquidator } from "./bots/liquidator.js";
import { NoiseTaker } from "./bots/noise-taker.js";
import { SeededRandom } from "./bots/rng.js";
import type { Config } from "./config/config.js";
import { CandleAggregator } from "./data/candles.js";
import { FundLedger } from "./data/fund-ledger.js";
import { type SnapshotData, SnapshotStore } from "./data/snapshot.js";
import { StatsTracker } from "./data/stats.js";
import { TapeStore } from "./data/tape-store.js";
import { systemClock } from "./engine/clock.js";
import { MARKETS, type MarketConfig } from "./engine/markets.js";
import { MemoryVenue } from "./engine/memory-venue.js";
import { divScale } from "./engine/money.js";
import type { Fill, MarketInfo, TraderKey, Venue } from "./engine/types.js";
import type { AppContext } from "./http/context.js";
import { Hub } from "./http/hub.js";
import { buildServer } from "./http/server.js";
import { JupiterPriceSource } from "./prices/jupiter-price-source.js";
import type { PriceSource } from "./prices/price-source.js";
import { Program, refuseMainnet } from "./rollup/program.js";
import { type BotSpec, RollupVenue, executed } from "./rollup/rollup-venue.js";
import { loadRollupSettings } from "./rollup/settings.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

const MARKETS_FOR_MINT: Record<string, string[]> = {
  [SOL_MINT]: ["NSOL-PERP", "NSOL-NUSD"],
  [NVDAX_MINT]: ["NNVDA-PERP"],
};

const STATS_BROADCAST_INTERVAL_MS = 2_000;
const WAIT_FOR_TICKS_ON_CLOSE_MS = 10_000;

export interface RunningApp {
  server: FastifyInstance;
  port: number;
  /** Resolves once the bots are open and funded and their timers run. */
  botsStarted: Promise<void>;
  close(): Promise<void>;
}

export interface AppOverrides {
  priceSource?: PriceSource;
}

interface BotSizes {
  makerLevel: bigint;
  takerMin: bigint;
  takerMax: bigint;
  lotSize: bigint;
  takerBase: bigint;
}

interface VenueWiring {
  venue: Venue;
  botVenue: Venue;
  context: Pick<AppContext, "funding" | "readiness" | "deployment">;
  sizes(market: MarketConfig): Promise<BotSizes>;
  liquidationTargets(): TraderKey[];
  /** Runs once every bot is open and funded, before the first bot tick. */
  afterBotsOpen(makers: HouseMaker[]): Promise<void>;
  onPricePoint(market: string, price: bigint, atMs: number): void;
  snapshotExtras(): Partial<SnapshotData>;
  stop(): Promise<void>;
}

const logError = (what: string, error: unknown): void => {
  const detail = error instanceof Error ? error.message.split("\n")[0] : (error ?? "");
  console.error(`sim-noirwire: ${what}`, detail);
};

const ticksInFlight = new Set<Promise<unknown>>();

/** A timer callback that never overlaps itself: a slow tick is skipped over, not stacked. */
const oneAtATime = (what: string, work: () => Promise<unknown>): (() => void) => {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    const tick = work()
      .catch((error) => logError(what, error))
      .finally(() => {
        busy = false;
        ticksInFlight.delete(tick);
      });
    ticksInFlight.add(tick);
  };
};

const roundUpToLot = (size: bigint, lot: bigint): bigint =>
  size % lot === 0n ? size : size - (size % lot) + lot;

const broadcastFill = (
  fill: Fill,
  { tape, candles, hub }: Pick<AppContext, "tape" | "candles" | "hub">,
): void => {
  tape.record(fill);
  candles.record(fill);
  hub.broadcastFill(fill);
  const latest1m = candles.candles(fill.market, "1m", 1)[0];
  if (latest1m) hub.broadcastCandle(fill.market, "1m", latest1m);
};

const memoryWiring = (
  config: Config,
  data: Pick<AppContext, "tape" | "candles" | "hub" | "stats">,
): VenueWiring => {
  const venue = new MemoryVenue({
    insuranceSeedBalance: config.INSURANCE_SEED_NUSD,
    maxFundingRateBpsPerUpdate: config.MAX_FUNDING_RATE_BPS_PER_UPDATE,
    latencyWindowSize: config.STATS_LATENCY_WINDOW,
  });
  // Bot and user fills are counted where the order is placed (withBotTracking
  // and the dev trading route): a fill carries no trader by the time it gets here.
  venue.onFill((fill) => broadcastFill(fill, data));
  return {
    venue,
    botVenue: withBotTracking(venue, data.stats),
    context: {},
    sizes: async (market) => ({
      makerLevel: market.lotSize * 5n,
      takerMin: market.lotSize,
      takerMax: market.lotSize * 20n,
      lotSize: market.lotSize,
      takerBase: config.NOISE_TAKER_STARTING_BASE,
    }),
    liquidationTargets: () => data.stats.allTraderKeys(),
    afterBotsOpen: async () => {},
    onPricePoint: (market, price, atMs) => data.hub.broadcastPrice(market, price, atMs),
    snapshotExtras: () => ({}),
    stop: async () => {},
  };
};

const rollupWiring = async (
  config: Config,
  data: Pick<AppContext, "tape" | "candles" | "hub" | "stats">,
  snapshot: SnapshotData | null,
  usersEverOpened: () => number,
): Promise<VenueWiring> => {
  const takerKeys = Array.from({ length: config.NOISE_TAKER_COUNT }, (_, i) => takerTraderKey(i));
  const roles: Omit<BotSpec, "owner">[] = [
    ...MARKETS.map((market) => ({
      key: makerTraderKey(market.id),
      tradesPerps: market.kind === "perp",
      tradesSpot: market.kind === "spot",
    })),
    ...takerKeys.map((key) => ({ key, tradesPerps: true, tradesSpot: true })),
    { key: liquidatorTraderKey, tradesPerps: true, tradesSpot: false },
  ];
  const settings = loadRollupSettings(
    config,
    roles.length,
    MARKETS.map((market) => market.id),
  );
  await refuseMainnet(settings.solanaRpcUrl);

  const countingSinceMs = Date.now();
  let ordersAtStart: bigint | null = null;
  let chainOrders = 0n;
  let botOrdersExecuted = 0;
  let botOrdersInFlight = 0;
  const countUserOrders = (): void =>
    data.stats.setUserOrders(Number(chainOrders) - botOrdersExecuted - botOrdersInFlight);

  const venue = await RollupVenue.connect({
    program: new Program(settings.deployment.programId),
    settings,
    markets: MARKETS,
    bots: roles.map((role, at) => ({ ...role, owner: settings.botOwners[at]! })),
    quoteExpirySeconds: config.ROLLUP_QUOTE_EXPIRY_SECONDS,
    publishIntervalMs: config.PRICE_PUBLISH_INTERVAL_MS,
    latencyWindowSize: config.STATS_LATENCY_WINDOW,
    measuredFrom: config.SERVICE_LOCATION,
    recordedThrough: snapshot?.tapeCursors ?? {},
    keyCheckpoints: snapshot?.orderKeyCheckpoints ?? {},
    usersEverOpened,
    handlers: {
      onFill: ({ fill, origin, replayed }) => {
        if (replayed) {
          data.tape.record(fill);
          return;
        }
        broadcastFill(fill, data);
        if (fill.timestampMs >= countingSinceMs) data.stats.recordFill(fill, origin);
      },
      onPrice: (market, price, publishedAtMs) =>
        data.hub.broadcastPrice(market, price, publishedAtMs),
      onBotOrder: (trader, outcome) => {
        if (!executed(outcome)) return;
        botOrdersExecuted += 1;
        data.stats.recordOrder(trader);
        data.stats.recordLatency(outcome.sendToResultMs);
      },
      onBotOrderUnknown: () => data.stats.recordBotOrderUnknown(),
      onBotOrderSettled: (_trader, executedAfterAll) =>
        data.stats.recordBotOrderSettled(executedAfterAll),
      onChainStats: (chain) => {
        ordersAtStart ??= chain.orders;
        chainOrders = chain.orders - ordersAtStart;
        countUserOrders();
      },
      onError: logError,
    },
  });
  await venue.start();

  const botVenue: Venue = {
    markets: () => venue.markets(),
    publishPrice: (market, price) => venue.publishPrice(market, price),
    openTrader: (trader) => venue.openTrader(trader),
    deposit: (trader, token, amount) => venue.deposit(trader, token, amount),
    placeOrder: async (trader, order) => {
      botOrdersInFlight += 1;
      try {
        return await venue.placeOrder(trader, order);
      } finally {
        botOrdersInFlight -= 1;
      }
    },
    cancelAll: (trader, market) => venue.cancelAll(trader, market),
    traderState: (trader) => venue.traderState(trader),
    updateFunding: () => venue.updateFunding(),
    liquidate: (liquidator, target, market) => venue.liquidate(liquidator, target, market),
    onFill: (listener) => venue.onFill(listener),
    stats: () => venue.stats(),
  };

  const marketInfo = async (market: MarketConfig): Promise<MarketInfo & { markPrice: bigint }> => {
    const info = (await venue.markets()).find((entry) => entry.id === market.id);
    if (!info || info.markPrice === null) {
      throw new Error(`${market.id} has no price on chain yet: the deployment is not set up`);
    }
    return { ...info, markPrice: info.markPrice };
  };

  return {
    venue,
    botVenue,
    context: {
      funding: venue.fundingDesk(config.FUND_AMOUNT_NUSD, systemClock),
      readiness: () => venue.readiness(),
      deployment: venue.publicDeployment({
        solanaRpcUrl: config.PUBLIC_SOLANA_RPC_URL ?? settings.solanaRpcUrl,
        rollupRpcUrl: config.PUBLIC_ROLLUP_RPC_URL ?? settings.rollupRpcUrl,
        rollupWsUrl: config.PUBLIC_ROLLUP_WS_URL ?? settings.rollupWsUrl,
      }),
    },
    sizes: async (market) => {
      const { markPrice, lotSize } = await marketInfo(market);
      const lots = (notional: bigint) => roundUpToLot(divScale(notional, markPrice), lotSize);
      return {
        makerLevel: lots(config.ROLLUP_MAKER_LEVEL_NUSD),
        takerMin: lots(config.ROLLUP_TAKER_MIN_NUSD),
        takerMax: lots(config.ROLLUP_TAKER_MAX_NUSD),
        lotSize,
        takerBase: market.kind === "spot" ? config.NOISE_TAKER_STARTING_BASE : 0n,
      };
    },
    liquidationTargets: () => venue.nextLiquidationTargets(config.LIQUIDATOR_SEATS_PER_TICK),
    afterBotsOpen: async (makers) => {
      for (const key of takerKeys) {
        await venue.openTrader(key);
        await venue.deposit(key, "nUSD", config.NOISE_TAKER_STARTING_NUSD);
        await venue.deposit(key, "SOL", config.NOISE_TAKER_STARTING_BASE);
      }
      await venue.openTrader(liquidatorTraderKey);
      await venue.deposit(liquidatorTraderKey, "nUSD", config.LIQUIDATOR_STARTING_NUSD);
      // Quotes a previous run left resting would fill unrecognised as a bot's.
      for (const [at, maker] of makers.entries()) {
        await venue.cancelAll(maker.traderKey(), MARKETS[at]!.id);
      }
      for (const key of roles.map((role) => role.key)) data.stats.recordTrader(key);
    },
    onPricePoint: () => {},
    snapshotExtras: () => ({
      tapeCursors: venue.tapeCursors(),
      orderKeyCheckpoints: venue.keyCheckpoints(),
    }),
    stop: () => venue.stop(),
  };
};

/** Wires the venue, the bots, the price source and the HTTP server, and starts them all. */
export const startApp = async (
  config: Config,
  overrides: AppOverrides = {},
): Promise<RunningApp> => {
  const tape = new TapeStore();
  const candles = new CandleAggregator();
  const stats =
    config.VENUE === "rollup"
      ? new StatsTracker(
          config.STATS_LATENCY_WINDOW,
          `a bot's order, from its send to the result in its private view, measured from ${config.SERVICE_LOCATION}`,
        )
      : new StatsTracker(config.STATS_LATENCY_WINDOW);
  const fundLedger = new FundLedger({
    perIpLimit: config.FUND_IP_RATE_LIMIT,
    perIpWindowMs: config.FUND_IP_RATE_WINDOW_MS,
    clock: systemClock,
  });
  const hub = new Hub();
  const data = { tape, candles, stats, hub };

  const snapshotStore = new SnapshotStore(config.DATA_DIR);
  const existingSnapshot = await snapshotStore.load();
  if (existingSnapshot) {
    candles.loadSnapshot(existingSnapshot.candles);
    fundLedger.loadSnapshot(existingSnapshot.fundedAddresses);
    console.log(
      `sim-noirwire: loaded snapshot from ${new Date(existingSnapshot.savedAtMs).toISOString()}`,
    );
  }

  const wiring =
    config.VENUE === "rollup"
      ? await rollupWiring(
          config,
          data,
          existingSnapshot,
          // Seats opened by anything else (a set-up's own test traders) sit among ours.
          () => fundLedger.exportSnapshot().length + config.LIQUIDATOR_EXTRA_SEATS,
        )
      : memoryWiring(config, data);
  const { venue, botVenue } = wiring;

  const server = await buildServer({ config, venue, ...data, fundLedger, ...wiring.context });
  await server.listen({ port: config.PORT, host: config.HOST });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.PORT;
  console.log(`sim-noirwire: listening on http://${config.HOST}:${port} (venue=${config.VENUE})`);

  const priceSource =
    overrides.priceSource ??
    new JupiterPriceSource({
      ids: [SOL_MINT, NVDAX_MINT],
      baseUrl: config.JUPITER_BASE_URL,
      pollIntervalMs: config.JUPITER_POLL_INTERVAL_MS,
      onError: (error) => logError("price poll failed", error),
    });
  priceSource.start((point) => {
    for (const marketId of MARKETS_FOR_MINT[point.id] ?? []) {
      void venue.publishPrice(marketId, point.price, point.atMs);
      wiring.onPricePoint(marketId, point.price, point.atMs);
    }
  });

  const timers: ReturnType<typeof setInterval>[] = [
    setInterval(() => hub.broadcastStats(stats.snapshot(Date.now())), STATS_BROADCAST_INTERVAL_MS),
  ];

  const startBots = async (): Promise<void> => {
    const random = new SeededRandom(config.NOISE_TAKER_SEED);
    const makers: HouseMaker[] = [];
    const noiseTakers: NoiseTaker[] = [];
    for (const marketConfig of MARKETS) {
      const sizes = await wiring.sizes(marketConfig);
      const maker = new HouseMaker({
        market: marketConfig.id,
        kind: marketConfig.kind,
        baseToken: marketConfig.base,
        quoteToken: marketConfig.quote,
        levels: config.HOUSE_MAKER_LEVELS,
        spreadBps: config.HOUSE_MAKER_SPREAD_BPS,
        levelStepBps: config.HOUSE_MAKER_LEVEL_STEP_BPS,
        baseSizePerLevel: sizes.makerLevel,
        requoteThresholdBps: config.HOUSE_MAKER_REQUOTE_THRESHOLD_BPS,
        requoteIntervalMs: config.HOUSE_MAKER_REQUOTE_INTERVAL_MS,
        positionLimitNotional: config.HOUSE_MAKER_POSITION_LIMIT_NUSD,
        maxSkewBps: config.HOUSE_MAKER_MAX_SKEW_BPS,
        lotSize: sizes.lotSize,
        startingQuoteBalance: config.HOUSE_MAKER_POSITION_LIMIT_NUSD * 4n,
        startingBaseBalance: config.NOISE_TAKER_STARTING_BASE * 10n,
        clock: systemClock,
      });
      await maker.ensureOpen(botVenue);
      makers.push(maker);

      noiseTakers.push(
        new NoiseTaker({
          market: marketConfig.id,
          baseToken: marketConfig.base,
          traderCount: config.NOISE_TAKER_COUNT,
          minSize: sizes.takerMin,
          maxSize: sizes.takerMax,
          lotSize: sizes.lotSize,
          minIntervalMs: config.NOISE_TAKER_MIN_INTERVAL_MS,
          maxIntervalMs: config.NOISE_TAKER_MAX_INTERVAL_MS,
          worstPriceSlippageBps: config.NOISE_TAKER_WORST_SLIPPAGE_BPS,
          startingBalanceQuote: config.NOISE_TAKER_STARTING_NUSD,
          startingBalanceBase: sizes.takerBase,
          clock: systemClock,
          random,
        }),
      );
    }
    await wiring.afterBotsOpen(makers);

    const perpMarketIds = MARKETS.filter((m) => m.kind === "perp").map((m) => m.id);
    const liquidator = new Liquidator({
      markets: perpMarketIds,
      startingBalanceQuote: config.LIQUIDATOR_STARTING_NUSD,
    });
    const fundingUpdater = new FundingUpdater({
      markets: perpMarketIds,
      intervalMs: config.FUNDING_INTERVAL_MS,
      clock: systemClock,
    });

    timers.push(
      ...makers.map((maker) =>
        setInterval(
          oneAtATime("maker tick failed", () => maker.tick(botVenue)),
          config.HOUSE_MAKER_TICK_MS,
        ),
      ),
      ...noiseTakers.map((taker) =>
        setInterval(
          oneAtATime("taker tick failed", () => taker.tick(botVenue)),
          config.NOISE_TAKER_TICK_MS,
        ),
      ),
      setInterval(
        oneAtATime("liquidator tick failed", () =>
          liquidator.tick(botVenue, wiring.liquidationTargets()),
        ),
        config.LIQUIDATOR_INTERVAL_MS,
      ),
      setInterval(
        oneAtATime("funding update failed", () => fundingUpdater.tick(venue)),
        Math.min(config.FUNDING_INTERVAL_MS, 5_000),
      ),
    );
  };

  let closed = false;
  const botsStarted = startBots().then(() => {
    if (closed) for (const timer of timers) clearInterval(timer);
  });
  botsStarted.catch((error) => logError("the bots did not start", error));

  const saveSnapshot = async (): Promise<void> => {
    await snapshotStore.save({
      savedAtMs: Date.now(),
      candles: candles.exportSnapshot(),
      fundedAddresses: fundLedger.exportSnapshot(),
      ...wiring.snapshotExtras(),
    });
  };
  timers.push(
    setInterval(oneAtATime("snapshot failed", saveSnapshot), config.SNAPSHOT_INTERVAL_MS),
  );

  return {
    server,
    port,
    botsStarted,
    close: async () => {
      closed = true;
      for (const timer of timers) clearInterval(timer);
      priceSource.stop();
      // A bot's order still on its way moves its order keys on: the snapshot
      // is taken once every tick has finished, so the checkpoints are final.
      // The wait is bounded: a stop must not depend on the network answering.
      await Promise.race([
        Promise.allSettled([...ticksInFlight]),
        new Promise((resolve) => setTimeout(resolve, WAIT_FOR_TICKS_ON_CLOSE_MS)),
      ]);
      await wiring.stop();
      await saveSnapshot();
      await server.close();
    },
  };
};
