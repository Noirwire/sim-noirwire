import { MAKER_LIMITS } from "../bots/maker-limits.js";
import type { MakerVoice } from "../bots/maker-risk.js";
import type { MakerMode } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { absBigInt, mulDivScale, toDecimalString } from "../engine/money.js";
import type { Reference } from "../prices/reference-price.js";
import { type Schedule, errorClass, realSchedule, withinDeadline } from "./call-deadline.js";
import { decideHedge } from "./hedge-decision.js";
import { HEDGE_LIMITS, type HedgeSettings, VENUE_CALL_TIMEOUT_MS } from "./hedge-limits.js";
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
  /** How long a venue call may take; the default is `VENUE_CALL_TIMEOUT_MS`. */
  callTimeoutMs?: number;
  /** Starts the deadline timers; a test supplies its own. */
  schedule?: Schedule;
}

/** The venue answered its health check with "not trading". Its own reason is not logged. */
class VenueUnhealthy extends Error {
  constructor() {
    super("the hedge venue reports that it is not trading");
    this.name = "VenueUnhealthy";
  }
}

/** An order whose outcome the controller does not know yet: it is never followed by a new order. */
interface UnexplainedOrder {
  clientId: string;
  sentAtMs: number;
  positionBefore: bigint;
  cancelled: boolean;
  alerted: boolean;
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
  private lastPriceAtMs = 0;
  private unexplained: UnexplainedOrder | null = null;
  private reachable = false;
  private lastReadAtMs: number | null = null;
  private confirmedAtMs: number | null = null;
  private holdUntilMs = 0;
  private unmanagedAnnounced = false;
  private orders = 0;
  private readonly startedAtMs: number;
  private restartNoticeSent = false;

  constructor(private readonly options: HedgeControllerOptions) {
    this.startedAtMs = options.clock.nowMs();
  }

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
    if (now < this.startedAtMs + HEDGE_LIMITS.settleAfterUnknownMs) return "blind";
    const exposed = this.unhedgedNotional();
    if (exposed >= settings.hardUnhedgedNotional) return "blind";
    if (exposed >= settings.softUnhedgedNotional) return "lagging";
    const confirmed = this.confirmedAtMs;
    return confirmed === null || now - confirmed > settings.confirmTimeoutMs ? "lagging" : "ok";
  }

  async tick(): Promise<void> {
    const { clock, makerMode, makerPosition } = this.options;
    const maker = await this.within("the maker's position", makerPosition);
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
    const reference = await this.options.reference.read();
    if (reference.ok) {
      this.lastPrice = reference.price;
      this.lastPriceAtMs = clock.nowMs();
    }
    if (this.settlingAfterStart()) return;
    if (await this.stillUnexplained(account)) return;
    if (clock.nowMs() < this.holdUntilMs) return;

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
      // A fresh venue read with the exposure inside the soft limit is a confirmation, whatever held the order.
      if (
        decision.reason !== "no trusted price" &&
        this.unhedgedNotional() < this.options.settings.softUnhedgedNotional
      ) {
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
    const accepted = await this.send(order, account.position);
    const after = await this.readVenue();
    if (after) this.noteAccount(after, maker);
    // An accepted order that has not moved the position may still fill: wait for the venue to show it.
    if (accepted && (!after || after.position === account.position)) {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
      this.unexplained ??= {
        clientId: order.clientId,
        sentAtMs: clock.nowMs(),
        positionBefore: account.position,
        cancelled: true,
        alerted: false,
      };
    }
  }

  /**
   * An order sent just before a restart is not known to this process, so no order is sent until the
   * venue has had the settle time to show it. The account is still read and noted meanwhile.
   */
  private settlingAfterStart(): boolean {
    const { clock, voice, market } = this.options;
    if (clock.nowMs() >= this.startedAtMs + HEDGE_LIMITS.settleAfterUnknownMs) return false;
    if (!this.restartNoticeSent) {
      this.restartNoticeSent = true;
      voice.notice(
        `${market} hedge is waiting for the venue to settle after a restart before it sends an order`,
      );
    }
    return true;
  }

  /** Whether the venue took the order. A refusal or an unclear answer holds back the next order. */
  private async send(order: HedgeOrder, positionBefore: bigint): Promise<boolean> {
    const { venue, voice, market, clock } = this.options;
    try {
      const ack = await this.within("an order", () => venue.placeIoc(order));
      if (ack.status === "accepted") return true;
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.retryAfterRefusalMs;
      voice.notice(`${market} hedge order refused by the venue: ${ack.reason}`);
    } catch (error) {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
      voice.notice(
        `${market} hedge order has an unknown outcome (${errorClass(error)}). ` +
          "It is not sent again until the venue's position or fills have explained it.",
      );
      this.unexplained = {
        clientId: order.clientId,
        sentAtMs: clock.nowMs(),
        positionBefore,
        cancelled: false,
        alerted: false,
      };
      await this.cancelUnexplained(this.unexplained);
    }
    return false;
  }

  /** Cancels the order by its client id. A cancel that fails stays unresolved, is retried, and is an ALERT. */
  private async cancelUnexplained(order: UnexplainedOrder): Promise<void> {
    const { venue, voice, market } = this.options;
    order.cancelled = await this.within("a cancel", () => venue.cancel(order.clientId)).then(
      () => true,
      () => false,
    );
    if (order.cancelled || order.alerted) return;
    order.alerted = true;
    voice.alert(
      `ALERT ${market} hedge: an order of unknown outcome could not be cancelled. ` +
        "No hedge order is sent until the venue's position or fills explain it. Check the hedge account by hand.",
    );
  }

  /**
   * Whether an order of unknown outcome is still unexplained, which holds every new order. It is
   * explained when the hedge position moved, or when the venue's fills show its client id and the
   * position has caught up. With neither, it is explained as not filled only once its cancel went
   * through and the settle time has passed. A cancel that fails is retried every tick.
   */
  private async stillUnexplained(account: HedgeAccount): Promise<boolean> {
    const order = this.unexplained;
    if (!order) return false;
    const { venue, clock } = this.options;
    if (account.position !== order.positionBefore) {
      this.unexplained = null;
      return false;
    }
    if (!order.cancelled) await this.cancelUnexplained(order);
    const fills = await this.within("its fills", () => venue.fills(order.sentAtMs)).catch(
      () => null,
    );
    if (fills === null || fills.some((fill) => fill.clientId === order.clientId)) return true;
    if (order.cancelled && clock.nowMs() >= order.sentAtMs + HEDGE_LIMITS.settleAfterUnknownMs) {
      this.unexplained = null;
      return false;
    }
    return true;
  }

  /** The venue's account, or null with the venue marked unreachable. Rules are read once. */
  private async readVenue(): Promise<HedgeAccount | null> {
    const { venue, voice, market, clock } = this.options;
    try {
      const health = await this.within("its health", () => venue.health());
      if (!health.ok) throw new VenueUnhealthy();
      this.rules ??= await this.within("its rules", () => venue.rules());
      const account = await this.within("its account", () => venue.account());
      if (!this.reachable) voice.notice(`${market} hedge venue answers again`);
      this.reachable = true;
      this.lastReadAtMs = clock.nowMs();
      return account;
    } catch (error) {
      if (this.reachable) {
        voice.notice(`${market} hedge venue cannot be reached: ${errorClass(error)}`);
      }
      this.reachable = false;
      return null;
    }
  }

  private within<T>(what: string, call: () => Promise<T>): Promise<T> {
    const { callTimeoutMs = VENUE_CALL_TIMEOUT_MS, schedule = realSchedule } = this.options;
    return withinDeadline(what, callTimeoutMs, schedule, call);
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
    const priceAge = this.options.clock.nowMs() - this.lastPriceAtMs;
    if (this.lastPrice === null || priceAge > MAKER_LIMITS.maxSourceAgeMs) {
      return this.options.settings.hardUnhedgedNotional;
    }
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
