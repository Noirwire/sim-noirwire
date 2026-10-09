import { FundingUpdater } from "./bots/funding-updater.js";
import { HouseMaker } from "./bots/house-maker.js";
import { withBotTracking } from "./bots/instrumented-venue.js";
import { Liquidator } from "./bots/liquidator.js";
import { NoiseTaker } from "./bots/noise-taker.js";
import { SeededRandom } from "./bots/rng.js";
import { loadConfig } from "./config/config.js";
import { CandleAggregator } from "./data/candles.js";
import { FundLedger } from "./data/fund-ledger.js";
import { SnapshotStore } from "./data/snapshot.js";
import { StatsTracker } from "./data/stats.js";
import { TapeStore } from "./data/tape-store.js";
import { systemClock } from "./engine/clock.js";
import { MARKETS } from "./engine/markets.js";
import { MemoryVenue } from "./engine/memory-venue.js";
import { Hub } from "./http/hub.js";
import { buildServer } from "./http/server.js";
import { JupiterPriceSource } from "./prices/jupiter-price-source.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const NVDAX_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";

const MARKETS_FOR_MINT: Record<string, string[]> = {
  [SOL_MINT]: ["NSOL-PERP", "NSOL-NUSD"],
  [NVDAX_MINT]: ["NNVDA-PERP"],
};

const STATS_BROADCAST_INTERVAL_MS = 2_000;

const main = async (): Promise<void> => {
  const config = loadConfig();

  if (config.VENUE !== "memory") {
    throw new Error(`VENUE=${config.VENUE} has no client yet; only memory is available`);
  }

  const venue = new MemoryVenue({
    insuranceSeedBalance: config.INSURANCE_SEED_NUSD,
    maxFundingRateBpsPerUpdate: config.MAX_FUNDING_RATE_BPS_PER_UPDATE,
    latencyWindowSize: config.STATS_LATENCY_WINDOW,
  });

  const tape = new TapeStore();
  const candles = new CandleAggregator();
  const stats = new StatsTracker(config.STATS_LATENCY_WINDOW);
  const fundLedger = new FundLedger({
    perIpLimit: config.FUND_IP_RATE_LIMIT,
    perIpWindowMs: config.FUND_IP_RATE_WINDOW_MS,
    clock: systemClock,
  });
  const hub = new Hub();

  const snapshotStore = new SnapshotStore(config.DATA_DIR);
  const existingSnapshot = await snapshotStore.load();
  if (existingSnapshot) {
    candles.loadSnapshot(existingSnapshot.candles);
    fundLedger.loadSnapshot(existingSnapshot.fundedAddresses);
    console.log(
      `sim-noirwire: loaded snapshot from ${new Date(existingSnapshot.savedAtMs).toISOString()}`,
    );
  }

  // Bot vs. user volume/fills are counted at the placeOrder call site, not
  // here: see withBotTracking and the dev trading route. A fill carries no
  // trader identity by the time this listener sees it.
  venue.onFill((fill) => {
    tape.record(fill);
    candles.record(fill);
    hub.broadcastFill(fill);
    const latest1m = candles.candles(fill.market, "1m", 1)[0];
    if (latest1m) hub.broadcastCandle(fill.market, "1m", latest1m);
  });

  const botVenue = withBotTracking(venue, stats);
  const random = new SeededRandom(config.NOISE_TAKER_SEED);

  const makers: HouseMaker[] = [];
  const noiseTakers: NoiseTaker[] = [];
  for (const marketConfig of MARKETS) {
    const maker = new HouseMaker({
      market: marketConfig.id,
      kind: marketConfig.kind,
      baseToken: marketConfig.base,
      quoteToken: marketConfig.quote,
      levels: config.HOUSE_MAKER_LEVELS,
      spreadBps: config.HOUSE_MAKER_SPREAD_BPS,
      levelStepBps: config.HOUSE_MAKER_LEVEL_STEP_BPS,
      baseSizePerLevel: marketConfig.lotSize * 5n,
      requoteThresholdBps: config.HOUSE_MAKER_REQUOTE_THRESHOLD_BPS,
      requoteIntervalMs: config.HOUSE_MAKER_REQUOTE_INTERVAL_MS,
      positionLimitNotional: config.HOUSE_MAKER_POSITION_LIMIT_NUSD,
      maxSkewBps: config.HOUSE_MAKER_MAX_SKEW_BPS,
      lotSize: marketConfig.lotSize,
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
        minSize: marketConfig.lotSize,
        maxSize: marketConfig.lotSize * 20n,
        lotSize: marketConfig.lotSize,
        minIntervalMs: config.NOISE_TAKER_MIN_INTERVAL_MS,
        maxIntervalMs: config.NOISE_TAKER_MAX_INTERVAL_MS,
        worstPriceSlippageBps: config.NOISE_TAKER_WORST_SLIPPAGE_BPS,
        startingBalanceQuote: config.NOISE_TAKER_STARTING_NUSD,
        startingBalanceBase: config.NOISE_TAKER_STARTING_BASE,
        clock: systemClock,
        random,
      }),
    );
  }

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

  const priceSource = new JupiterPriceSource({
    ids: [SOL_MINT, NVDAX_MINT],
    baseUrl: config.JUPITER_BASE_URL,
    pollIntervalMs: config.JUPITER_POLL_INTERVAL_MS,
    onError: (error) => console.error("sim-noirwire: price poll failed", error),
  });
  priceSource.start((point) => {
    const marketIds = MARKETS_FOR_MINT[point.id] ?? [];
    for (const marketId of marketIds) {
      void venue.publishPrice(marketId, point.price, point.atMs);
      hub.broadcastPrice(marketId, point.price, point.atMs);
    }
  });

  const ctx = { config, venue, tape, candles, stats, fundLedger, hub };
  const app = await buildServer(ctx);
  await app.listen({ port: config.PORT, host: config.HOST });
  console.log(
    `sim-noirwire: listening on http://${config.HOST}:${config.PORT} (venue=${config.VENUE})`,
  );

  const botTimers = [
    setInterval(
      () => void Promise.all(makers.map((maker) => maker.tick(botVenue))),
      config.HOUSE_MAKER_TICK_MS,
    ),
    setInterval(
      () => void Promise.all(noiseTakers.map((taker) => taker.tick(botVenue))),
      config.NOISE_TAKER_TICK_MS,
    ),
    setInterval(
      () => void liquidator.tick(botVenue, stats.allTraderKeys()),
      config.LIQUIDATOR_INTERVAL_MS,
    ),
    setInterval(() => void fundingUpdater.tick(venue), Math.min(config.FUNDING_INTERVAL_MS, 5_000)),
    setInterval(() => hub.broadcastStats(stats.snapshot(Date.now())), STATS_BROADCAST_INTERVAL_MS),
  ];

  const saveSnapshot = async (): Promise<void> => {
    await snapshotStore.save({
      savedAtMs: Date.now(),
      candles: candles.exportSnapshot(),
      fundedAddresses: fundLedger.exportSnapshot(),
    });
  };
  const snapshotTimer = setInterval(() => void saveSnapshot(), config.SNAPSHOT_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`sim-noirwire: ${signal} received, shutting down`);
    for (const timer of [...botTimers, snapshotTimer]) clearInterval(timer);
    priceSource.stop();
    await saveSnapshot();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
};

void main();
