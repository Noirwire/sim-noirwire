import type { Keypair } from "@solana/web3.js";
import type { MarketId } from "../engine/types.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { Session } from "./connections.js";
import { publishTimeIsNew } from "./price-walk.js";
import type { Program } from "./program.js";
import type { RollupMarket } from "./rollup-market.js";

const MS_PER_SECOND = 1_000;

export interface PricePublisherOptions {
  program: Pick<Program, "clockSeconds" | "publishPrice" | "updateFunding">;
  oracle: Session;
  oracleKey: Keypair;
  markets: RollupMarket[];
  intervalMs: number;
  onError(what: string, error: unknown): void;
}

interface Published {
  atMs: number;
  /** The publish time of the last publish the program accepted from this process. */
  publishTimeSeconds: number;
  fundingTriedAtMs: number;
  fundingUpdates: number;
}

/**
 * Walks every market's price on chain towards its target, one publish per
 * interval and market, and advances each perpetual's funding once per funding
 * interval right after a publish: `update_funding` fails on a stale price,
 * and a rollup scheduler that met one failure stops calling for good, so none
 * is relied on.
 */
export class PricePublisher {
  private readonly published = new Map<MarketId, Published>();
  private loops: Repeating[] = [];

  constructor(private readonly options: PricePublisherOptions) {
    for (const market of options.markets) {
      this.published.set(market.config.id, {
        atMs: 0,
        publishTimeSeconds: 0,
        fundingTriedAtMs: 0,
        fundingUpdates: 0,
      });
    }
  }

  start(): void {
    const { markets, intervalMs, onError } = this.options;
    this.loops = markets.map((market) =>
      every(
        intervalMs,
        () => this.publishOnce(market),
        (error) => onError(`publishing the ${market.config.id} price`, error),
      ),
    );
  }

  stop(): void {
    for (const loop of this.loops) loop.stop();
    this.loops = [];
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

  /** Publishes the market's next price, unless the rollup's clock has not moved since the last one. */
  async publishOnce(market: RollupMarket): Promise<void> {
    const { program, oracle, oracleKey } = this.options;
    const price = market.nextPublishPrice();
    if (price === null) return;
    const published = this.of(market);
    const accepted = await oracle.use(async (connection) => {
      const clockSeconds = await program.clockSeconds(connection);
      const lastAccepted = Math.max(published.publishTimeSeconds, market.publishTimeSeconds);
      if (!publishTimeIsNew(clockSeconds, lastAccepted)) return false;
      await program.publishPrice(connection, oracleKey, market.chain.marketId, price, clockSeconds);
      published.publishTimeSeconds = clockSeconds;
      return true;
    });
    if (!accepted) return;
    published.atMs = Date.now();
    void this.advanceFunding(market);
  }

  private async advanceFunding(market: RollupMarket): Promise<void> {
    const { program, oracle, oracleKey, onError } = this.options;
    const published = this.of(market);
    const intervalMs = market.chain.fundingIntervalSeconds * MS_PER_SECOND;
    if (market.chain.kind !== "perp" || Date.now() - published.fundingTriedAtMs < intervalMs) {
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
