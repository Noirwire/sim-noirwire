import { startApp } from "./app.js";
import type { Config } from "./config/config.js";

/** A stop that is still waiting on something after this long exits anyway. */
const STOP_WITHIN_MS = 10_000;

/**
 * Starts the service for `config`, stops it on SIGINT or SIGTERM, and exits non-zero when it cannot
 * start. Every entry point (the combined service and each role on its own) ends here; they differ
 * only in the settings they load.
 */
export const run = async (load: () => Config): Promise<void> => {
  try {
    const running = await startApp(load());

    running.botsStarted.catch(() => process.exit(1));

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`sim-noirwire: ${signal} received, shutting down`);
      setTimeout(() => process.exit(1), STOP_WITHIN_MS).unref();
      await running.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (error) {
    console.error("sim-noirwire: did not start:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
};
