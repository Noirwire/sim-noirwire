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

/**
 * Says so once when trading stops being ready (a blind hedge, a stopped maker, an order of unknown
 * outcome), as an alert, and once when it is ready again, as a notice. A hold that lasts is alerted
 * again after 2 minutes, then after 10 minutes, and the wait doubles each time (10, 20, 40 ... min)
 * up to 4 hours, so a long outage does not page all night.
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
      return;
    }
    this.notReadySinceMs ??= nowMs;
    if (this.seeded && this.ready) {
      this.ready = false;
      this.voice.alert(`ALERT trading is not ready: ${now.reason ?? "no reason given"}`);
    }
    this.escalate(now, nowMs - this.notReadySinceMs, nowMs);
  }

  private escalate(now: Readiness, heldMs: number, nowMs: number): void {
    if (heldMs < FIRST_ESCALATION_MS) return;
    const last = this.lastEscalationAtMs;
    if (last !== null) {
      if (nowMs - last < this.repeatGapMs) return;
      this.repeatGapMs = Math.min(this.repeatGapMs * 2, MAX_REPEAT_MS);
    }
    this.lastEscalationAtMs = nowMs;
    this.voice.alert(
      `ALERT trading has not been ready for ${Math.floor(heldMs / 60_000)} min: ${now.reason ?? "no reason given"}`,
    );
  }
}
