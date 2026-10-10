import type { FastifyInstance } from "fastify";
import type { Config } from "./config/config.js";
import { CandleAggregator } from "./data/candles.js";
import { FundLedger } from "./data/fund-ledger.js";
import { SnapshotStore } from "./data/snapshot.js";
import { StatsTracker } from "./data/stats.js";
import { TapeStore } from "./data/tape-store.js";
import { systemClock } from "./engine/clock.js";
import { Hub } from "./http/hub.js";
import { buildServer } from "./http/server.js";
import { JupiterPriceSource } from "./prices/jupiter-price-source.js";
import { MARKETS_PRICED_BY, NVDAX_MINT, SOL_MINT } from "./prices/mints.js";
import type { PriceSource } from "./prices/price-source.js";
import { type Repeating, every } from "./scheduling/repeating.js";
import { startBots } from "./wiring/bots.js";
import { memoryWiring } from "./wiring/memory-wiring.js";
import { rollupWiring } from "./wiring/rollup-wiring.js";

const STATS_BROADCAST_INTERVAL_MS = 2_000;
const WAIT_FOR_LOOPS_ON_CLOSE_MS = 10_000;

export interface RunningApp {
  server: FastifyInstance;
  port: number;
  /** Resolves once the bots are open and funded and their loops run. */
  botsStarted: Promise<void>;
  close(): Promise<void>;
}

interface AppOverrides {
  priceSource?: PriceSource;
}

const logError = (what: string, error: unknown): void => {
  const detail = error instanceof Error ? error.message.split("\n")[0] : (error ?? "");
  console.error(`sim-noirwire: ${what}`, detail);
};

const latencyLabel = (config: Config): string | undefined =>
  config.VENUE === "rollup"
    ? `a bot's order, from its send to the result in its private view, measured from ${config.SERVICE_LOCATION}`
    : undefined;

/** Wires the venue, the bots, the price source and the HTTP server, and starts them all. */
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
  if (snapshot) {
    data.candles.loadSnapshot(snapshot.candles);
    fundLedger.loadSnapshot(snapshot.fundedAddresses);
    console.log(`sim-noirwire: loaded snapshot from ${new Date(snapshot.savedAtMs).toISOString()}`);
  }

  const wiring =
    config.VENUE === "rollup"
      ? await rollupWiring({
          config,
          data,
          snapshot,
          // Seats opened by anything else (a set-up's own test traders) sit among ours.
          usersEverOpened: () => fundLedger.grantCount + config.LIQUIDATOR_EXTRA_SEATS,
          onError: logError,
        })
      : memoryWiring(config, data);

  const server = await buildServer({
    config,
    venue: wiring.venue,
    ...data,
    fundLedger,
    ...wiring.rollupRoutes,
  });
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
    for (const market of MARKETS_PRICED_BY[point.id] ?? []) {
      wiring.acceptPricePoint(market, point.price, point.atMs);
    }
  });

  const saveSnapshot = (): Promise<void> =>
    snapshotStore.save({
      savedAtMs: Date.now(),
      candles: data.candles.exportSnapshot(),
      fundedAddresses: fundLedger.exportSnapshot(),
      ...wiring.snapshotExtras(),
    });

  const loops: Repeating[] = [
    every(
      STATS_BROADCAST_INTERVAL_MS,
      () => data.hub.broadcastStats(data.stats.snapshot(Date.now())),
      (error) => logError("stats broadcast failed", error),
    ),
    every(config.SNAPSHOT_INTERVAL_MS, saveSnapshot, (error) => logError("snapshot failed", error)),
  ];
  const stopLoops = (): void => loops.forEach((loop) => loop.stop());

  let closed = false;
  const botsStarted = startBots(config, wiring, logError).then((botLoops) => {
    loops.push(...botLoops);
    if (closed) stopLoops();
  });
  botsStarted.catch((error) => logError("the bots did not start", error));

  return {
    server,
    port,
    botsStarted,
    close: async () => {
      closed = true;
      stopLoops();
      priceSource.stop();
      // Invariant: a bot's order still on its way moves its order keys on, so
      // the snapshot is taken once every loop has finished and the checkpoints
      // are final. The wait is bounded: a stop must not depend on the network.
      await Promise.race([
        Promise.allSettled(loops.map((loop) => loop.idle())),
        new Promise((resolve) => setTimeout(resolve, WAIT_FOR_LOOPS_ON_CLOSE_MS)),
      ]);
      await wiring.stop();
      await saveSnapshot();
      await server.close();
    },
  };
};
