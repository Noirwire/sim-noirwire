import type { Keypair } from "@solana/web3.js";
import type { MarketId } from "../engine/types.js";
import { backoffDelayMs } from "../scheduling/backoff.js";
import { InFlight } from "../scheduling/in-flight.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { Session } from "./connections.js";
import { publishTimeIsNew } from "./price-walk.js";
import type { Program } from "./program.js";
import type { RollupMarket } from "./rollup-market.js";
import { ProgramRefused } from "./transactions.js";
import { within } from "./timeouts.js";

const MS_PER_SECOND = 1_000;
const ROUND_FAILING = "publishing the prices";
/** Rounds that fail in a row before the rollup counts as refusing us. */
const FAILED_ROUNDS_BEFORE_UNREACHABLE = 2;
/**
 * A price whose source answered longer ago than this is never published: a
 * publish is stamped with the rollup's clock, and the program calls a price
 * fresh for ten seconds.
 */
export const MAX_SOURCE_AGE_MS = 10_000;
/** A market the program keeps refusing is left alone for this long at most. */
const LONGEST_REFUSED_PAUSE_MS = 30_000;

export interface PricePublisherOptions {
  program: Pick<Program, "clockSeconds" | "publishPrices" | "updateFunding">;
  oracle: Session;
  oracleKey: Keypair;
  markets: RollupMarket[];
  intervalMs: number;
  /** A price whose source spoke longer ago than this is never published. */
  maxSourceAgeMs: number;
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
  /** Rounds failed in a row for a reason other than the program refusing a market: the rollup is not answering. */
  onUnreachable(): void;
}

interface Published {
  atMs: number;
  /** The publish time of the last publish the program accepted from this process. */
  publishTimeSeconds: number;
  fundingTriedAtMs: number;
  fundingUpdates: number;
  /** How many rounds in a row the program refused this market alone, and when it is tried again. */
  refusals: number;
  retryAtMs: number;
}

/** What one round of publishing did, market by market. */
interface Round {
  published: RollupMarket[];
  /** Left out because the rollup's clock had not moved past the market's last publish, or it is waiting out a refusal. */
  waiting: RollupMarket[];
  /** Left out because there was no recent price from the source to publish. */
  missing: RollupMarket[];
  /** Refused by the program, on its own after the others went through. */
  refused: Map<RollupMarket, Error>;
}

/**
 * Walks every market's price on chain towards its target, one transaction per
 * interval that publishes every market that has a price, and advances each
 * perpetual's funding once per funding interval right after a publish:
 * `update_funding` fails on a stale price, and a rollup scheduler that met
 * one failure stops calling for good, so none is relied on.
 *
 * A publish is stamped with the rollup's clock, so a price is published only
 * while its source is recent: a market with no recent source price is left
 * out, and reported, instead. If the program refuses the transaction, each
 * market is sent again in a transaction of its own in that same round, so one
 * refused instruction does not stop the others; a market that keeps being
 * refused is reported and tried less and less often on its own.
 *
 * A round is given up after a second less than the interval, and the next
 * starts on time whatever became of the last. Two accepted rounds are then
 * never more than the interval plus that timeout apart: 9 s for 5 s, inside the
 * 10 s the program calls a price fresh. Work in flight when `stop` is called is
 * tracked in `idle`, and sends nothing more once it was asked to stop.
 */
export class PricePublisher {
  private readonly published = new Map<MarketId, Published>();
  private loop: Repeating | null = null;
  private halted = false;
  private readonly inFlight = new InFlight();
  private readonly roundMs: number;

  constructor(private readonly options: PricePublisherOptions) {
    this.roundMs = Math.max(MS_PER_SECOND, options.intervalMs - MS_PER_SECOND);
    for (const market of options.markets) {
      this.published.set(market.config.id, {
        atMs: 0,
        publishTimeSeconds: 0,
        fundingTriedAtMs: 0,
        fundingUpdates: 0,
        refusals: 0,
        retryAtMs: 0,
      });
    }
  }

  private failing(market: RollupMarket): string {
    return `publishing the ${market.config.id} price`;
  }

  /**
   * Publishes every market's price now, from a source price delivered at or
   * after `sourceNotBeforeMs`. Throws, after reporting each one, unless every
   * market was published: a price on chain that this call did not establish
   * is not a fresh one, and a service that has none is not awake.
   */
  async publishNow(sourceNotBeforeMs: number): Promise<void> {
    this.halted = false;
    for (const published of this.published.values()) published.retryAtMs = 0;
    const { onError, onRecovered } = this.options;
    const round = await this.inFlight.track(this.round(sourceNotBeforeMs));
    for (const market of round.published) onRecovered(this.failing(market));
    for (const market of round.waiting) {
      onError(
        this.failing(market),
        new Error("the rollup's clock has not moved since the last publish"),
      );
    }
    this.reportUnpublished(round);
    const left = this.options.markets.filter((market) => !round.published.includes(market));
    if (left.length > 0) {
      throw new Error(
        `the first prices could not be published for ${left.map((market) => market.config.id).join(", ")}`,
      );
    }
  }

  /** Publishes every market's price once per interval. Does nothing while already publishing. */
  start(): void {
    if (this.loop) return;
    this.halted = false;
    const { intervalMs, onError, onRecovered, onUnreachable } = this.options;
    let failedRounds = 0;
    this.loop = every(
      intervalMs,
      () => this.publishRound(),
      (error) => {
        onError(ROUND_FAILING, error);
        failedRounds += 1;
        if (failedRounds === FAILED_ROUNDS_BEFORE_UNREACHABLE) onUnreachable();
      },
      () => {
        failedRounds = 0;
        onRecovered(ROUND_FAILING);
      },
      // A price goes stale in 10 s: a failed round is followed by a try on the next tick.
      { pauseAfterFailure: false },
    );
  }

  /** Stops the loop and every publish in flight from sending anything more. */
  stop(): void {
    this.halted = true;
    this.loop?.stop();
    this.loop = null;
  }

  /** Resolves once every publish and funding update in flight has ended. */
  idle(): Promise<void> {
    return this.inFlight.idle();
  }

  private of(market: RollupMarket): Published {
    const published = this.published.get(market.config.id);
    if (!published) throw new Error(`${market.config.id} is not a market this publisher was given`);
    return published;
  }

  /** When this process last had a publish of `market` accepted, or 0. */
  lastPublishedAtMs(market: RollupMarket): number {
    return this.of(market).atMs;
  }

  /** Per perpetual, how often this process has advanced its funding since it started. */
  fundingUpdates(): Record<MarketId, number> {
    const counts: Record<MarketId, number> = {};
    for (const market of this.options.markets) {
      if (market.chain.kind === "perp") counts[market.config.id] = this.of(market).fundingUpdates;
    }
    return counts;
  }

  private noPrice(market: RollupMarket): Error {
    const seconds = Math.round(this.options.maxSourceAgeMs / MS_PER_SECOND);
    return new Error(
      `no price to publish for ${market.config.id}: the price source has not answered in the last ${seconds} s`,
    );
  }

  private reportUnpublished(round: Round): void {
    const { onError } = this.options;
    for (const market of round.missing) onError(this.failing(market), this.noPrice(market));
    for (const [market, error] of round.refused) onError(this.failing(market), error);
  }

  /** One round from the loop: a market left out is reported, and the others still go. */
  private async publishRound(): Promise<void> {
    const { onRecovered } = this.options;
    const round = await this.inFlight.track(this.round(0));
    for (const market of round.published) onRecovered(this.failing(market));
    this.reportUnpublished(round);
  }

  private async round(sourceNotBeforeMs: number): Promise<Round> {
    const { program, oracle, oracleKey, maxSourceAgeMs } = this.options;
    const now = Date.now();
    const round: Round = { published: [], waiting: [], missing: [], refused: new Map() };
    const ready: { market: RollupMarket; price: bigint }[] = [];
    for (const market of this.options.markets) {
      const price = market.nextPublishPrice(now, maxSourceAgeMs, sourceNotBeforeMs);
      if (price === null) round.missing.push(market);
      else if (this.of(market).retryAtMs > now) round.waiting.push(market);
      else ready.push({ market, price });
    }
    if (this.halted) return round;
    if (ready.length === 0) {
      // Nothing to publish still asks the rollup for its clock: a round that sends nothing must not read as a rollup that answers.
      await within(
        oracle.use((connection) => program.clockSeconds(connection)),
        this.roundMs,
        ROUND_FAILING,
      );
      return round;
    }

    let abandoned = false;
    const stopped = (): boolean => this.halted || abandoned;
    const accepted = await within(
      oracle.use(async (connection) => {
        const clockSeconds = await program.clockSeconds(connection);
        if (stopped()) return [];
        const due = ready.filter(({ market }) => {
          const lastAccepted = Math.max(
            this.of(market).publishTimeSeconds,
            market.publishTimeSeconds,
          );
          const isDue = publishTimeIsNew(clockSeconds, lastAccepted);
          if (!isDue) round.waiting.push(market);
          return isDue;
        });
        const sent: RollupMarket[] = [];
        // What a publish did is recorded here, where it happens: a round given up
        // while one of its sends was still on its way must not leave the state
        // behind a publish that landed.
        const send = async (batch: typeof due): Promise<void> => {
          await program.publishPrices(
            connection,
            oracleKey,
            batch.map(({ market, price }) => ({ marketId: market.chain.marketId, price })),
            clockSeconds,
            this.roundMs,
          );
          for (const { market } of batch) {
            const published = this.of(market);
            published.publishTimeSeconds = clockSeconds;
            published.atMs = Date.now();
            published.refusals = 0;
            sent.push(market);
            void this.inFlight.track(this.advanceFunding(market));
          }
        };
        const refuse = (market: RollupMarket, error: Error): void => {
          const published = this.of(market);
          published.refusals += 1;
          published.retryAtMs =
            Date.now() +
            backoffDelayMs(published.refusals, {
              baseMs: 2 * this.options.intervalMs,
              maxMs: LONGEST_REFUSED_PAUSE_MS,
            });
          round.refused.set(market, error);
        };
        try {
          if (due.length > 0) await send(due);
        } catch (error) {
          if (!(error instanceof ProgramRefused)) throw error;
          // The program refused something in the bundle: each market goes alone to find what.
          for (const entry of due) {
            if (stopped()) break;
            try {
              await send([entry]);
            } catch (alone) {
              if (!(alone instanceof ProgramRefused)) throw alone;
              refuse(entry.market, alone);
            }
          }
        }
        return sent;
      }),
      this.roundMs,
      ROUND_FAILING,
    ).catch((error: unknown) => {
      abandoned = true;
      throw error;
    });
    round.published = accepted;
    return round;
  }

  private async advanceFunding(market: RollupMarket): Promise<void> {
    const { program, oracle, oracleKey, onError } = this.options;
    const published = this.of(market);
    const intervalMs = market.chain.fundingIntervalSeconds * MS_PER_SECOND;
    if (
      this.halted ||
      market.chain.kind !== "perp" ||
      Date.now() - published.fundingTriedAtMs < intervalMs
    ) {
      return;
    }
    published.fundingTriedAtMs = Date.now();
    try {
      await oracle.use((connection) =>
        program.updateFunding(connection, oracleKey, market.chain.marketId),
      );
      published.fundingUpdates += 1;
    } catch (error) {
      published.fundingTriedAtMs = 0;
      onError(`advancing ${market.config.id} funding`, error);
    }
  }
}
