export interface Backoff {
  /** The wait after the first failure. */
  baseMs: number;
  /** No wait grows past this. */
  maxMs: number;
}

/** What every retry of work against the rollup waits between tries: 5 s, doubling, up to 5 minutes. */
export const ROLLUP_BACKOFF: Backoff = { baseMs: 5_000, maxMs: 300_000 };

/** What a wake on mainnet waits between tries: the house maker is the only liquidity, so it comes back within 30 s of the rollup. */
export const MAINNET_WAKE_BACKOFF: Backoff = { baseMs: 5_000, maxMs: 30_000 };

/** Waits `ms` without keeping the process alive. */
export const waitFor = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/** The wait after the `failures`-th failure in a row (1 for the first). */
export const backoffDelayMs = (
  failures: number,
  { baseMs, maxMs }: Backoff = ROLLUP_BACKOFF,
): number => Math.min(baseMs * 2 ** Math.max(0, failures - 1), maxMs);

export interface RetryOptions {
  /** How long each wait is; `ROLLUP_BACKOFF` when absent. */
  backoff?: Backoff;
  /** Asked before each try and after each wait: false ends the retrying. */
  keepTrying(): boolean;
  /** Called after each failure, with how long the next try waits. */
  onFailure(error: unknown, failures: number, retryInMs: number): void;
}

/**
 * Runs `work` until it succeeds, waiting longer after each failure. Resolves
 * true once it has succeeded and false when `keepTrying` ended the retrying
 * first.
 */
export const retryWithBackoff = async (
  work: () => Promise<void>,
  options: RetryOptions,
): Promise<boolean> => {
  for (let failures = 1; options.keepTrying(); failures += 1) {
    try {
      await work();
      return true;
    } catch (error) {
      const retryInMs = backoffDelayMs(failures, options.backoff);
      options.onFailure(error, failures, retryInMs);
      await waitFor(retryInMs);
    }
  }
  return false;
};
