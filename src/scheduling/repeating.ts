import { firstLine } from "../logging/first-line.js";
import { type Backoff, backoffDelayMs } from "./backoff.js";

export interface Repeating {
  stop(): void;
  /** Resolves once the run in flight, if any, has ended. */
  idle(): Promise<void>;
}

/** However often a loop has failed in a row, it tries again within this long. */
const LONGEST_PAUSE_AFTER_FAILURES_MS = 30_000;
/** A loop that has failed waits at least this long, however short its interval. */
const SHORTEST_PAUSE_AFTER_FAILURE_MS = 5_000;

/**
 * Runs `work` every `intervalMs`. A run that is still going when the next
 * one is due is skipped over, not stacked, and a run that fails is handed to
 * `onFailure`. After a failure the loop pauses for at least 5 seconds, and
 * each further failure in a row doubles the pause, up to 30 seconds (a loop
 * with a longer interval keeps its own), so a refusing endpoint is not asked
 * at full pace. A run that succeeds is handed to `onSuccess` and ends the
 * pause. A loop that cannot afford to wait passes `pauseAfterFailure: false`
 * and tries again on the next turn. Each run is expected to bound its own
 * requests in time: this only guarantees that one slow or failed run costs a
 * turn and nothing more.
 */
export const every = (
  intervalMs: number,
  work: () => unknown,
  onFailure: (error: unknown) => void,
  onSuccess: () => void = () => {},
  { pauseAfterFailure = true }: { pauseAfterFailure?: boolean } = {},
): Repeating => {
  let running: Promise<void> | null = null;
  let stopped = false;
  let failuresInARow = 0;
  let turnsToSkip = 0;
  const pauses: Backoff = {
    baseMs: Math.max(SHORTEST_PAUSE_AFTER_FAILURE_MS, intervalMs),
    maxMs: Math.max(LONGEST_PAUSE_AFTER_FAILURES_MS, intervalMs),
  };
  const run = async (): Promise<void> => {
    try {
      await work();
      failuresInARow = 0;
      onSuccess();
    } catch (error) {
      // A run that was cut short by the stop is not a failure to report.
      if (stopped) return;
      failuresInARow += 1;
      const pauseMs = backoffDelayMs(failuresInARow, pauses);
      turnsToSkip = pauseAfterFailure ? Math.max(0, Math.ceil(pauseMs / intervalMs) - 1) : 0;
      onFailure(error);
    }
  };
  const timer = setInterval(() => {
    if (running) return;
    if (turnsToSkip > 0) {
      turnsToSkip -= 1;
      return;
    }
    // A handler that throws is logged and ends the run: it must never become an unhandled rejection.
    running = run()
      .catch((error: unknown) => {
        process.stderr.write(
          `sim-noirwire: a repeating loop's handler threw: ${firstLine(error)}\n`,
        );
      })
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    idle: () => running ?? Promise.resolve(),
  };
};

/**
 * Resolves once every run in flight has ended, or after `withinMs`,
 * whichever is first: a run that is still going by then is abandoned.
 */
export const idleWithin = (loops: Pick<Repeating, "idle">[], withinMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, withinMs);
    void Promise.allSettled(loops.map((loop) => loop.idle())).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
