import type { MakerVoice } from "../bots/maker-risk.js";

interface Readiness {
  ready: boolean;
  reason?: string;
}

/**
 * Says so once when trading stops being ready (a blind hedge, a stopped maker), as an alert, and once
 * when it is ready again, as a notice. Looking does not repeat either message.
 */
export class TradingWatch {
  private ready = true;

  constructor(
    private readonly trading: () => Readiness,
    private readonly voice: MakerVoice,
  ) {}

  check(): void {
    const now = this.trading();
    if (now.ready === this.ready) return;
    this.ready = now.ready;
    if (now.ready) {
      this.voice.notice("trading is ready again");
    } else {
      this.voice.alert(`ALERT trading is not ready: ${now.reason ?? "no reason given"}`);
    }
  }
}
