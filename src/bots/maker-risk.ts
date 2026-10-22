import type { Clock } from "../engine/clock.js";
import { toDecimalString } from "../engine/money.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import { type ControlCommand, STOP_STRANDS_USERS } from "./maker-control.js";
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

/** What the maker has lost against a pair of limits, in words, or null while it is inside them. */
const breachOf = (
  equity: bigint,
  state: MakerState,
  dailyLossBps: number,
  drawdownBps: number,
): string | null => {
  const { dayStartEquity: start, peakEquity: peak } = state;
  if (start !== null && start > 0n && (start - equity) * BPS >= start * BigInt(dailyLossBps)) {
    return `it lost ${nusd(start - equity)} nUSD today, ${dailyLossBps / 100}% of the ${nusd(start)} it started the UTC day with`;
  }
  if (peak !== null && peak > 0n && (peak - equity) * BPS >= peak * BigInt(drawdownBps)) {
    return `it is ${nusd(peak - equity)} nUSD below its peak of ${nusd(peak)}, ${drawdownBps / 100}% or more`;
  }
  return null;
};

interface Verdict {
  change: Partial<MakerState>;
  alert: string;
}

/**
 * The maker's mode and its loss limits.
 *
 * Losing 3% of the day's starting equity, or 5% from the peak, makes it
 * flatten: it stops growing and works its position down to flat with
 * reduce-only orders around the reference price. If that goes on past the
 * second limit (6% and 10%), or the position is still there after ten
 * minutes, or an order fails, it stops quoting altogether, which leaves users
 * unable to close against it.
 *
 * The kill switch's soft stop ("reduce") only stops it growing: it keeps
 * quoting the side that shrinks its position, so users can still close. Its
 * hard stop ("stopped") cancels everything. An error it does not understand
 * falls back to the soft stop, and to the hard stop only if it happens again
 * while the maker is already reducing.
 *
 * All of it is kept on disk and ends only when an operator resumes it, so a
 * restart does not forgive a loss.
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
        flattenStartedAtMs: null,
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
    const hard = command.mode === "stopped";
    const reason = hard ? "the kill switch stopped it" : "the kill switch stopped its growth";
    await this.ledger.update({
      mode: command.mode,
      reason,
      flattenStartedAtMs: null,
      lastCommandAtMs: command.requestedAtMs,
    });
    const consequence = hard
      ? STOP_STRANDS_USERS
      : "It keeps quoting the side that shrinks its position, so users can still close.";
    this.voice.alert(`ALERT ${this.market} maker: ${reason}. ${consequence} ${KILL_SWITCH_HINT}`);
  }

  /**
   * Counts the day's loss and the drawdown against the limits, at `equity`
   * (the worse of the venue's mark and the reference price). A first breach
   * starts the flattening; a second, wider one, or a flattening that is not
   * working, stops the maker.
   */
  async check(equity: bigint, position: bigint): Promise<void> {
    const nowMs = this.clock.nowMs();
    const today = utcDay(nowMs);
    const before = this.ledger.state;
    const change: Partial<MakerState> = {};
    if (before.day !== today && equity > 0n) {
      change.day = today;
      change.dayStartEquity = equity;
    }
    if (equity > (before.peakEquity ?? 0n)) change.peakEquity = equity;
    const verdict = this.judge({ ...before, ...change }, equity, position, nowMs);
    if (verdict) Object.assign(change, verdict.change);
    if (Object.keys(change).length === 0) return;
    try {
      await this.ledger.update(change);
    } finally {
      if (verdict) this.voice.alert(verdict.alert);
    }
  }

  private judge(
    state: MakerState,
    equity: bigint,
    position: bigint,
    nowMs: number,
  ): Verdict | null {
    if (state.mode === "run" || state.mode === "reduce") {
      const breach = breachOf(equity, state, MAKER_LIMITS.dailyLossBps, MAKER_LIMITS.drawdownBps);
      if (!breach) return null;
      return {
        change: { mode: "flatten", reason: breach, flattenStartedAtMs: nowMs },
        alert:
          `ALERT ${this.market} maker: ${breach}. It stops growing its position and reduces it toward flat ` +
          "with reduce-only orders around the reference price. If that fails, or the loss grows past " +
          `${MAKER_LIMITS.dailyLossStopBps / 100}% of the day's start or ${MAKER_LIMITS.drawdownStopBps / 100}% ` +
          `of the peak, it stops quoting altogether and users cannot close. ${KILL_SWITCH_HINT}`,
      };
    }
    if (state.mode !== "flatten") return null;
    const wider = breachOf(
      equity,
      state,
      MAKER_LIMITS.dailyLossStopBps,
      MAKER_LIMITS.drawdownStopBps,
    );
    if (wider) return this.hardStop(`while it was reducing its position, ${wider}`);
    const started = state.flattenStartedAtMs;
    if (position !== 0n && started !== null && nowMs - started >= MAKER_LIMITS.flattenDeadlineMs) {
      return this.hardStop(
        `it still held a position ${Math.round((nowMs - started) / 60_000)} minutes after it began to reduce it`,
      );
    }
    return null;
  }

  private hardStop(reason: string): Verdict {
    return {
      change: { mode: "stopped", reason },
      alert: `ALERT ${this.market} maker: ${reason}, so it has stopped quoting. ${STOP_STRANDS_USERS} ${KILL_SWITCH_HINT}`,
    };
  }

  /**
   * The maker met something it does not understand. The soft stop is enough
   * to keep it safe, so a maker that was quoting falls back to that. One that
   * is already reducing, or stopped growing, and meets another such problem
   * stops altogether.
   */
  async stopFor(reason: string): Promise<void> {
    const soft = this.ledger.state.mode === "run";
    try {
      await this.ledger.update({
        mode: soft ? "reduce" : "stopped",
        reason,
        flattenStartedAtMs: null,
      });
    } finally {
      this.voice.alert(
        soft
          ? `ALERT ${this.market} maker: it met a problem it does not understand and has fallen back to the soft stop ` +
              `(${reason}). It quotes only the side that shrinks its position, and stops altogether if it meets another. ` +
              `Read the log above this line. ${KILL_SWITCH_HINT}`
          : `ALERT ${this.market} maker: it met a problem it does not understand while it was not quoting freely, ` +
              `and has stopped quoting (${reason}). ${STOP_STRANDS_USERS} Read the log above this line. ${KILL_SWITCH_HINT}`,
      );
    }
  }

  /**
   * The operator's control file cannot be read, so what they want is not
   * known. A maker that was quoting freely holds itself at the soft stop. It
   * stays there until a valid, newer "resume" is written, so a file that
   * parses again does not put it back to quoting by itself.
   */
  async holdFor(reason: string): Promise<void> {
    if (this.ledger.state.mode !== "run") return;
    try {
      await this.ledger.update({ mode: "reduce", reason, flattenStartedAtMs: null });
    } finally {
      this.voice.alert(
        `ALERT ${this.market} maker: ${reason}. It has fallen back to the soft stop and quotes only the side ` +
          `that shrinks its position, until the file is fixed and it is resumed. ${KILL_SWITCH_HINT}`,
      );
    }
  }
}
