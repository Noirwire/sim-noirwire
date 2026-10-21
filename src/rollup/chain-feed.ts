import type { Connection } from "@solana/web3.js";
import { InFlight } from "../scheduling/in-flight.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { ChainExchange, ChainMarket, ChainPrice, ChainStats } from "./chain-types.js";
import { hangUp } from "./connections.js";
import type { Program } from "./program.js";
import { TapeTracker, type TapeUpdate } from "./tape-tracker.js";

export interface ChainFeedHandlers {
  onPrice(marketId: number, price: ChainPrice): void;
  onTape(marketId: number, update: TapeUpdate, readAtMs: number): void;
  onStats(stats: ChainStats): void;
  /** The market's settings and state: whether it is paused, reduce-only or dislocated. */
  onMarket(market: ChainMarket): void;
  onExchange(exchange: ChainExchange): void;
  onError(what: string, error: unknown): void;
  onRecovered(what: string): void;
  /** Full reads failed in a row: the rollup is not answering. */
  onUnreachable(): void;
}

/** How often every account is read in full, as the safety net under the websocket. */
export const REREAD_INTERVAL_MS = 60_000;
const REREAD_FAILING = "reading the public accounts";
/** Full reads that fail in a row before the rollup counts as away. */
const FAILED_READS_BEFORE_UNREACHABLE = 2;

/**
 * The public accounts of every market, followed over the rollup's websocket:
 * the tape, the price feed, the market itself, the exchange and the stats. A
 * websocket drops notifications while it reconnects, so every account is also
 * read in full on an interval;
 * the tape tracker turns either source into each fill exactly once.
 *
 * Following can be paused and resumed: pausing ends the websocket for good
 * and stops every read, so a paused feed sends nothing, and resuming opens a
 * new connection and reads everything again.
 */
export class ChainFeed {
  private readonly trackers = new Map<number, TapeTracker>();
  private connection: Connection | null = null;
  private readonly reads = new InFlight();
  private rereading: Repeating | null = null;
  private stopped = false;
  private lastReadAtMs = 0;

  constructor(
    private readonly program: Program,
    private readonly connect: () => Connection,
    marketIds: number[],
    private readonly handlers: ChainFeedHandlers,
  ) {
    for (const marketId of marketIds) this.trackers.set(marketId, new TapeTracker());
  }

  /** When every account was last read in full without an error. */
  get readAtMs(): number {
    return this.lastReadAtMs;
  }

  /**
   * Reads everything once, then subscribes and starts the safety-net reads.
   * Throws, having subscribed to nothing, when the first read fails: the
   * caller decides when to try again. Does nothing while already following.
   */
  async follow(): Promise<void> {
    if (this.connection || this.stopped) return;
    const { program, handlers } = this;
    const connection = this.connect();
    this.connection = connection;
    try {
      await this.read(connection);
    } catch (error) {
      if (this.connection === connection) this.pause();
      throw error;
    }
    // Paused or stopped while the first read was under way: that already ended the connection.
    if (this.connection !== connection) return;
    for (const [marketId, tracker] of this.trackers) {
      program.subscribePrice(connection, marketId, (price) => handlers.onPrice(marketId, price));
      program.subscribeTape(connection, marketId, (tape) =>
        handlers.onTape(marketId, tracker.take(tape), Date.now()),
      );
      program.subscribeMarket(connection, marketId, (market) => handlers.onMarket(market));
    }
    program.subscribeExchange(connection, (exchange) => handlers.onExchange(exchange));
    program.subscribeStats(connection, (stats) => handlers.onStats(stats));
    let failedReads = 0;
    this.rereading = every(
      REREAD_INTERVAL_MS,
      () => this.read(connection),
      (error) => {
        handlers.onError(REREAD_FAILING, error);
        failedReads += 1;
        if (failedReads === FAILED_READS_BEFORE_UNREACHABLE) handlers.onUnreachable();
      },
      () => {
        failedReads = 0;
        handlers.onRecovered(REREAD_FAILING);
      },
    );
  }

  private read(connection: Connection): Promise<void> {
    return this.reads.track(this.readEverything(connection));
  }

  /** A read stops asking for more as soon as its connection was ended. */
  private async readEverything(connection: Connection): Promise<void> {
    const { program, handlers } = this;
    const live = (): boolean => this.connection === connection;
    for (const [marketId, tracker] of this.trackers) {
      const price = await program.price(connection, marketId);
      if (!live()) return;
      handlers.onPrice(marketId, price);
      const readAtMs = Date.now();
      const tape = await program.tape(connection, marketId);
      if (!live()) return;
      handlers.onTape(marketId, tracker.take(tape), readAtMs);
      const market = await program.market(connection, marketId);
      if (!live()) return;
      handlers.onMarket(market);
    }
    const exchange = await program.exchange(connection);
    if (!live()) return;
    handlers.onExchange(exchange);
    const stats = await program.stats(connection);
    if (!live()) return;
    handlers.onStats(stats);
    this.lastReadAtMs = Date.now();
  }

  /** Resolves once every read in flight has ended. */
  idle(): Promise<void> {
    return this.reads.idle();
  }

  /**
   * Ends the websocket and every read until `follow` is called again. A read
   * in flight asks for nothing more; `idle` tells when it has ended.
   */
  pause(): void {
    this.rereading?.stop();
    this.rereading = null;
    if (this.connection) hangUp(this.connection);
    this.connection = null;
  }

  stop(): void {
    this.stopped = true;
    this.pause();
  }
}
