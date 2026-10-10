export interface Repeating {
  stop(): void;
  /** Resolves once the run in flight, if any, has ended. */
  idle(): Promise<void>;
}

/**
 * Runs `work` every `intervalMs`. A run that is still going when the next
 * one is due is skipped over, not stacked, and a run that fails is handed to
 * `onFailure` and tried again on the next turn. Each run is expected to bound
 * its own requests in time: this only guarantees that one slow or failed run
 * costs a turn and nothing more.
 */
export const every = (
  intervalMs: number,
  work: () => unknown,
  onFailure: (error: unknown) => void,
): Repeating => {
  let running: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    try {
      await work();
    } catch (error) {
      onFailure(error);
    }
  };
  const timer = setInterval(() => {
    if (running) return;
    running = run().finally(() => {
      running = null;
    });
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
    idle: () => running ?? Promise.resolve(),
  };
};

/**
 * Resolves once every loop's run in flight has ended, or after `withinMs`,
 * whichever is first: a run that is still going by then is abandoned.
 */
export const idleWithin = (loops: Repeating[], withinMs: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, withinMs);
    void Promise.allSettled(loops.map((loop) => loop.idle())).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
