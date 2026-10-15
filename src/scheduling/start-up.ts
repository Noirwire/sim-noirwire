import { firstLine } from "../logging/first-line.js";
import { backoffDelayMs, waitFor } from "./backoff.js";

export interface StartUpOptions {
  /** The one-time work. Every step of it is safe to run again after a failure. */
  work(): Promise<void>;
  /** A failure that is thrown, ending the start-up, instead of retried. */
  isFatal?(error: unknown): boolean;
  /** Whether anybody wants the service to be busy: a retry waits for it. */
  wanted(): boolean;
  /** Stops whatever a failed try opened, before anything waits for the next one. */
  cleanup(): Promise<void>;
  onFailure(error: unknown, failures: number, retryInMs: number): void;
}

/**
 * The work a service has to do once before it is useful. It is tried once as
 * soon as it starts. After a failure it is tried again with a growing wait,
 * but only while somebody wants the service to be busy: with nobody around a
 * refusing host is left alone until `demand` is called. The service does not
 * wait for it: it answers requests meanwhile, and `problem` says why the
 * work is not done.
 */
export class StartUp {
  private done = false;
  private lastProblem: string | null = null;
  private stopped = false;
  private attempt: Promise<void> = Promise.resolve();
  private resumeOnDemand: (() => void) | null = null;
  /** Resolves when the work is done or stopped; rejects on a fatal failure. */
  finished: Promise<void> = Promise.resolve();

  constructor(private readonly options: StartUpOptions) {}

  get ready(): boolean {
    return this.done;
  }

  /** Why the work is not done yet, or null while it has not failed. */
  get problem(): string | null {
    return this.done ? null : this.lastProblem;
  }

  start(): void {
    this.finished = this.run();
  }

  /** Resolves when the try in progress, if any, has ended. */
  attemptEnded(): Promise<void> {
    return this.attempt;
  }

  /** Somebody wants the service to be busy: a retry that was waiting for that goes ahead. */
  demand(): void {
    const resume = this.resumeOnDemand;
    this.resumeOnDemand = null;
    resume?.();
  }

  stop(): void {
    this.stopped = true;
    this.demand();
  }

  private async run(): Promise<void> {
    for (let failures = 1; !this.stopped; failures += 1) {
      const outcome = this.options.work().then(
        () => null,
        (error: unknown) => ({ error }),
      );
      const cleanedUp = outcome.then(async (result) => {
        if (result) await this.options.cleanup().catch(() => {});
        return result;
      });
      this.attempt = cleanedUp.then(() => {});
      const failed = await cleanedUp;
      if (!failed) {
        this.done = true;
        return;
      }
      if (this.options.isFatal?.(failed.error)) throw failed.error;
      const retryInMs = backoffDelayMs(failures);
      const { error } = failed;
      this.lastProblem = firstLine(error);
      this.options.onFailure(error, failures, retryInMs);
      await waitFor(retryInMs);
      while (!this.stopped && !this.options.wanted()) {
        await new Promise<void>((resolve) => (this.resumeOnDemand = resolve));
      }
    }
  }
}
