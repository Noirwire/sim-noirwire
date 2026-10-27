import type { Clock } from "../engine/clock.js";
import { absBigInt, maxBigInt, minBigInt, mulDivScale, toDecimalString } from "../engine/money.js";
import type { NewOrder } from "../engine/types.js";
import type { HedgeGate, HedgeStatus } from "../hedge/hedge-controller.js";
import { HEDGE_LIMITS } from "../hedge/hedge-limits.js";
import { firstLine } from "../logging/first-line.js";
import type { Reference } from "../prices/reference-price.js";
import { KEEPER_NOT_READ_YET } from "../wiring/keeper-heartbeat.js";
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

/** A line that repeats while a state goes on is said once per this long. */
const SAY_AGAIN_MS = 60_000;

/** A price in dollars with at least two decimals, and no more than it has. */
const dollarsOf = (scaled: bigint): string => {
  const [whole, fraction] = toDecimalString(scaled).split(".");
  return `${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
};

/** The reference prices of the last minute, for the range they have covered. */
export class PriceHistory {
  private points: PricePoint[] = [];

  record(atMs: number, price: bigint): void {
    this.points.push({ atMs, price });
    this.points = this.points.filter(
      (point) => atMs - point.atMs <= MAKER_LIMITS.volatilityWindowMs,
    );
  }

  /** Forgets every price, so a quiet spell has to be seen again. */
  clear(): void {
    this.points = [];
  }

  /** How long ago the oldest price was seen, or 0 with none. */
  oldestAgeMs(nowMs: number): number {
    return this.points.length === 0 ? 0 : nowMs - this.points[0].atMs;
  }

  /**
   * The highest price over the lowest within the last `withinMs`, in bps. Where
   * the prices have a gap of more than `moveWindowMs` just before that window,
   * the last price from before the gap counts too, so a jump across the gap
   * reads as a move and not as a first price.
   */
  rangeBps(withinMs: number, nowMs: number): number {
    const first = this.points.findIndex((point) => nowMs - point.atMs <= withinMs);
    if (first < 0) return 0;
    const bridged =
      first > 0 && this.points[first].atMs - this.points[first - 1].atMs > MAKER_LIMITS.moveWindowMs
        ? first - 1
        : first;
    const prices = this.points.slice(bridged).map((point) => point.price);
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
  /** Whether the liquidation keeper is sweeping. Without it the maker does not look, as it never did. */
  keeper?: { problem(): string | undefined };
}

/**
 * What the risk rules say about quoting right now: the price to quote around
 * and how much wider than usual, or why not to quote. It follows the
 * operator's commands and the loss limits first, since they decide whether
 * the maker may quote at all. A blind hedge, or a liquidation keeper that is
 * not sweeping, makes it pull its quotes and place none until it is back; only
 * a flatten trades the position down.
 */
export class MakerSafety {
  private readonly history = new PriceHistory();
  /** The newest reference price that was good, kept for the loss limits while the reference is down. */
  private lastGood: GoodReference | null = null;
  private pulled = false;
  private pullSaidAtMs = -Infinity;
  /** Whether the next resting ladder is said at once: at the start, after a stop, after a pull that was said. */
  private restingOwed = true;
  private restingSaidAtMs = -Infinity;
  private abandonSaidAtMs = -Infinity;
  /** The exchange readings the newest reference left out of its median. */
  private leftOut: string[] = [];
  private hedgeStatus: HedgeStatus = "ok";
  /** Whether the keeper's problem has been said aloud and not yet cleared. */
  private keeperAlerted = false;

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

    if (!reference.ok) return this.pull(reference.reason);
    this.history.record(now, reference.price);
    this.leftOut = reference.leftOut ?? [];
    const lag = bpsApart(mark, reference.price);
    if (lag > MAKER_LIMITS.markLagPullBps) {
      return this.pull(
        `the mark on NoirWire is ${lag.toFixed(1)} bps away from the reference price, ` +
          "so check that the price crank is running",
      );
    }
    if (this.history.oldestAgeMs(now) < MAKER_LIMITS.moveWindowMs) {
      return this.pull("it is watching the price for 10 s before it quotes", true);
    }
    const moved = this.history.rangeBps(MAKER_LIMITS.moveWindowMs, now);
    if (moved > MAKER_LIMITS.moveBps) {
      return this.pull(`the price moved ${moved.toFixed(1)} bps in 10 s and has not settled`);
    }
    const volatility = this.history.rangeBps(MAKER_LIMITS.volatilityWindowMs, now);
    const widenForLag = lag > MAKER_LIMITS.markLagWidenBps ? lag : 0;
    this.pulled = false;
    const hedge = this.followHedge();
    const keeperDown = this.followKeeper();
    const widenForHedge = hedge === "lagging" ? HEDGE_LIMITS.laggingExtraSpreadBps : 0;
    const reduceOnly = risk.mode !== "run" || hedge === "blind" || keeperDown;
    return {
      action: "quote",
      centre: reference.price,
      extraSpreadBps: volatility * MAKER_LIMITS.volatilityShare + widenForLag + widenForHedge,
      reduceOnly,
      flatten: risk.mode === "flatten",
    };
  }

  /**
   * `orders`, which the venue reports as resting, are the ladder that stands. Said aloud at the
   * first one after the start, after a stop, or after a pull that was said, and otherwise at most
   * once a minute since the last such line, however often the maker flips between pulled and
   * quoting. It names the exchanges the median left out, so a quiet source is not invisible.
   */
  ladderResting(orders: NewOrder[]): void {
    const now = this.options.clock.nowMs();
    if (!this.restingOwed && now - this.restingSaidAtMs < SAY_AGAIN_MS) return;
    this.restingOwed = false;
    this.restingSaidAtMs = now;
    const leftOut = this.leftOut.length > 0 ? ` (${this.leftOut.join("; ")})` : "";
    const prices = (side: NewOrder["side"]): bigint[] =>
      orders.filter((order) => order.side === side).map((order) => order.price ?? 0n);
    const bids = prices("buy");
    const asks = prices("sell");
    const bestBid = bids.length > 0 ? `best bid ${dollarsOf(bids.reduce(maxBigInt))}` : "no bid";
    const bestAsk = asks.length > 0 ? `best ask ${dollarsOf(asks.reduce(minBigInt))}` : "no ask";
    this.options.voice.notice(
      `${this.options.market} maker resting: ${bestBid}, ${bestAsk}, ${orders.length} orders${leftOut}`,
    );
  }

  /** A ladder was dropped because an order of it never ran: said at most once a minute, however often it happens. */
  ladderAbandoned(reason: string | undefined, inARow: number): void {
    const now = this.options.clock.nowMs();
    if (now - this.abandonSaidAtMs < SAY_AGAIN_MS) return;
    this.abandonSaidAtMs = now;
    this.options.voice.notice(
      `${this.options.market} maker dropped a ladder, an order never ran (${reason || "no reason given"}), ${inARow} in a row. It quotes again on the next tick.`,
    );
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
   * Whether the keeper is down, said aloud once when it goes down and once when it is back, however
   * the problem's wording changes in between. A keeper not read yet is down too (the maker fails
   * closed), but it is the normal state just after a start or a wake, so it says nothing by itself.
   */
  private followKeeper(): boolean {
    const problem = this.options.keeper?.problem();
    const { voice, market } = this.options;
    if (problem === undefined) {
      if (this.keeperAlerted) {
        voice.notice(
          `${market} maker: the liquidation keeper is sweeping again, so the keeper no longer limits its quotes`,
        );
      }
      this.keeperAlerted = false;
      return false;
    }
    if (problem !== KEEPER_NOT_READ_YET && !this.keeperAlerted) {
      this.keeperAlerted = true;
      voice.alert(
        `ALERT ${market} maker: the liquidation keeper is not sweeping (${problem}). It pulls its quotes ` +
          "and places none until the keeper's heartbeat is fresh again; only a flatten trades the position down.",
      );
    }
    return true;
  }

  /**
   * Whether the maker may still place a ladder that grows its position: a second look at the
   * keeper just before the orders go out, since `assess` looked once at the start of the tick.
   * It says the same things aloud as `assess` does, and only once between them.
   */
  mayGrow(): boolean {
    return !this.followKeeper();
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
    this.restingOwed = true;
    return { action: "stop" };
  }

  /**
   * Said at most once a minute since the last pull line, whether the pull is new or goes on and
   * whatever its reason is by then, so a feed that flips between good and bad cannot flood the log.
   */
  private pull(reason: string, watching = false): Plan {
    const now = this.options.clock.nowMs();
    // The watch after a cold start is said when it begins and does not use up the minute of the pull lines.
    const due = watching ? !this.pulled : now - this.pullSaidAtMs >= SAY_AGAIN_MS;
    if (due) {
      const still = this.pulled ? " (still pulled)" : "";
      this.options.voice.notice(
        `${this.options.market} maker pulled its quotes${still}: ${reason}`,
      );
      if (!watching) this.pullSaidAtMs = now;
      this.restingOwed = true;
    }
    this.pulled = true;
    return { action: "pull", reason };
  }
}
