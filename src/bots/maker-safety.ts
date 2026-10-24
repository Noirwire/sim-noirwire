import type { Clock } from "../engine/clock.js";
import { absBigInt, mulDivScale } from "../engine/money.js";
import type { HedgeGate, HedgeStatus } from "../hedge/hedge-controller.js";
import { HEDGE_LIMITS } from "../hedge/hedge-limits.js";
import { firstLine } from "../logging/first-line.js";
import type { Reference } from "../prices/reference-price.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import type { ControlCommand, MakerControl } from "./maker-control.js";
import type { MakerRisk, MakerVoice } from "./maker-risk.js";

/** What the maker does this tick. */
export type Plan =
  /** Quote nothing, and stay that way until an operator resumes it. */
  | { action: "stop" }
  /** Quote nothing for now: the cause passes by itself. */
  | { action: "pull"; reason: string }
  | {
      action: "quote";
      /** Quote around this price. */
      centre: bigint;
      /** Added to every level's half-spread. */
      extraSpreadBps: number;
      /** Only reduce: pull the quotes and place none (only `flatten` trades the position down). */
      reduceOnly: boolean;
      /** Work the position down to flat with reduce-only orders at a bounded price through `centre`. */
      flatten?: boolean;
    };

interface PricePoint {
  atMs: number;
  price: bigint;
}

const SCALE_OF_BPS = 10_000_000n;

/** The reference prices of the last minute, for the range they have covered. */
export class PriceHistory {
  private points: PricePoint[] = [];

  record(atMs: number, price: bigint): void {
    this.points.push({ atMs, price });
    this.points = this.points.filter(
      (point) => atMs - point.atMs <= MAKER_LIMITS.volatilityWindowMs,
    );
  }

  /** A gap in the prices starts the history over, so a quiet spell has to be seen again. */
  clear(): void {
    this.points = [];
  }

  /** How long ago the oldest price was seen, or 0 with none. */
  oldestAgeMs(nowMs: number): number {
    return this.points.length === 0 ? 0 : nowMs - this.points[0].atMs;
  }

  /** The highest price over the lowest within the last `withinMs`, in bps. */
  rangeBps(withinMs: number, nowMs: number): number {
    const prices = this.points
      .filter((point) => nowMs - point.atMs <= withinMs)
      .map((point) => point.price);
    if (prices.length < 2) return 0;
    const low = prices.reduce((a, b) => (a < b ? a : b));
    const high = prices.reduce((a, b) => (a > b ? a : b));
    return Number(((high - low) * SCALE_OF_BPS) / low) / 1_000;
  }
}

/** How far apart two prices are, in bps of the second. */
export const bpsApart = (price: bigint, against: bigint): number =>
  Number((absBigInt(price - against) * SCALE_OF_BPS) / against) / 1_000;

/** The seat's equity, given at the venue's `mark`, valued at `price` instead. */
export const equityAtPrice = (
  equity: bigint,
  position: bigint,
  mark: bigint,
  price: bigint,
): bigint => equity + mulDivScale(position, price - mark);

/**
 * The seat's equity at the venue's mark, or at the reference price when that
 * is worse for the maker. The mark may lag the reference, and a loss counted
 * at a lagging mark would be counted late.
 */
export const worstEquity = (
  equity: bigint,
  position: bigint,
  mark: bigint,
  reference: bigint,
): bigint => {
  const atReference = equityAtPrice(equity, position, mark, reference);
  return atReference < equity ? atReference : equity;
};

/** The equity the loss limits are counted at, and whether the maker is blind. */
interface RailsView {
  equity: bigint;
  /** The reference is down and was not good at any time in the last hour. */
  blind: boolean;
}

interface GoodReference {
  atMs: number;
  price: bigint;
}

export interface MakerSafetyOptions {
  reference: { read(): Promise<Reference> };
  risk: MakerRisk;
  control: MakerControl;
  clock: Clock;
  voice: MakerVoice;
  market: string;
  /** Where the maker's exposure is hedged outside. Without it the maker is unhedged, as it always was. */
  hedge?: HedgeGate;
}

/**
 * What the risk rules say about quoting right now: the price to quote around
 * and how much wider than usual, or why not to quote. It follows the
 * operator's commands and the loss limits first, since they decide whether
 * the maker may quote at all.
 */
export class MakerSafety {
  private readonly history = new PriceHistory();
  /** The newest reference price that was good, kept for the loss limits while the reference is down. */
  private lastGood: GoodReference | null = null;
  private pulled = false;
  private hedgeStatus: HedgeStatus = "ok";

  constructor(private readonly options: MakerSafetyOptions) {}

  /**
   * `equity` and `position` are the seat's, at the venue's `mark`. The loss
   * limits are counted at the worse of that mark and the reference price, and
   * while the reference is down as `railsView` says.
   */
  async assess(mark: bigint, equity: bigint, position: bigint): Promise<Plan> {
    const { risk, clock } = this.options;
    await risk.follow(await this.command(), equity);
    if (this.isStopped()) return this.stop();

    const reference = await this.options.reference.read();
    const now = clock.nowMs();
    const view = this.railsView(reference, now, mark, equity, position);
    if (reference.ok) this.lastGood = { atMs: now, price: reference.price };
    await risk.check(view.equity, position, view.blind);
    if (this.isStopped()) return this.stop();
    if (equity <= 0n) return this.pull("its seat holds no equity to quote with");

    if (!reference.ok) {
      this.history.clear();
      return this.pull(reference.reason);
    }
    this.history.record(now, reference.price);
    const lag = bpsApart(mark, reference.price);
    if (lag > MAKER_LIMITS.markLagPullBps) {
      return this.pull(
        `the mark on NoirWire is ${lag.toFixed(1)} bps away from the reference price, ` +
          "so check that the price crank is running",
      );
    }
    if (this.history.oldestAgeMs(now) < MAKER_LIMITS.moveWindowMs) {
      return this.pull("it is watching the price for 10 s before it quotes");
    }
    const moved = this.history.rangeBps(MAKER_LIMITS.moveWindowMs, now);
    if (moved > MAKER_LIMITS.moveBps) {
      return this.pull(`the price moved ${moved.toFixed(1)} bps in 10 s and has not settled`);
    }
    const volatility = this.history.rangeBps(MAKER_LIMITS.volatilityWindowMs, now);
    const widenForLag = lag > MAKER_LIMITS.markLagWidenBps ? lag : 0;
    if (this.pulled) this.options.voice.notice(`${this.options.market} maker is quoting again`);
    this.pulled = false;
    const hedge = this.followHedge();
    const widenForHedge = hedge === "lagging" ? HEDGE_LIMITS.laggingExtraSpreadBps : 0;
    return {
      action: "quote",
      centre: reference.price,
      extraSpreadBps: volatility * MAKER_LIMITS.volatilityShare + widenForLag + widenForHedge,
      reduceOnly: risk.mode !== "run" || hedge === "blind",
      flatten: risk.mode === "flatten",
    };
  }

  /**
   * The hedge's status, said aloud when it changes. A lagging hedge widens the
   * quotes; a blind one makes the maker pull its quotes. Both end by themselves once the venue confirms the hedge again.
   */
  private followHedge(): HedgeStatus {
    const status = this.options.hedge?.status() ?? "ok";
    if (status === this.hedgeStatus) return status;
    this.hedgeStatus = status;
    const { voice, market } = this.options;
    if (status === "blind") {
      voice.alert(
        `ALERT ${market} maker: its hedge is blind (the hedge venue cannot be reached, or the unhedged ` +
          "exposure is past the hard limit). It stops growing its position and pulls its quotes, " +
          "until the hedge is confirmed again.",
      );
    } else if (status === "lagging") {
      voice.notice(
        `${market} maker: its hedge is lagging, so it quotes ${HEDGE_LIMITS.laggingExtraSpreadBps} bps wider until the venue confirms it`,
      );
    } else {
      voice.notice(`${market} maker: its hedge is confirmed again, so it quotes normally`);
    }
    return status;
  }

  /**
   * What the loss limits are counted at. With a good reference price, the
   * worse of the venue's mark and that price. While the reference is down the
   * mark may be stale, so: with a good reference price from the last hour, at
   * that price alone; without one, at the worse of the mark and the last good
   * price there ever was (the mark alone if there never was one), and the
   * maker is blind, which shortens a flattening's deadline.
   */
  private railsView(
    reference: Reference,
    nowMs: number,
    mark: bigint,
    equity: bigint,
    position: bigint,
  ): RailsView {
    if (reference.ok) {
      return { equity: worstEquity(equity, position, mark, reference.price), blind: false };
    }
    const good = this.lastGood;
    if (good === null) return { equity, blind: true };
    if (nowMs - good.atMs <= MAKER_LIMITS.referenceMemoryMs) {
      return { equity: equityAtPrice(equity, position, mark, good.price), blind: false };
    }
    return { equity: worstEquity(equity, position, mark, good.price), blind: true };
  }

  /**
   * The maker met an error it does not understand: it falls back to the soft
   * stop, or stops altogether if it was already flattening, or has met such
   * errors repeatedly at the soft stop. Either lasts until an operator
   * resumes it.
   */
  stopFor(reason: string): Promise<void> {
    return this.options.risk.stopFor(reason);
  }

  /** Tells the operator something that needs a human. */
  alert(message: string): void {
    this.options.voice.alert(`ALERT ${this.options.market} maker: ${message}`);
  }

  /** A requote went out in full: the unknown errors before it were not a run of them. */
  requoteSucceeded(): void {
    this.options.risk.requoteSucceeded();
  }

  /**
   * The operator's newest command. A control file that cannot be read holds
   * the maker at the soft stop and is not a command.
   */
  private async command(): Promise<ControlCommand | null> {
    try {
      return await this.options.control.read();
    } catch (error) {
      await this.options.risk.holdFor(firstLine(error));
      return null;
    }
  }

  private isStopped(): boolean {
    return this.options.risk.mode === "stopped";
  }

  private stop(): Plan {
    this.history.clear();
    return { action: "stop" };
  }

  private pull(reason: string): Plan {
    if (!this.pulled) {
      this.options.voice.notice(`${this.options.market} maker pulled its quotes: ${reason}`);
    }
    this.pulled = true;
    return { action: "pull", reason };
  }
}
