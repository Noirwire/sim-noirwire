import { MAKER_LIMITS } from "../bots/maker-limits.js";
import type { MakerVoice } from "../bots/maker-risk.js";
import type { MakerMode } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import {
  absBigInt,
  maxBigInt,
  minBigInt,
  mulDivScale,
  roundDownToStep,
  toDecimalString,
} from "../engine/money.js";
import type { Reference } from "../prices/reference-price.js";
import { type Schedule, errorClass, realSchedule, withinDeadline } from "./call-deadline.js";
import { decideHedge } from "./hedge-decision.js";
import {
  HEDGE_LIMITS,
  type HedgeSettings,
  LATE_DISPATCH_QUARANTINE_MS,
  UNMANAGED_ALERT_REPEAT_MS,
  UNRESOLVED_HOLD_BLIND_MS,
  VENUE_CALL_TIMEOUT_MS,
} from "./hedge-limits.js";
import type { HedgeAccount, HedgeMarketRules, HedgeOrder, HedgeVenue } from "./hedge-venue.js";
import type { SavedOrders, UnknownOrderRecord } from "./unknown-order-store.js";

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
  /** Where an order that may have reached the venue is kept, so a restart does not send a second one on top of it. */
  unknownOrders: SavedOrders;
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
  /** How far the position may still move from `positionBefore` if every unexplained order filled in full. */
  moveMin: bigint;
  moveMax: bigint;
  cancelled: boolean;
  alerted: boolean;
  /** The order's call may still be dispatched late until then, so nothing clears the hold before it. */
  quarantinedUntilMs: number;
  /** The order's own call. While it has not settled it may still dispatch, so nothing clears the hold. */
  call: { readonly live: boolean };
}

/** The signed change an order makes to the hedge position if it fills in full. */
const signedSize = (order: HedgeOrder): bigint => (order.side === "buy" ? order.size : -order.size);

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
 * says the hedge position is unmanaged, and says so again every 10 minutes
 * while a position stays open.
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
  private unmanagedAlertedAtMs: number | null = null;
  private unmanaged = false;
  /** True from the start: a position left open by a previous run is unknown until a read has shown it. */
  private unconfirmedAtSleep = true;
  private orders = 0;
  private readonly startedAtMs: number;
  private restartNoticeSent = false;
  /** Whether the saved order has been read back. Until it has, no order is sent. */
  private savedOrderRead = false;
  /** The saved order cannot be read, so the hedge cannot tell whether an order is still out. */
  private savedOrderUnreadable = false;
  private savedOrderAlerted = false;
  private saveFailureAlerted = false;

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

  /** Whether the maker is stopped while the hedge account still holds a position nobody manages. */
  get hasUnmanagedPosition(): boolean {
    return this.unmanaged;
  }

  /** Whether the last read before sleep failed or has not finished, so an open hedge cannot be ruled out. */
  get unconfirmedWhileAsleep(): boolean {
    return this.unconfirmedAtSleep;
  }

  /**
   * One last read of the hedge account when the service goes to sleep, because no tick will read it again
   * until the next wake. A maker that stopped since the last tick would otherwise leave an open hedge unseen.
   * It marks the hedge unconfirmed first, so a read that fails or is cut short leaves it unconfirmed.
   */
  async confirmBeforeSleep(): Promise<void> {
    this.unconfirmedAtSleep = true;
    const account = await this.readVenue();
    if (!account) return;
    if (this.options.makerMode() === "stopped") this.announceUnmanaged(account.position);
    else this.unmanaged = false;
    this.unconfirmedAtSleep = false;
  }

  status(): HedgeStatus {
    const { settings, clock } = this.options;
    const now = clock.nowMs();
    const lastRead = this.lastReadAtMs;
    if (!this.reachable || lastRead === null || now - lastRead > settings.confirmTimeoutMs) {
      return "blind";
    }
    if (this.savedOrderUnreadable) return "blind";
    if (now < this.startedAtMs + HEDGE_LIMITS.settleAfterUnknownMs) return "blind";
    // A hold that nothing has resolved is never released by age, but it is no longer a hedge anyone can trust.
    if (this.unexplained && now - this.unexplained.sentAtMs > UNRESOLVED_HOLD_BLIND_MS) {
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
    let maker: bigint;
    try {
      maker = await this.within("the maker's position", makerPosition);
    } catch (error) {
      // Without the maker's exposure the controller cannot hedge it: say so now, not when the last read ages out.
      this.reachable = false;
      throw error;
    }
    if (!(await this.restoreSavedOrder())) return;
    const account = await this.readVenue();
    const { rules } = this;
    if (!account || !rules) return;
    this.noteAccount(account, maker);

    const mode = makerMode();
    if (mode === "stopped") {
      this.announceUnmanaged(account.position);
      // Nothing new is sent, but an order of unknown outcome is still cancelled and reconciled.
      await this.stillUnexplained(account);
      return;
    }
    this.unmanaged = false;
    this.unmanagedAlertedAtMs = null;
    const reference = await this.options.reference.read();
    if (reference.ok) {
      this.lastPrice = reference.price;
      this.lastPriceAtMs = clock.nowMs();
    }
    if (this.settlingAfterStart()) return;
    const unexplained = await this.stillUnexplained(account);
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
      // While an order is unexplained the hedge may only shrink.
      mayGrow: mode === "run" && !unexplained,
    });
    if (decision.action === "none") {
      // A fresh venue read with the exposure inside the soft limit is a confirmation, whatever held the order.
      if (
        !unexplained &&
        decision.reason !== "no trusted price" &&
        this.unhedgedNotional() < this.options.settings.softUnhedgedNotional
      ) {
        this.confirmedAtMs = clock.nowMs();
      }
      return;
    }

    const size = unexplained
      ? this.safeShrinkSize(decision, account.position, rules)
      : decision.size;
    if (size <= 0n) return;
    this.orders += 1;
    const order = {
      clientId: `hedge-${this.options.market}-${clock.nowMs()}-${this.orders}`,
      side: decision.side,
      size,
      limitPrice: decision.limitPrice,
      reduceOnly: decision.reduceOnly,
    };
    await this.sendOrder(order, account, maker);
  }

  /**
   * How much of a shrinking order may go out while an order is unexplained. It must keep the hedge
   * on the same side of zero whether that order filled or not, in either direction, so the size is
   * cut to the smallest position the hedge could really be at. Zero when the order is not a
   * reduce-only shrink, when the possible positions straddle zero, or when what is left is under the
   * venue's minimum.
   */
  private safeShrinkSize(
    decision: { size: bigint; reduceOnly: boolean },
    position: bigint,
    rules: HedgeMarketRules,
  ): bigint {
    const held = this.unexplained;
    if (!held || !decision.reduceOnly || position === 0n) return 0n;
    const reachable = [position, position + held.moveMin, position + held.moveMax];
    const sign = position > 0n ? 1n : -1n;
    if (reachable.some((at) => at * sign <= 0n)) return 0n;
    const smallest = reachable.map((at) => absBigInt(at)).reduce(minBigInt);
    const size = roundDownToStep(minBigInt(decision.size, smallest), rules.sizeIncrement);
    if (this.lastPrice === null || mulDivScale(size, this.lastPrice) < rules.minOrderNotional) {
      return 0n;
    }
    return size;
  }

  /**
   * Saves, sends and settles one order. When an order of unknown outcome is already held, this is a
   * shrink: the saved record widens by what the shrink could do before it is sent, so a restart
   * sizes against the worst case, and the held order stays the one that is reconciled. A shrink the
   * position shows (moving no further than its size) is taken out of the held order's reference
   * position; one that is refused is taken back; anything else keeps the wider bounds.
   */
  private async sendOrder(order: HedgeOrder, account: HedgeAccount, maker: bigint): Promise<void> {
    const { clock } = this.options;
    const held = this.unexplained;
    const delta = signedSize(order);
    const sentAtMs = clock.nowMs();
    const widened = {
      moveMin: (held?.moveMin ?? 0n) + minBigInt(0n, delta),
      moveMax: (held?.moveMax ?? 0n) + maxBigInt(0n, delta),
    };
    const record: UnknownOrderRecord = held
      ? {
          clientId: held.clientId,
          sentAtMs: held.sentAtMs,
          positionBefore: held.positionBefore,
          quarantinedUntilMs: Math.max(
            held.quarantinedUntilMs,
            sentAtMs + LATE_DISPATCH_QUARANTINE_MS,
          ),
          ...widened,
        }
      : {
          clientId: order.clientId,
          sentAtMs,
          positionBefore: account.position,
          quarantinedUntilMs: sentAtMs + LATE_DISPATCH_QUARANTINE_MS,
          ...widened,
        };
    if (!(await this.saveBeforeSending(record))) return;
    const outcome = await this.send(order, account.position, widened);
    const after = await this.readVenue();
    if (after) this.noteAccount(after, maker);
    const moved = after ? after.position - account.position : 0n;
    const unmoved = moved === 0n;

    if (!held) {
      if (outcome === "accepted" && !unmoved) await this.forgetSavedOrder();
      // An accepted order that has not moved the position may still fill: wait for the venue to show it.
      if (outcome === "accepted" && unmoved) {
        this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
        this.unexplained ??= {
          clientId: order.clientId,
          sentAtMs: clock.nowMs(),
          positionBefore: account.position,
          ...widened,
          cancelled: true,
          alerted: false,
          quarantinedUntilMs: 0,
          call: { live: false },
        };
      }
      return;
    }

    const shown =
      outcome === "accepted" &&
      (delta > 0n ? moved > 0n && moved <= delta : moved < 0n && moved >= delta);
    if (shown || outcome === "refused") {
      if (shown) held.positionBefore += moved;
      await this.options.unknownOrders
        .save({
          clientId: held.clientId,
          sentAtMs: held.sentAtMs,
          positionBefore: held.positionBefore,
          quarantinedUntilMs: held.quarantinedUntilMs,
          moveMin: held.moveMin,
          moveMax: held.moveMax,
        })
        .catch(() => {});
      return;
    }
    held.moveMin = widened.moveMin;
    held.moveMax = widened.moveMax;
    if (outcome === "accepted") {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
    }
  }

  /**
   * Reads the saved order once, at the first tick. An order of unknown outcome from before a restart
   * is held again, with the quarantine it had, so it is reconciled against the venue's fills before
   * anything is sent. A file that cannot be read means nothing is sent, and says so once.
   */
  private async restoreSavedOrder(): Promise<boolean> {
    const { unknownOrders, voice, market } = this.options;
    if (this.savedOrderRead) return true;
    try {
      const saved = await unknownOrders.read();
      if (saved) {
        this.unexplained = {
          clientId: saved.clientId,
          sentAtMs: saved.sentAtMs,
          positionBefore: saved.positionBefore,
          moveMin: saved.moveMin,
          moveMax: saved.moveMax,
          cancelled: false,
          alerted: false,
          quarantinedUntilMs: saved.quarantinedUntilMs,
          call: { live: false },
        };
        voice.notice(
          `${market} hedge found an order of unknown outcome from before the restart. ` +
            "It is not sent again, and no new order goes out until the venue's fills have explained it.",
        );
      }
    } catch (error) {
      this.savedOrderUnreadable = true;
      if (!this.savedOrderAlerted) {
        this.savedOrderAlerted = true;
        voice.alert(
          `ALERT ${market} hedge: the saved order file cannot be read (${errorClass(error)}), ` +
            "so the hedge sends nothing. Check the file in the data directory, then restart.",
        );
      }
      return false;
    }
    this.savedOrderUnreadable = false;
    this.savedOrderRead = true;
    return true;
  }

  /**
   * Writes the order to disk before it is sent. When that fails the order is not sent, and the first
   * failure is an alert.
   */
  private async saveBeforeSending(record: UnknownOrderRecord): Promise<boolean> {
    const { unknownOrders, voice, market } = this.options;
    try {
      await unknownOrders.save(record);
    } catch (error) {
      if (!this.saveFailureAlerted) {
        this.saveFailureAlerted = true;
        voice.alert(
          `ALERT ${market} hedge: the order could not be saved to disk (${errorClass(error)}), ` +
            "so it is not sent. The hedge sends nothing until the disk takes a write.",
        );
      }
      return false;
    }
    this.saveFailureAlerted = false;
    return true;
  }

  /**
   * Marks the saved order as explained. A failure here is harmless: the next order overwrites the
   * file before it is sent, and a restart that reads a stale one only holds back for its quarantine.
   */
  private async forgetSavedOrder(): Promise<void> {
    await this.options.unknownOrders.clear().catch(() => {});
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

  /**
   * What became of the order: taken, refused, or of unknown outcome. A refusal or an unclear answer
   * holds back the next order. An unclear answer to a shrink sent while an older order is still
   * unexplained joins that order's hold instead of replacing it.
   */
  private async send(
    order: HedgeOrder,
    positionBefore: bigint,
    move: { moveMin: bigint; moveMax: bigint },
  ): Promise<"accepted" | "refused" | "unknown"> {
    const { venue, voice, market, clock } = this.options;
    const call = { live: true };
    const placing = (async () => venue.placeIoc(order))();
    const settle = () => {
      call.live = false;
    };
    placing.then(settle, settle);
    try {
      const ack = await this.within("an order", () => placing);
      if (ack.status === "accepted") return "accepted";
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.retryAfterRefusalMs;
      voice.notice(`${market} hedge order refused by the venue: ${ack.reason}`);
      if (!this.unexplained) await this.forgetSavedOrder();
      return "refused";
    } catch (error) {
      this.holdUntilMs = clock.nowMs() + HEDGE_LIMITS.settleAfterUnknownMs;
      voice.notice(
        `${market} hedge order has an unknown outcome (${errorClass(error)}). ` +
          "It is not sent again until the venue's position or fills have explained it.",
      );
      voice.alert(
        `ALERT ${market} hedge: an order has an unknown outcome (${errorClass(error)}). ` +
          "No hedge order is sent until the venue's position or fills explain it. " +
          "Check the hedge account by hand if it stays unexplained.",
      );
      const quarantinedUntilMs = clock.nowMs() + LATE_DISPATCH_QUARANTINE_MS;
      const earlier = this.unexplained;
      if (earlier) {
        const earlierCall = earlier.call;
        earlier.call = {
          get live() {
            return earlierCall.live || call.live;
          },
        };
        earlier.quarantinedUntilMs = Math.max(earlier.quarantinedUntilMs, quarantinedUntilMs);
        earlier.cancelled = false;
        const cancelled = await this.within("a cancel", () => venue.cancel(order.clientId)).then(
          () => true,
          () => false,
        );
        if (!cancelled) {
          voice.alert(
            `ALERT ${market} hedge: a shrinking order of unknown outcome could not be cancelled. ` +
              "No hedge order is sent until the venue's position or fills explain it. Check the hedge account by hand.",
          );
        }
        return "unknown";
      }
      this.unexplained = {
        clientId: order.clientId,
        sentAtMs: clock.nowMs(),
        positionBefore,
        ...move,
        cancelled: false,
        alerted: false,
        quarantinedUntilMs,
        call,
      };
      await this.cancelUnexplained(this.unexplained);
    }
    return "unknown";
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
   * through and the settle time has passed. A cancel that fails is retried every tick. An order
   * whose call timed out or failed is held in either case until its late-dispatch quarantine ends
   * and its call has settled, because a call still running may dispatch at any time.
   */
  private async stillUnexplained(account: HedgeAccount): Promise<boolean> {
    const order = this.unexplained;
    if (!order) return false;
    const { venue, clock } = this.options;
    const quarantined = order.call.live || clock.nowMs() < order.quarantinedUntilMs;
    if (account.position !== order.positionBefore && !quarantined) {
      this.unexplained = null;
      await this.forgetSavedOrder();
      return false;
    }
    if (!order.cancelled) await this.cancelUnexplained(order);
    const fills = await this.within("its fills", () => venue.fills(order.sentAtMs)).catch(
      () => null,
    );
    if (fills === null || fills.some((fill) => fill.clientId === order.clientId)) return true;
    if (
      order.cancelled &&
      !quarantined &&
      clock.nowMs() >= order.sentAtMs + HEDGE_LIMITS.settleAfterUnknownMs
    ) {
      this.unexplained = null;
      await this.forgetSavedOrder();
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
    this.unmanaged = position !== 0n;
    if (!this.unmanaged) {
      this.unmanagedAlertedAtMs = null;
      return;
    }
    const nowMs = this.options.clock.nowMs();
    const last = this.unmanagedAlertedAtMs;
    if (last !== null && nowMs - last < UNMANAGED_ALERT_REPEAT_MS) return;
    this.unmanagedAlertedAtMs = nowMs;
    this.options.voice.alert(
      `ALERT ${this.options.market} hedge: the maker is stopped, so the controller trades nothing. ` +
        `The hedge position of ${sol(position)} SOL on the venue is left as it is and is unmanaged. ` +
        "Close it by hand on the venue if it should not stay open.",
    );
  }
}
