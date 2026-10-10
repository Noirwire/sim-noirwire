import type { Connection } from "@solana/web3.js";
import { type Repeating, every } from "../scheduling/repeating.js";
import type { ChainPrice, ChainStats } from "./chain-types.js";
import { hangUp } from "./connections.js";
import type { Program } from "./program.js";
import { TapeTracker, type TapeUpdate } from "./tape-tracker.js";

export interface ChainFeedHandlers {
  onPrice(marketId: number, price: ChainPrice): void;
  onTape(marketId: number, update: TapeUpdate, readAtMs: number): void;
  onStats(stats: ChainStats): void;
  onError(what: string, error: unknown): void;
}

const REREAD_INTERVAL_MS = 5_000;
const FIRST_READ_ATTEMPTS = 5;
const FIRST_READ_RETRY_MS = 2_000;

/**
 * The public accounts of every market, followed over the rollup's websocket:
 * the tape, the price feed and the stats. A websocket drops notifications
 * while it reconnects, so every account is also read in full on an interval;
 * the tape tracker turns either source into each fill exactly once.
 */
export class ChainFeed {
  private readonly trackers = new Map<number, TapeTracker>();
  private rereading: Repeating | null = null;
  private stopped = false;
  private lastReadAtMs = 0;

  constructor(
    private readonly program: Program,
    private readonly connection: Connection,
    marketIds: number[],
    private readonly handlers: ChainFeedHandlers,
  ) {
    for (const marketId of marketIds) this.trackers.set(marketId, new TapeTracker());
  }

  /** When every account was last read in full without an error. */
  get readAtMs(): number {
    return this.lastReadAtMs;
  }

  /** One dropped request over the public internet must not decide whether the service starts. */
  private async firstRead(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.readEverything();
      } catch (error) {
        if (attempt === FIRST_READ_ATTEMPTS) throw error;
        this.handlers.onError("the first read of the public accounts, trying again", error);
        await new Promise((resolve) => setTimeout(resolve, FIRST_READ_RETRY_MS));
      }
    }
  }

  async start(): Promise<void> {
    const { program, connection, handlers } = this;
    await this.firstRead();
    if (this.stopped) return;
    for (const [marketId, tracker] of this.trackers) {
      program.subscribePrice(connection, marketId, (price) => handlers.onPrice(marketId, price));
      program.subscribeTape(connection, marketId, (tape) =>
        handlers.onTape(marketId, tracker.take(tape), Date.now()),
      );
    }
    program.subscribeStats(connection, (stats) => handlers.onStats(stats));
    this.rereading = every(
      REREAD_INTERVAL_MS,
      () => this.readEverything(),
      (error) => handlers.onError("reading the public accounts", error),
    );
  }

  private async readEverything(): Promise<void> {
    const { program, connection, handlers } = this;
    for (const [marketId, tracker] of this.trackers) {
      handlers.onPrice(marketId, await program.price(connection, marketId));
      const readAtMs = Date.now();
      handlers.onTape(marketId, tracker.take(await program.tape(connection, marketId)), readAtMs);
    }
    handlers.onStats(await program.stats(connection));
    this.lastReadAtMs = Date.now();
  }

  stop(): void {
    this.stopped = true;
    this.rereading?.stop();
    this.rereading = null;
    hangUp(this.connection);
  }
}
