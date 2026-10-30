import type { MakerVoice } from "../bots/maker-risk.js";
import type { Clock } from "../engine/clock.js";

interface Readiness {
  ready: boolean;
  reason?: string;
}

/** Trading that stays not ready this long is alerted again, however it began. */
const FIRST_ESCALATION_MS = 2 * 60_000;
/** The wait after the 2 minute alert before the next one; each wait after it is twice the last. */
const FIRST_REPEAT_MS = 10 * 60_000;
const MAX_REPEAT_MS = 4 * 60 * 60_000;

const reasonKind = (reason: string | undefined): string =>
  (reason ?? "").replace(/\d+(?:\.\d+)?/g, "#");

/**
 * Says so once when trading stops being ready (a blind hedge, a stopped maker, an order of unknown
 * outcome), as an alert, and once when it is ready again, as a notice. A hold that lasts is alerted
 * again after 2 minutes, then after 10 minutes, and the wait doubles each time (10, 20, 40 ... min)
 * up to 4 hours, so a long outage does not page all night.
 *
 * A reason of a new kind during an outage (the reason with its numbers taken out, so "no quotes for
 * 25391 s" and "no quotes for 30 s" are one kind) is alerted at once, without moving the repeat
 * schedule: a stopped maker should not wait out a 4 hour gap behind a stale price. A kind already
 * seen in the same outage is not alerted again by itself, so reasons that flap in their numbers stay quiet.
 *
 * It stays quiet until it has first read trading as ready: a hedge that is blind while it settles
 * after a wake is not an outage. A hold that never ends is still alerted by the escalation.
 *
 * One watch serves the whole process. A service that sleeps and wakes while trading stays not ready
 * keeps the time the hold began, so awake spans shorter than the escalation delay still add up to an alert.
 */
export class TradingWatch {
  private seeded = false;
  private ready = true;
  private notReadySinceMs: number | null = null;
  private lastEscalationAtMs: number | null = null;
  private repeatGapMs = FIRST_REPEAT_MS;
  private seenKinds = new Set<string>();

  constructor(
    private readonly trading: () => Readiness,
    private readonly voice: MakerVoice,
    private readonly clock: Clock,
  ) {}

  /**
   * Call on each wake. A hedge that reads blind while it settles is not an outage, so a watch that
   * last saw trading ready waits for it to be ready again. A hold already under way is untouched.
   */
  resume(): void {
    if (this.ready) this.seeded = false;
  }

  check(): void {
    const now = this.trading();
    const nowMs = this.clock.nowMs();
    if (now.ready) {
      if ((this.seeded && !this.ready) || this.lastEscalationAtMs !== null) {
        this.voice.notice("trading is ready again");
      }
      this.seeded = true;
      this.ready = true;
      this.notReadySinceMs = null;
      this.lastEscalationAtMs = null;
      this.repeatGapMs = FIRST_REPEAT_MS;
      this.seenKinds.clear();
      return;
    }
    this.notReadySinceMs ??= nowMs;
    const kind = reasonKind(now.reason);
    const newKind = !this.seenKinds.has(kind);
    this.seenKinds.add(kind);
    let alerted = false;
    if (this.seeded && this.ready) {
      this.ready = false;
      alerted = true;
      this.voice.alert(`ALERT trading is not ready: ${now.reason ?? "no reason given"}`);
    }
    alerted = this.escalate(now, nowMs - this.notReadySinceMs, nowMs) || alerted;
    if (newKind && !alerted && (this.lastEscalationAtMs !== null || (this.seeded && !this.ready))) {
      this.voice.alert(
        `ALERT trading is still not ready, for a new reason: ${now.reason ?? "no reason given"}`,
      );
    }
  }

  private escalate(now: Readiness, heldMs: number, nowMs: number): boolean {
    if (heldMs < FIRST_ESCALATION_MS) return false;
    const last = this.lastEscalationAtMs;
    if (last !== null) {
      if (nowMs - last < this.repeatGapMs) return false;
      this.repeatGapMs = Math.min(this.repeatGapMs * 2, MAX_REPEAT_MS);
    }
    this.lastEscalationAtMs = nowMs;
    this.voice.alert(
      `ALERT trading has not been ready for ${Math.floor(heldMs / 60_000)} min: ${now.reason ?? "no reason given"}`,
    );
    return true;
  }
}
