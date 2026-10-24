import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isMissing, writeAtomically } from "../bots/maker-state.js";

/**
 * A hedge order that may have reached the venue, saved before it is sent. A restart reads it back,
 * so an order whose outcome was never learned is still not followed by a second one.
 */
export interface UnknownOrderRecord {
  clientId: string;
  sentAtMs: number;
  /** The hedge account's position when the order was sent. */
  positionBefore: bigint;
  /** The order's call may still be dispatched late until then. */
  quarantinedUntilMs: number;
  /**
   * How far the hedge position may still move from `positionBefore` because of orders that are not
   * explained yet, if every one of them filled in full: the sum of the sells, and of the buys.
   */
  moveMin: bigint;
  moveMax: bigint;
}

const amount = z.string().regex(/^-?\d+$/);

const fileSchema = z.object({
  order: z
    .object({
      clientId: z.string().min(1),
      sentAtMs: z.number(),
      positionBefore: amount,
      quarantinedUntilMs: z.number(),
      moveMin: amount,
      moveMax: amount,
    })
    .nullable(),
});

/** The file of one hedge's saved order, in the data directory beside the maker's state. */
export const hedgeOrderPath = (dataDir: string, market: string): string =>
  join(dataDir, `hedge-${market}.json`);

/** Where the hedge keeps the one order it must remember across a restart. */
export interface SavedOrders {
  /** The saved order, or null when none is held. Throws when it cannot be known. */
  read(): Promise<UnknownOrderRecord | null>;
  /** Throws when the record is not safely saved. */
  save(record: UnknownOrderRecord): Promise<void>;
  /** Marks that no order is held. */
  clear(): Promise<void>;
}

/**
 * The saved order on disk. A file that is missing means no order is held. A file that cannot be
 * read or is not valid is thrown, because starting over could send a second order on top of one
 * that already filled.
 */
export class UnknownOrderStore implements SavedOrders {
  constructor(private readonly path: string) {}

  async read(): Promise<UnknownOrderRecord | null> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`the hedge's saved order ${this.path} cannot be read`, { cause: error });
    }
    try {
      const { order } = fileSchema.parse(JSON.parse(text));
      if (order === null) return null;
      return {
        ...order,
        positionBefore: BigInt(order.positionBefore),
        moveMin: BigInt(order.moveMin),
        moveMax: BigInt(order.moveMax),
      };
    } catch (error) {
      throw new Error(`the hedge's saved order ${this.path} is not valid`, { cause: error });
    }
  }

  /** Writes the record, syncs it and syncs the directory. Throws when it is not safely on disk. */
  save(record: UnknownOrderRecord): Promise<void> {
    return this.write({
      ...record,
      positionBefore: record.positionBefore.toString(),
      moveMin: record.moveMin.toString(),
      moveMax: record.moveMax.toString(),
    });
  }

  /** Marks that no order is held. */
  clear(): Promise<void> {
    return this.write(null);
  }

  private write(order: unknown): Promise<void> {
    return writeAtomically(this.path, JSON.stringify({ order }));
  }
}
