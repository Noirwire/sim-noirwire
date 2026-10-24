import type { Clock } from "../engine/clock.js";

type Seen = { at: "none" } | { at: "ts"; ms: number } | { at: "problem"; reason: string };

const DIGITS = /^\d+$/;

/** The problem before the first read: normal for a moment after a start or a wake, so it is not worth an alert. */
export const KEEPER_NOT_READ_YET = "keeper heartbeat has not been read yet";

/**
 * What the liquidation keeper, which runs outside this process, last said about itself: the Unix
 * time in ms of its last healthy sweep, as decimal text in a file. `poll` reads the file and never
 * throws; `problem` is a plain, synchronous answer from what the last poll saw, so trading readiness
 * stays a function of cached state. The age is worked out at each `problem` call, so a poll loop
 * that dies shows up as a stale heartbeat rather than a frozen "fresh" one.
 */
export class KeeperHeartbeat {
  private seen: Seen = { at: "none" };

  constructor(
    /** What the file holds, or an error when it cannot be read in time. Undefined: no keeper input. */
    private readonly read: (() => Promise<string>) | undefined,
    /** With no file configured: fail closed (mainnet) or stay out of the way. */
    private readonly required: boolean,
    private readonly maxAgeMs: number,
    private readonly clock: Clock,
  ) {}

  /** Forget what was read, so nothing is ready before a read has said it is. */
  reset(): void {
    this.seen = { at: "none" };
  }

  async poll(): Promise<void> {
    if (!this.read) return;
    let text: string;
    try {
      text = await this.read();
    } catch {
      this.seen = { at: "problem", reason: "keeper heartbeat unreadable" };
      return;
    }
    const trimmed = text.trim();
    const ms = DIGITS.test(trimmed) ? Number(trimmed) : NaN;
    this.seen = Number.isSafeInteger(ms)
      ? { at: "ts", ms }
      : { at: "problem", reason: "keeper heartbeat is malformed" };
  }

  /** Why the keeper counts as not running, or undefined when it is fine or not part of this deployment. */
  problem(): string | undefined {
    if (!this.read) return this.required ? "keeper heartbeat is not configured" : undefined;
    if (this.seen.at === "none") return KEEPER_NOT_READ_YET;
    if (this.seen.at === "problem") return this.seen.reason;
    const age = this.clock.nowMs() - this.seen.ms;
    if (age < -this.maxAgeMs) return "keeper heartbeat is malformed";
    if (age > this.maxAgeMs) {
      return `keeper has not completed a healthy sweep for ${Math.floor(age / 1000)}s`;
    }
    return undefined;
  }
}
