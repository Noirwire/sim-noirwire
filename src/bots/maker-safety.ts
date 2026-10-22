import type { Clock } from "../engine/clock.js";
import { absBigInt } from "../engine/money.js";
import type { Reference } from "../prices/reference-price.js";
import { MAKER_LIMITS } from "./maker-limits.js";
import type { MakerControl } from "./maker-control.js";
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
      /** Quote only the side that shrinks the position. */
      reduceOnly: boolean;
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

export interface MakerSafetyOptions {
  reference: { read(): Promise<Reference> };
  risk: MakerRisk;
  control: MakerControl;
  clock: Clock;
  voice: MakerVoice;
  market: string;
}

/**
 * What the risk rules say about quoting right now: the price to quote around
 * and how much wider than usual, or why not to quote. It follows the
 * operator's commands and the loss limits first, since they decide whether
 * the maker may quote at all.
 */
export class MakerSafety {
  private readonly history = new PriceHistory();
  private pulled = false;

  constructor(private readonly options: MakerSafetyOptions) {}

  async assess(mark: bigint, equity: bigint): Promise<Plan> {
    const { risk, control, clock } = this.options;
    await risk.follow(await control.read(), equity);
    await risk.check(equity);
    if (risk.mode === "stopped") {
      this.history.clear();
      return { action: "stop" };
    }
    if (equity <= 0n) return this.pull("its seat holds no equity to quote with");

    const reference = await this.options.reference.read();
    if (!reference.ok) {
      this.history.clear();
      return this.pull(reference.reason);
    }
    const now = clock.nowMs();
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
    return {
      action: "quote",
      centre: reference.price,
      extraSpreadBps: volatility * MAKER_LIMITS.volatilityShare + widenForLag,
      reduceOnly: risk.mode === "reduce",
    };
  }

  /** Stops the maker for good, until an operator resumes it. */
  stopFor(reason: string): Promise<void> {
    return this.options.risk.stopFor(reason);
  }

  private pull(reason: string): Plan {
    if (!this.pulled) {
      this.options.voice.notice(`${this.options.market} maker pulled its quotes: ${reason}`);
    }
    this.pulled = true;
    return { action: "pull", reason };
  }
}
