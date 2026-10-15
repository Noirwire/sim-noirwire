import { firstLine } from "./first-line.js";

/** Longer than a run's failure line is worth repeating: one summary per failing thing per this long. */
const SUMMARY_EVERY_MS = 60_000;

interface Failing {
  since: number;
  failures: number;
  failuresSinceSummary: number;
  lastSummaryAt: number;
}

/**
 * Logs a thing that keeps failing as a state change, not as a line per
 * failure: one line when it starts failing, one summary a minute while it
 * goes on, and one when it works again. Whatever is passed with no error is
 * an event, not a failure, and is logged as it comes.
 */
export class ProblemLog {
  private readonly failing = new Map<string, Failing>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  failed(what: string, error: unknown): void {
    if (error === null || error === undefined) {
      this.write(`sim-noirwire: ${what}`);
      return;
    }
    const now = this.now();
    const state = this.failing.get(what);
    if (!state) {
      this.failing.set(what, {
        since: now,
        failures: 1,
        failuresSinceSummary: 0,
        lastSummaryAt: now,
      });
      this.write(`sim-noirwire: ${what} failing: ${firstLine(error)}`);
      return;
    }
    state.failures += 1;
    state.failuresSinceSummary += 1;
    if (now - state.lastSummaryAt < SUMMARY_EVERY_MS) return;
    this.write(
      `sim-noirwire: ${what} still failing, ${state.failuresSinceSummary} more failures in the last ` +
        `${Math.round((now - state.lastSummaryAt) / 1_000)} s ` +
        `(${state.failures} since ${new Date(state.since).toISOString()}): ${firstLine(error)}`,
    );
    state.failuresSinceSummary = 0;
    state.lastSummaryAt = now;
  }

  recovered(what: string): void {
    const state = this.failing.get(what);
    if (!state) return;
    this.failing.delete(what);
    this.write(`sim-noirwire: ${what} works again after ${state.failures} failures`);
  }
}
