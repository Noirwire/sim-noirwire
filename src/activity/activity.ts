import { firstLine } from "../logging/first-line.js";
import { retryWithBackoff } from "../scheduling/backoff.js";

/**
 * "asleep": nothing is sent to the rollup. "waking": a request or a socket
 * asked for activity and the loops are not running yet. "awake": they run.
 */
export type ActivityPhase = "asleep" | "waking" | "awake";

/** What the service does when it is wanted and when it is not. Both are safe to repeat. */
export interface Lifecycle {
  /** Starts everything that talks to the rollup. Throws when the rollup cannot be reached. */
  wake(): Promise<void>;
  /** Stops all of it. Sends nothing. */
  sleep(): Promise<void>;
}

export interface ActivityOptions {
  lifecycle: Lifecycle;
  /** How long after the last request the service stays awake when no socket was open. */
  idleAfterMs: number;
  /** How long after the last socket closes the service stays awake: long enough for a page reload. */
  idleAfterLastSocketMs: number;
  onError(what: string, error: unknown): void;
  /** Called on every request or socket that asks for activity, awake or not. */
  onDemand?(): void;
}

/**
 * Whether anybody wants the service to be busy. A request to the public API
 * (not the health probe) or an open stream socket makes it wake. It sleeps
 * again once no socket is open and `idleAfterMs` has passed since the last
 * request. When the last socket closes, the page that held it is gone, so
 * only `idleAfterLastSocketMs` is left from then, whatever requests came
 * before; a request after that counts in full again. Waking is not waited for by whatever
 * woke it: `phase` reads "waking" until the lifecycle has finished. A wake
 * that fails is tried again with a growing wait for as long as it is wanted.
 */
export class Activity {
  private current: ActivityPhase = "asleep";
  private openSockets = 0;
  private wantedUntilMs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;
  private closed = false;
  /** A wake is queued and has not begun, so the phase is not for a sleep to settle. */
  private wakePending = false;
  /** Wakes and sleeps run one after the other, never over each other. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: ActivityOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get phase(): ActivityPhase {
    return this.current;
  }

  /** True from the moment something asked for activity until the service sleeps again. */
  get awake(): boolean {
    return this.current !== "asleep";
  }

  /** True while a wake is under way. */
  get waking(): boolean {
    return this.current === "waking";
  }

  /** Why the last try to wake failed, or null. */
  get wakeFailure(): string | null {
    return this.failure;
  }

  /** A request that is a reason to be awake. */
  touch(): void {
    if (this.closed) return;
    this.wantedUntilMs = Math.max(this.wantedUntilMs, this.now() + this.options.idleAfterMs);
    this.options.onDemand?.();
    if (this.current === "asleep") this.startWaking();
    else this.armIdleTimer();
  }

  /** A stream socket opened. The returned function is called once, when it closes. */
  socketOpened(): () => void {
    this.openSockets += 1;
    this.touch();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.openSockets -= 1;
      if (this.openSockets === 0)
        this.wantedUntilMs = this.now() + this.options.idleAfterLastSocketMs;
      this.armIdleTimer();
    };
  }

  /**
   * The rollup stopped answering an awake service. It rests as if it were
   * idle and, while it is still wanted, wakes again with the wake's own
   * growing wait, one probe at a time.
   */
  unreachable(): void {
    if (this.closed || this.current !== "awake") return;
    this.enqueue(() => this.runSleep());
  }

  /** Never sleeps again: for a service whose venue costs nothing to keep busy. */
  holdAwake(): void {
    this.socketOpened();
  }

  /** Puts a service that has done its one-time start-up work to sleep, unless something woke it meanwhile. */
  settle(): void {
    if (this.closed || this.current !== "asleep") return;
    this.enqueue(() => this.runSleep());
  }

  /** Ends the idle timer and any wake still being retried. Does not wait for work under way. */
  close(): void {
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Whether a socket is open or the idle time has not run out. */
  wanted(): boolean {
    if (this.closed) return false;
    return this.openSockets > 0 || this.now() < this.wantedUntilMs;
  }

  private enqueue(step: () => Promise<void>): void {
    this.queue = this.queue.then(step);
  }

  private startWaking(): void {
    this.current = "waking";
    this.wakePending = true;
    this.enqueue(() => this.runWake());
  }

  private async runWake(): Promise<void> {
    const { lifecycle, onError } = this.options;
    this.wakePending = false;
    const done = await retryWithBackoff(() => lifecycle.wake(), {
      keepTrying: () => this.wanted(),
      onFailure: (error) => {
        this.failure = firstLine(error);
        onError("waking the service", error);
      },
    });
    if (done) {
      this.failure = null;
      this.current = "awake";
      this.armIdleTimer();
      return;
    }
    await this.runSleep();
  }

  private async runSleep(): Promise<void> {
    this.failure = null;
    try {
      await this.options.lifecycle.sleep();
    } catch (error) {
      this.options.onError("putting the service to sleep", error);
    }
    // Something may have asked for activity while the sleep was running.
    if (this.wakePending) return;
    this.current = "asleep";
    if (this.wanted()) this.startWaking();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.closed || this.current !== "awake" || this.openSockets > 0) return;
    const remainingMs = this.wantedUntilMs - this.now();
    this.idleTimer = setTimeout(() => this.idleTimerFired(), Math.max(0, remainingMs));
    this.idleTimer.unref();
  }

  private idleTimerFired(): void {
    this.idleTimer = null;
    if (this.current !== "awake") return;
    if (this.wanted()) {
      this.armIdleTimer();
      return;
    }
    this.enqueue(() => this.sleepIfStillIdle());
  }

  /** A socket or request may have come in between the idle timer firing and its sleep's turn. */
  private async sleepIfStillIdle(): Promise<void> {
    if (this.current !== "awake") return;
    if (this.wanted()) {
      this.armIdleTimer();
      return;
    }
    await this.runSleep();
  }
}
