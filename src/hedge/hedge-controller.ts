import type { MakerVoice } from "../bots/maker-risk.js";
import type { MakerMode } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { absBigInt, mulDivScale, toDecimalString } from "../engine/money.js";
import { firstLine } from "../logging/first-line.js";
import type { Reference } from "../prices/reference-price.js";
import { decideHedge } from "./hedge-decision.js";
import { HEDGE_LIMITS, type HedgeSettings } from "./hedge-limits.js";
import type { HedgeAccount, HedgeMarketRules, HedgeOrder, HedgeVenue } from "./hedge-venue.js";

/**
 * How well the maker's exposure is hedged. `ok`: hedged, or too little left to
 * hedge. `lagging`: unhedged exposure is above the soft limit, or the venue has
 * confirmed nothing for too long. `blind`: the venue cannot be reached, or the
 * unhedged exposure is above the hard limit.
 */
export type HedgeStatus = "ok" | "lagging" | "blind";

/** What the maker reads. */
export interface HedgeGate {
  status(): HedgeStatus;
}

export interface HedgeControllerOptions {
  venue: HedgeVenue;
  clock: Clock;
  reference: { read(): Promise<Reference> };
  /** The maker's signed SOL position, read from the exchange. */
  makerPosition: () => Promise<bigint>;
  /** The maker's mode, which the kill switch and the loss limits set. */
  makerMode: () => MakerMode;
  voice: MakerVoice;
  market: string;
  settings: HedgeSettings;
}

const sol = (size: bigint): string => toDecimalString(size).replace(/0+$/, "").replace(/\.$/, ".0");

/**
 * Keeps the maker's net SOL exposure near flat by trading the opposite
 * position on an outside perpetuals venue. Each tick it reads the maker's
 * position and the venue's real position, and sends at most one order
 * (`decideHedge`). It never trusts an order's answer: after every order it
 * reads the venue's position again, so a partial fill is simply what is left
 * to hedge next tick, and an order whose outcome is unknown is not sent again
 * until the venue has had time to show it.
 *
 * It opens no new hedge exposure while the maker is at a soft stop or
 * flattening, and trades nothing at all once the maker is stopped, when it
 * says the hedge position is unmanaged.
 */
export class HedgeController implements HedgeGate {
  private rules: HedgeMarketRules | null = null;
  private position: bigint | null = null;
  private unhedged = 0n;
  private lastPrice: bigint | null = null;
  private reachable = false;
  private lastReadAtMs: number | null = null;
  private confirmedAtMs: number | null = null;
  private holdUntilMs = 0;
  private unmanagedAnnounced = false;
  private orders = 0;

  constructor(private readonly options: HedgeControllerOptions) {}

  /** The hedge account's position at the last read the venue answered. */
  get hedgedPosition(): bigint | null {
    return this.position;
  }

  /** When the venue last confirmed the hedge: a position that moved, or one that left nothing to hedge. */
  get lastConfirmedAtMs(): number | null {
    return this.confirmedAtMs;
  }

  status(): HedgeStatus {
    const { settings, clock } = this.options;
    const now = clock.nowMs();
    const lastRead = this.lastReadAtMs;
    if (!this.reachable || lastRead === null || now - lastRead > settings.confirmTimeoutMs) {
      return "blind";
    }
    const exposed = this.unhedgedNotional();
    if (exposed >= settings.hardUnhedgedNotional) return "blind";
    if (exposed >= settings.softUnhedgedNotional) return "lagging";
    const confirmed = this.confirmedAtMs;
    return confirmed === null || now - confirmed > settings.confirmTimeoutMs ? "lagging" : "ok";
  }

  async tick(): Promise<void> {
    const { clock, makerMode, makerPosition } = this.options;
    const maker = await makerPosition();
    const account = await this.readVenue();
    const { rules } = this;
    if (!account || !rules) return;
    this.noteAccount(account, maker);

    const mode = makerMode();
    if (mode === "stopped") {
      this.announceUnmanaged(account.position);
      return;
    }
    this.unmanagedAnnounced = false;
    if (clock.nowMs() < this.holdUntilMs) return;

    const reference = await this.options.reference.read();
    if (reference.ok) this.lastPrice = reference.price;
    const decision = decideHedge({
      makerPosition: maker,
      hedgePosition: account.position,
      equity: account.equity,
      maxLeverage: this.options.settings.maxLeverage,
      triggerNotional: this.options.settings.softUnhedgedNotional / 2n,
      rules,
      reference,
      priceBandBps: HEDGE_LIMITS.priceBandBps,
      mayGrow: mode === "run",
    });
    if (decision.action === "none") {
      if (decision.reason === "hedged" || decision.reason === "below the trigger") {
        this.confirmedAtMs = clock.nowMs();
      }
      return;
    }

    this.orders += 1;
    const order = {
      clientId: `hedge-${this.options.market}-${clock.nowMs()}-${this.orders}`,
      side: decision.side,
      size: decision.size,
      limitPrice: decision.limitPrice,
      reduceOnly: decision.reduceOnly,
    };
    const accepted = await this.send(order);
    const after = await this.readVenue();
    if (after) this.noteAccount(after, maker);
    // An accepted order that has not moved the position may still fill: wait for the venue to show it.
    if (accepted && (!after || after.position === account.position)) {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
    }
  }

  /** Whether the venue took the order. A refusal or an unclear answer holds back the next order. */
  private async send(order: HedgeOrder): Promise<boolean> {
    const { venue, voice, market, clock } = this.options;
    try {
      const ack = await venue.placeIoc(order);
      if (ack.status === "accepted") return true;
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.retryAfterRefusalMs;
      voice.notice(`${market} hedge order refused by the venue: ${ack.reason}`);
    } catch (error) {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
      voice.notice(
        `${market} hedge order has an unknown outcome (${firstLine(error)}). ` +
          "It is not sent again until the venue's position has settled.",
      );
      await venue.cancel(order.clientId).catch(() => {});
    }
    return false;
  }

  /** The venue's account, or null with the venue marked unreachable. Rules are read once. */
  private async readVenue(): Promise<HedgeAccount | null> {
    const { venue, voice, market, clock } = this.options;
    try {
      const health = await venue.health();
      if (!health.ok) throw new Error(health.reason);
      this.rules ??= await venue.rules();
      const account = await venue.account();
      if (!this.reachable) voice.notice(`${market} hedge venue answers again`);
      this.reachable = true;
      this.lastReadAtMs = clock.nowMs();
      return account;
    } catch (error) {
      if (this.reachable) {
        voice.notice(`${market} hedge venue cannot be reached: ${firstLine(error)}`);
      }
      this.reachable = false;
      return null;
    }
  }

  /** Records what the venue shows. A position that moved is the venue confirming a fill. */
  private noteAccount(account: HedgeAccount, maker: bigint): void {
    if (this.position !== null && account.position !== this.position) {
      this.confirmedAtMs = this.options.clock.nowMs();
    }
    this.position = account.position;
    this.unhedged = maker + account.position;
  }

  private unhedgedNotional(): bigint {
    if (this.unhedged === 0n) return 0n;
    if (this.lastPrice === null) return this.options.settings.hardUnhedgedNotional;
    return mulDivScale(absBigInt(this.unhedged), this.lastPrice);
  }

  private announceUnmanaged(position: bigint): void {
    if (this.unmanagedAnnounced) return;
    this.unmanagedAnnounced = true;
    this.options.voice.alert(
      `ALERT ${this.options.market} hedge: the maker is stopped, so the controller trades nothing. ` +
        `The hedge position of ${sol(position)} SOL on the venue is left as it is and is unmanaged. ` +
        "Close it by hand on the venue if it should not stay open.",
    );
  }
}
