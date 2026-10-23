import type { MakerVoice } from "../bots/maker-risk.js";
import type { Clock } from "../engine/clock.js";

interface Readiness {
  ready: boolean;
  reason?: string;
}

/** Trading that stays not ready this long is alerted again, however it began. */
const FIRST_ESCALATION_MS = 2 * 60_000;
const REPEAT_ESCALATION_MS = 10 * 60_000;

/**
 * Says so once when trading stops being ready (a blind hedge, a stopped maker, an order of unknown
 * outcome), as an alert, and once when it is ready again, as a notice. A hold that lasts is alerted
 * again after 2 minutes and every 10 minutes after that.
 *
 * It stays quiet until it has first read trading as ready: a hedge that is blind while it settles
 * after a wake is not an outage. A hold that never ends is still alerted by the escalation.
 */
export class TradingWatch {
  private seeded = false;
  private ready = true;
  private notReadySinceMs: number | null = null;
  private lastEscalationAtMs: number | null = null;

  constructor(
    private readonly trading: () => Readiness,
    private readonly voice: MakerVoice,
    private readonly clock: Clock,
  ) {}

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
    if (last !== null && nowMs - last < REPEAT_ESCALATION_MS) return;
    this.lastEscalationAtMs = nowMs;
    this.voice.alert(
      `ALERT trading has not been ready for ${Math.floor(heldMs / 60_000)} min: ${now.reason ?? "no reason given"}`,
    );
  }
}
