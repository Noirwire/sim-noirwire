import type { FastifyInstance } from "fastify";
import { Activity, type Lifecycle } from "./activity/activity.js";
import { type Config, isMainnet } from "./config/config.js";
import { CandleAggregator } from "./data/candles.js";
import { FundLedger } from "./data/fund-ledger.js";
import { SnapshotStore } from "./data/snapshot.js";
import { StatsTracker } from "./data/stats.js";
import { TapeStore } from "./data/tape-store.js";
import { systemClock } from "./engine/clock.js";
import type { HedgeVenue } from "./hedge/hedge-venue.js";
import { HedgeVenueLoadError, hedgeVenueFor } from "./hedge/venue-loader.js";
import { Hub } from "./http/hub.js";
import { buildServer } from "./http/server.js";
import { firstLine } from "./logging/first-line.js";
import { ProblemLog } from "./logging/problem-log.js";
import { JupiterPriceSource } from "./prices/jupiter-price-source.js";
import { MARKETS_PRICED_BY, NVDAX_MINT, SOL_MINT } from "./prices/mints.js";
import type { PriceSource } from "./prices/price-source.js";
import { NetworkMismatch } from "./rollup/connections.js";
import { MAINNET_WAKE_BACKOFF, waitFor } from "./scheduling/backoff.js";
import { type Repeating, every, idleWithin } from "./scheduling/repeating.js";
import { StartUp } from "./scheduling/start-up.js";
import { HedgeNotAvailable, type OpenedBots, openBots } from "./wiring/bots.js";
import { memoryWiring } from "./wiring/memory-wiring.js";
import { rollupWiring } from "./wiring/rollup-wiring.js";

const STATS_BROADCAST_INTERVAL_MS = 2_000;
const WAIT_FOR_LOOPS_ON_CLOSE_MS = 2_000;
/** A stop waits this long for the makers' quotes to come off the venue; they expire by themselves anyway. */
const WAIT_FOR_QUOTES_OFF_MS = 4_000;
const WAIT_FOR_HEDGE_READ_MS = 15_000;
/** Jupiter is not the rollup, but there is no reason to ask it for prices nobody is using. */
const ASLEEP_PRICE_POLL_INTERVAL_MS = 60_000;
/** A wake waits this long for the price source's answer before it publishes. */
const WAIT_FOR_FRESH_PRICE_MS = 6_000;

export interface RunningApp {
  server: FastifyInstance;
  port: number;
  /**
   * Resolves once the start-up work is done: the bots are open and funded.
   * Rejects only for a failure no wait will cure. A rollup that refuses or
   * is away is not one: the start-up work is retried, and the API answers meanwhile.
   */
  botsStarted: Promise<void>;
  close(): Promise<void>;
}

interface AppOverrides {
  priceSource?: PriceSource;
}

const latencyLabel = (config: Config): string | undefined =>
  config.VENUE === "rollup"
    ? `a bot's order, from its send to the result in its private view, measured from ${config.SERVICE_LOCATION}`
    : undefined;

/**
 * Wires the venue, the bots, the price source and the HTTP server, and starts them all.
 *
 * With VENUE=rollup the service is busy only while somebody wants it to be:
 * after its one-time start-up work it sleeps, sending nothing to the rollup,
 * until a request or a stream socket wakes it (see `Activity`). With
 * VENUE=memory nothing leaves the process, so it never sleeps. NETWORK=mainnet
 * never sleeps either: the maker is the only liquidity there.
 */
export const startApp = async (
  config: Config,
  overrides: AppOverrides = {},
): Promise<RunningApp> => {
  const data = {
    tape: new TapeStore(),
    candles: new CandleAggregator(),
    stats: new StatsTracker(config.STATS_LATENCY_WINDOW, latencyLabel(config)),
    hub: new Hub(),
  };
  const fundLedger = new FundLedger({
    perIpLimit: config.FUND_IP_RATE_LIMIT,
    perIpWindowMs: config.FUND_IP_RATE_WINDOW_MS,
    clock: systemClock,
  });

  const snapshotStore = new SnapshotStore(config.DATA_DIR);
  const snapshot = await snapshotStore.load();
  if (snapshot && isMainnet(config) && snapshot.network !== "mainnet") {
    throw new Error(
      `DATA_DIR (${config.DATA_DIR}) holds a snapshot saved on ${snapshot.network ?? "a test network"}, ` +
        "and its candles and order key positions are not mainnet's. Point DATA_DIR at an empty folder.",
    );
  }
  if (snapshot) {
    data.candles.loadSnapshot(snapshot.candles);
    fundLedger.loadSnapshot(snapshot.fundedAddresses);
    console.log(`sim-noirwire: loaded snapshot from ${new Date(snapshot.savedAtMs).toISOString()}`);
  }

  const problems = new ProblemLog((line) => console.error(line));
  const logError = (what: string, error: unknown): void => problems.failed(what, error);
  const logRecovered = (what: string): void => problems.recovered(what);

  const wiring =
    config.VENUE === "rollup"
      ? rollupWiring({
          config,
          data,
          snapshot,
          // Seats opened by anything else (a set-up's own test traders) sit among ours.
          usersEverOpened: () => fundLedger.grantCount + config.LIQUIDATOR_EXTRA_SEATS,
          onError: logError,
          onRecovered: logRecovered,
          onUnreachable: () => activity.unreachable(),
        })
      : memoryWiring(config, data);

  // A venue whose marks are not this service's to set (the rollup's are the program's) takes no prices.
  const acceptPricePoint = wiring.acceptPricePoint;
  const priceSource = !acceptPricePoint
    ? null
    : (overrides.priceSource ??
      new JupiterPriceSource({
        ids: [SOL_MINT, NVDAX_MINT],
        baseUrl: config.JUPITER_BASE_URL,
        pollIntervalMs: config.JUPITER_POLL_INTERVAL_MS,
        slowPollIntervalMs: ASLEEP_PRICE_POLL_INTERVAL_MS,
        onError: (error) => logError("polling Jupiter prices", error),
        onRecovered: () => logRecovered("polling Jupiter prices"),
      }));

  const saveSnapshot = (): Promise<void> =>
    snapshotStore.save({
      savedAtMs: Date.now(),
      network: config.NETWORK,
      candles: data.candles.exportSnapshot(),
      fundedAddresses: fundLedger.exportSnapshot(),
      ...wiring.snapshotExtras(),
    });

  /** Run for as long as the service lives, asleep or not: they send nothing to the rollup. */
  const loops: Repeating[] = [
    every(
      STATS_BROADCAST_INTERVAL_MS,
      () => data.hub.broadcastStats(data.stats.snapshot(Date.now())),
      (error) => logError("broadcasting stats", error),
      () => logRecovered("broadcasting stats"),
    ),
    every(
      config.SNAPSHOT_INTERVAL_MS,
      saveSnapshot,
      (error) => logError("saving the snapshot", error),
      () => logRecovered("saving the snapshot"),
    ),
  ];
  /** The bots' loops: run only while the service is awake. */
  let awakeLoops: Repeating[] = [];
  const stopAwakeLoops = async (): Promise<void> => {
    const running = awakeLoops;
    awakeLoops = [];
    for (const loop of running) loop.stop();
    // A bot's order still on its way moves its order keys on, so the loops get a moment to finish.
    await idleWithin(running, WAIT_FOR_LOOPS_ON_CLOSE_MS);
  };

  let closed = false;
  let closing: Promise<void> | null = null;
  let bots: OpenedBots | null = null;
  /** Loaded once: a start-up retry reuses the venue rather than loading the module again. */
  let hedgeVenue: HedgeVenue | undefined;

  /** Once the loops have stopped, the makers' quotes come off the venue: a stopped service leaves none standing. */
  const takeQuotesOff = async (): Promise<void> => {
    await Promise.race([bots?.withdrawQuotes(), waitFor(WAIT_FOR_QUOTES_OFF_MS)]);
  };

  const startUp = new StartUp({
    backoff: isMainnet(config) ? MAINNET_WAKE_BACKOFF : undefined,
    work: async () => {
      await wiring.prepare();
      hedgeVenue ??= await hedgeVenueFor(config);
      bots = await openBots(
        config,
        wiring,
        {
          onError: logError,
          onRecovered: logRecovered,
        },
        hedgeVenue,
      );
    },
    wanted: () => activity.wanted(),
    cleanup: () => wiring.rest(),
    isFatal: (error) =>
      error instanceof NetworkMismatch ||
      error instanceof HedgeNotAvailable ||
      error instanceof HedgeVenueLoadError,
    onFailure: (error, failures, retryInMs) =>
      console.error(
        `sim-noirwire: start-up failed (try ${failures}), trying again in ${Math.round(retryInMs / 1_000)} s: ${firstLine(error)}`,
      ),
  });

  const lifecycle: Lifecycle = {
    wake: async () => {
      await startUp.attemptEnded();
      if (!startUp.ready || closed || !bots) {
        throw new Error(startUp.problem ?? "the service has not finished starting");
      }
      try {
        if (priceSource) {
          priceSource.setPace("fast");
          // The bots quote on a price the source delivered during this wake, not one cached before it.
          const delivered = await Promise.race([
            priceSource.pollNow(),
            waitFor(WAIT_FOR_FRESH_PRICE_MS).then(() => false),
          ]);
          if (!delivered) throw new Error("the price source did not deliver prices");
        }
        await wiring.resume();
      } catch (error) {
        // A wake that failed must not leave a feed running while it waits to try again.
        await wiring.rest();
        throw error;
      }
      if (!closed && awakeLoops.length === 0) awakeLoops = bots.start();
      console.log("sim-noirwire: awake");
    },
    sleep: async () => {
      await stopAwakeLoops();
      await takeQuotesOff();
      // Nothing reads the hedge while asleep, so the asleep health answer rests on this last look.
      await Promise.race([bots?.confirmHedgesBeforeSleep(), waitFor(WAIT_FOR_HEDGE_READ_MS)]);
      priceSource?.setPace("slow");
      await wiring.rest();
      console.log(
        "sim-noirwire: asleep, sending nothing to the rollup until a request or a stream socket wakes it",
      );
    },
  };
  const activity = new Activity({
    lifecycle,
    idleAfterMs: config.IDLE_AFTER_MS,
    idleAfterLastSocketMs: config.IDLE_AFTER_LAST_SOCKET_MS,
    onError: logError,
    wakeBackoff: isMainnet(config) ? MAINNET_WAKE_BACKOFF : undefined,
    onDemand: () => startUp.demand(),
  });

  // The start-up work runs while the API is already answering.
  startUp.start();
  const botsStarted = startUp.finished;
  botsStarted.catch((error) => logError("the bots did not start", error));
  botsStarted.then(
    () => {
      if (config.VENUE === "rollup") activity.settle();
    },
    () => {},
  );
  // On mainnet the maker is the only liquidity, so it quotes whether or not anybody is watching.
  if (config.VENUE === "memory" || isMainnet(config)) activity.holdAwake();

  const server = await buildServer({
    config,
    venue: wiring.venue,
    ...data,
    problems: { onError: logError, onRecovered: logRecovered },
    fundLedger,
    ...wiring.rollupRoutes,
    activity,
    startUp: config.VENUE === "rollup" ? startUp : undefined,
    trading: () => bots?.trading() ?? { ready: false, reason: "the bots are not open yet" },
    tradingWhileAsleep: () =>
      bots?.tradingWhileAsleep() ??
      (config.HEDGE_ENABLED
        ? { ready: false, reason: "the hedge has not been read since the service started" }
        : { ready: true }),
  });
  await server.listen({ port: config.PORT, host: config.HOST });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : config.PORT;
  console.log(`sim-noirwire: listening on http://${config.HOST}:${port} (venue=${config.VENUE})`);
  if (isMainnet(config)) {
    console.log(
      "sim-noirwire: mainnet mode: running the house maker, the gate and the market data only",
    );
    if (config.GATE_OPEN) {
      console.log("sim-noirwire: the gate is open: any owner key may open an account");
    }
  }

  priceSource?.start((point) => {
    for (const market of MARKETS_PRICED_BY[point.id] ?? []) {
      acceptPricePoint?.(market, point.price, point.atMs);
    }
  });

  return {
    server,
    port,
    botsStarted,
    close: () => {
      closing ??= (async () => {
        closed = true;
        startUp.stop();
        activity.close();
        for (const loop of loops) loop.stop();
        priceSource?.stop();
        // A stop must not depend on the network: a run still going after a
        // moment is abandoned, and a restart finds keys that moved past their
        // checkpoint by search.
        await Promise.all([idleWithin(loops, WAIT_FOR_LOOPS_ON_CLOSE_MS), stopAwakeLoops()]);
        await takeQuotesOff();
        await wiring.stop();
        await saveSnapshot();
        await server.close();
      })();
      return closing;
    },
  };
};
