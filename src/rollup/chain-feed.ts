import type { Connection } from "@solana/web3.js";
import type { ChainPrice, ChainStats, Program, Unsubscribe } from "./program.js";
import { TapeTracker, type TapeUpdate } from "./tape-tracker.js";

export interface ChainFeedHandlers {
  onPrice(marketId: number, price: ChainPrice): void;
  onTape(marketId: number, update: TapeUpdate, readAtMs: number): void;
  onStats(stats: ChainStats): void;
  onError(what: string, error: unknown): void;
}

const REREAD_INTERVAL_MS = 5_000;

/**
 * The public accounts of every market, followed over the rollup's websocket:
 * the tape, the price feed and the stats. A websocket drops notifications
 * while it reconnects, so every account is also read in full on an interval;
 * the tape tracker turns either source into each fill exactly once.
 */
export class ChainFeed {
  private readonly trackers = new Map<number, TapeTracker>();
  private readonly unsubscribes: Unsubscribe[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private rereading = false;
  private lastReadAtMs = 0;

  constructor(
    private readonly program: Program,
    private readonly connection: Connection,
    private readonly marketIds: number[],
    private readonly handlers: ChainFeedHandlers,
  ) {
    for (const marketId of marketIds) this.trackers.set(marketId, new TapeTracker());
  }

  /** When every account was last read in full without an error. */
  get readAtMs(): number {
    return this.lastReadAtMs;
  }

  async start(): Promise<void> {
    await this.readEverything();
    for (const marketId of this.marketIds) {
      this.unsubscribes.push(
        this.program.subscribePrice(this.connection, marketId, (price) =>
          this.handlers.onPrice(marketId, price),
        ),
        this.program.subscribeTape(this.connection, marketId, (tape) =>
          this.handlers.onTape(marketId, this.trackers.get(marketId)!.take(tape), Date.now()),
        ),
      );
    }
    this.unsubscribes.push(
      this.program.subscribeStats(this.connection, (stats) => this.handlers.onStats(stats)),
    );
    this.timer = setInterval(() => void this.reread(), REREAD_INTERVAL_MS);
  }

  private async reread(): Promise<void> {
    if (this.rereading) return;
    this.rereading = true;
    try {
      await this.readEverything();
    } catch (error) {
      this.handlers.onError("reading the public accounts", error);
    } finally {
      this.rereading = false;
    }
  }

  private async readEverything(): Promise<void> {
    for (const marketId of this.marketIds) {
      this.handlers.onPrice(marketId, await this.program.price(this.connection, marketId));
      const readAtMs = Date.now();
      const tape = await this.program.tape(this.connection, marketId);
      this.handlers.onTape(marketId, this.trackers.get(marketId)!.take(tape), readAtMs);
    }
    this.handlers.onStats(await this.program.stats(this.connection));
    this.lastReadAtMs = Date.now();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.unsubscribes.map((unsubscribe) => unsubscribe()));
  }
}
