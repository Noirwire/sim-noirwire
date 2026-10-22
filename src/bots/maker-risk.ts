import type { Clock } from "../engine/clock.js";
import { toDecimalString } from "../engine/money.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import type { ControlCommand } from "./maker-control.js";
import type { MakerLedger, MakerMode, MakerState } from "./maker-state.js";

/** How the maker tells an operator: an alert is a latch that needs a human, a notice is news. */
export interface MakerVoice {
  alert(message: string): void;
  notice(message: string): void;
}

const BPS = 10_000n;
const KILL_SWITCH_HINT =
  'When the market is checked, run the kill switch with "resume" to start again.';

const nusd = (scaled: bigint): string => toDecimalString(scaled).slice(0, -4);

const utcDay = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** What the maker has lost against its limits, in words, or null while it is inside them. */
const breachOf = (equity: bigint, state: MakerState): string | null => {
  const { dayStartEquity: start, peakEquity: peak } = state;
  if (
    start !== null &&
    start > 0n &&
    (start - equity) * BPS >= start * BigInt(MAKER_LIMITS.dailyLossBps)
  ) {
    return `it lost ${nusd(start - equity)} nUSD today, ${MAKER_LIMITS.dailyLossBps / 100}% of the ${nusd(start)} it started the UTC day with`;
  }
  if (
    peak !== null &&
    peak > 0n &&
    (peak - equity) * BPS >= peak * BigInt(MAKER_LIMITS.drawdownBps)
  ) {
    return `it is ${nusd(peak - equity)} nUSD below its peak of ${nusd(peak)}, ${MAKER_LIMITS.drawdownBps / 100}% or more`;
  }
  return null;
};

/**
 * The maker's mode and its loss limits. Losing 3% of the day's starting
 * equity, or 5% from the peak, stops it growing: it keeps quoting only the
 * side that shrinks its position. The kill switch does the same, or stops it
 * altogether. All of it is kept on disk and ends only when an operator
 * resumes it, so a restart does not forgive a loss.
 */
export class MakerRisk {
  constructor(
    private readonly ledger: MakerLedger,
    private readonly clock: Clock,
    private readonly market: string,
    private readonly voice: MakerVoice,
  ) {}

  get mode(): MakerMode {
    return this.ledger.state.mode;
  }

  /** Follows the operator's newest command, once. */
  async follow(command: ControlCommand | null, equity: bigint): Promise<void> {
    if (!command || command.requestedAtMs <= this.ledger.state.lastCommandAtMs) return;
    if (command.mode === "run") {
      const today = utcDay(this.clock.nowMs());
      const funded = equity > 0n ? equity : null;
      await this.ledger.update({
        mode: "run",
        reason: null,
        day: today,
        dayStartEquity: funded,
        peakEquity: funded,
        lastCommandAtMs: command.requestedAtMs,
      });
      this.voice.notice(
        `${this.market} maker resumed by the kill switch; its loss limits now count from here`,
      );
      return;
    }
    const reason =
      command.mode === "stopped"
        ? "the kill switch stopped it"
        : "the kill switch stopped its growth";
    await this.ledger.update({
      mode: command.mode,
      reason,
      lastCommandAtMs: command.requestedAtMs,
    });
    this.voice.alert(`ALERT ${this.market} maker: ${reason}. ${KILL_SWITCH_HINT}`);
  }

  /** Counts the day's loss and the drawdown against the limits. Past one, the maker stops growing. */
  async check(equity: bigint): Promise<void> {
    const today = utcDay(this.clock.nowMs());
    const before = this.ledger.state;
    const change: Partial<MakerState> = {};
    if (before.day !== today && equity > 0n) {
      change.day = today;
      change.dayStartEquity = equity;
    }
    if (equity > (before.peakEquity ?? 0n)) change.peakEquity = equity;
    const breach = before.mode === "run" ? breachOf(equity, { ...before, ...change }) : null;
    if (breach) {
      change.mode = "reduce";
      change.reason = breach;
    }
    if (Object.keys(change).length === 0) return;
    try {
      await this.ledger.update(change);
    } finally {
      if (breach) {
        this.voice.alert(
          `ALERT ${this.market} maker: ${breach}. It stops growing its position and quotes only the side ` +
            `that shrinks it. ${KILL_SWITCH_HINT}`,
        );
      }
    }
  }

  /** The maker met something it does not understand: it stops quoting and stays stopped. */
  async stopFor(reason: string): Promise<void> {
    try {
      await this.ledger.update({ mode: "stopped", reason });
    } finally {
      this.voice.alert(
        `ALERT ${this.market} maker: it met a problem it does not understand and has stopped quoting (${reason}). ` +
          `Read the log above this line. ${KILL_SWITCH_HINT}`,
      );
    }
  }
}
