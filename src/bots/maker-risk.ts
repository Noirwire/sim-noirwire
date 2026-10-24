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
 * A flattening that has worked leaves the maker flat and dark: it quotes
 * nothing until an operator resumes it.
 *
 * The kill switch's soft stop ("reduce") only stops it growing: it pulls its
 * quotes and places none, and only a flatten reduces the position. Its
 * hard stop ("stopped") cancels everything. An error it does not understand
 * falls back to the soft stop. At the soft stop it takes several such errors
 * in a row, with no good requote between them, to reach the hard stop; while
 * flattening, one is enough.
 *
 * All of it is kept on disk and ends only when an operator resumes it, so a
 * restart does not forgive a loss.
 */
export class MakerRisk {
  private unknownErrorsInARow = 0;
  private flatAnnounced = false;

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
    if (!command) return;
    if (command.requestedAtMs <= this.ledger.state.lastCommandAtMs) {
      const retried =
        command.mode === "run" && (await this.ledger.canRetryResume(command.requestedAtMs));
      if (!retried) return;
    }
    this.unknownErrorsInARow = 0;
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
      : "It pulls its quotes and places none; only a flatten reduces the position.";
    this.voice.alert(`ALERT ${this.market} maker: ${reason}. ${consequence} ${KILL_SWITCH_HINT}`);
  }

  /**
   * Counts the day's loss and the drawdown against the limits, at `equity`
   * (the worse of the venue's mark and the reference price, or what the
   * safety rules make of it while the reference is down). A first breach
   * starts the flattening; a second, wider one, or a flattening that is not
   * working, stops the maker. `blind` is true while the reference price is
   * down and was not good at any time in the last hour: a flattening then gets
   * a shorter deadline.
   *
   * The UTC day's starting equity is kept while the maker flattens a position,
   * so the turn of the day does not forgive the loss that started it.
   */
  async check(equity: bigint, position: bigint, blind = false): Promise<void> {
    const nowMs = this.clock.nowMs();
    const today = utcDay(nowMs);
    const before = this.ledger.state;
    const change: Partial<MakerState> = {};
    const keepsDayLine = before.mode === "flatten" && position !== 0n;
    if (before.day !== today && equity > 0n && !keepsDayLine) {
      change.day = today;
      change.dayStartEquity = equity;
    }
    if (equity > (before.peakEquity ?? 0n)) change.peakEquity = equity;
    const verdict = this.judge({ ...before, ...change }, equity, position, nowMs, blind);
    if (verdict) Object.assign(change, verdict.change);
    if (Object.keys(change).length === 0 && !verdict) return;
    try {
      if (Object.keys(change).length > 0) await this.ledger.update(change);
    } finally {
      if (verdict) this.voice.alert(verdict.alert);
    }
  }

  /** A good requote went out, so the errors it met before were not a pattern. */
  requoteSucceeded(): void {
    this.unknownErrorsInARow = 0;
  }

  private judge(
    state: MakerState,
    equity: bigint,
    position: bigint,
    nowMs: number,
    blind: boolean,
  ): Verdict | null {
    if (state.mode !== "flatten" || position !== 0n) this.flatAnnounced = false;
    if (state.mode === "run" || state.mode === "reduce") {
      const breach = breachOf(equity, state, MAKER_LIMITS.dailyLossBps, MAKER_LIMITS.drawdownBps);
      if (!breach) return null;
      return {
        change: { mode: "flatten", reason: breach, flattenStartedAtMs: nowMs },
        alert:
          `ALERT ${this.market} maker: ${breach}. It stops growing its position and reduces it toward flat ` +
          "with reduce-only orders around the reference price. If that fails, or the loss grows past " +
          `${MAKER_LIMITS.dailyLossStopBps / 100}% of the day's start or ${MAKER_LIMITS.drawdownStopBps / 100}% ` +
          `of the peak, it stops quoting altogether and users cannot close. Once it is flat it quotes nothing ` +
          `and stays dark until an operator resumes it. ${KILL_SWITCH_HINT}`,
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
    const deadlineMs = blind ? MAKER_LIMITS.blindFlattenDeadlineMs : MAKER_LIMITS.flattenDeadlineMs;
    if (position !== 0n && started !== null && nowMs - started >= deadlineMs) {
      const blindNote = blind ? ", with no good reference price in the last hour" : "";
      return this.hardStop(
        `it still held a position ${Math.round((nowMs - started) / 60_000)} minutes after it began to reduce it${blindNote}`,
      );
    }
    if (position === 0n && !this.flatAnnounced) {
      this.flatAnnounced = true;
      return {
        change: {},
        alert:
          `ALERT ${this.market} maker: it has reduced its position to flat. It now quotes nothing, so new ` +
          `users find an empty book, and it stays that way until an operator resumes it. ${KILL_SWITCH_HINT}`,
      };
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
   * is already at the soft stop stays there until it has met such a problem
   * `unknownErrorsBeforeHardStop` times in a row, with no good requote in
   * between, and then stops altogether. One that is flattening, or stopped
   * already, stops altogether at the first: a flattening that cannot place its
   * order is not working.
   */
  async stopFor(reason: string): Promise<void> {
    const { mode } = this.ledger.state;
    const soft = mode === "run";
    if (mode === "reduce") {
      this.unknownErrorsInARow += 1;
      const limit = MAKER_LIMITS.unknownErrorsBeforeHardStop;
      if (this.unknownErrorsInARow < limit) {
        this.voice.notice(
          `${this.market} maker met a problem it does not understand while at the soft stop ` +
            `(${reason}), ${this.unknownErrorsInARow} in a row. It stops quoting altogether at ${limit}.`,
        );
        return;
      }
    } else {
      this.unknownErrorsInARow = 0;
    }
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
              `(${reason}). It pulls its quotes and places none, and stops altogether if it meets ` +
              `${MAKER_LIMITS.unknownErrorsBeforeHardStop} more in a row. Read the log above this line. ${KILL_SWITCH_HINT}`
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
    this.unknownErrorsInARow = 0;
    try {
      await this.ledger.update({ mode: "reduce", reason, flattenStartedAtMs: null });
    } finally {
      this.voice.alert(
        `ALERT ${this.market} maker: ${reason}. It has fallen back to the soft stop and pulls its quotes, ` +
          `until the file is fixed and it is resumed. ${KILL_SWITCH_HINT}`,
      );
    }
  }
}
