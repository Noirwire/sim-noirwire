import { startApp } from "./app.js";
import { loadConfig } from "./config/config.js";

/** A stop that is still waiting on something after this long exits anyway. */
const STOP_WITHIN_MS = 10_000;

const main = async (): Promise<void> => {
  const running = await startApp(loadConfig());

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
};

main().catch((error) => {
  console.error("sim-noirwire: did not start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
