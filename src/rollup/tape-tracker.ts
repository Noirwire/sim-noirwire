import type { ChainFill, ChainTape } from "./program.js";

export interface TapeUpdate {
  /** Fills not seen before, oldest first. */
  fills: ChainFill[];
  /** Fills that left the tape's ring before they could be read. */
  lost: bigint;
}

/**
 * Follows one market's tape by fill sequence number. Every read of the tape
 * account, whether a websocket notification or a plain read after a
 * reconnect, goes through `take`: it returns each fill once, in order, and
 * fills whatever a missed notification skipped from what the account still
 * holds. A reading older than one already taken is ignored.
 */
export class TapeTracker {
  constructor(private lastSequence: bigint = 0n) {}

  get cursor(): bigint {
    return this.lastSequence;
  }

  take(tape: ChainTape): TapeUpdate {
    // A plain read and a notification race: the older picture can arrive last.
    if (tape.lastSequence <= this.lastSequence) return { fills: [], lost: 0n };
    const fills = tape.fills
      .filter((fill) => fill.sequence > this.lastSequence)
      .sort((a, b) => (a.sequence < b.sequence ? -1 : 1));
    const firstReadable = fills[0]?.sequence ?? tape.lastSequence + 1n;
    const lost = firstReadable - (this.lastSequence + 1n);
    this.lastSequence = tape.lastSequence;
    return { fills, lost: lost > 0n ? lost : 0n };
  }
}
