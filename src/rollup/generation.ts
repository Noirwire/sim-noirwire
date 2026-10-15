/**
 * One stretch of the service being awake. Everything that sends to the rollup
 * during it, a connection, a bot's client, a confirmation loop, is made for
 * one generation, and the generation ends when the service goes to sleep:
 * from then on whatever belongs to it refuses to send. A wake starts a new
 * generation and builds what it needs afresh, so nothing is resumed that was
 * left half done.
 */
export class Generation {
  private readonly controller = new AbortController();

  /** Aborts when the generation ends. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get ended(): boolean {
    return this.controller.signal.aborted;
  }

  end(): void {
    this.controller.abort(new Error("the service went to sleep"));
  }

  /** `work`, or a rejection the moment the generation ends, whichever comes first. */
  until<T>(work: Promise<T>): Promise<T> {
    const { signal } = this.controller;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const stop = (): void => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
      work.finally(() => signal.removeEventListener("abort", stop)).then(resolve, reject);
    });
  }
}
