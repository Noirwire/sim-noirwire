import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Clock } from "../engine/clock.js";
import { DAY_MS } from "../engine/day-window.js";

/** "opened": the rollup confirmed the seat. "unconfirmed": the transaction was sent and its fate is not known. */
export type SeatState = "opened" | "unconfirmed";

export interface SeatRecord {
  invite: string;
  owner: string;
  atMs: number;
  state: SeatState;
  /**
   * A keyed hash of the address that asked, so a limit per address survives a
   * restart without keeping the address. The key is in a file of its own, and
   * the hash is dropped once the UTC day it counts for is over.
   */
  asker?: string;
  /**
   * The gate's signature on each transaction handed out for this seat while it is
   * unconfirmed (each is also the transaction's id on the chain), and the last block
   * height at which any of them could still land. They are what settles a seat that
   * was never submitted, also after a restart.
   */
  signatures?: string[];
  lastValidBlockHeight?: number;
}

interface SeatFile {
  seats: SeatRecord[];
}

const KEY_TEXT = /^[0-9a-f]{64}$/;

const utcDay = (atMs: number): number => Math.floor(atMs / DAY_MS);

const isRecord = (value: unknown): value is SeatRecord => {
  const record = value as Partial<SeatRecord> | null;
  return (
    typeof record?.invite === "string" &&
    typeof record.owner === "string" &&
    typeof record.atMs === "number" &&
    (record.asker === undefined || typeof record.asker === "string") &&
    (record.signatures === undefined ||
      (Array.isArray(record.signatures) &&
        record.signatures.every((entry) => typeof entry === "string"))) &&
    (record.lastValidBlockHeight === undefined ||
      typeof record.lastValidBlockHeight === "number") &&
    (record.state === "opened" || record.state === "unconfirmed")
  );
};

/**
 * Every seat the gate has signed for, kept on disk. It is what makes an
 * invite open at most one seat, and what the daily limits count, so it is
 * never reset by a restart: a file that exists and cannot be read stops the
 * start rather than forgetting who already has a seat.
 */
export class SeatLedger {
  private records: SeatRecord[];
  private saving: Promise<void> = Promise.resolve();
  private key: string | null;
  private readonly keyPath: string;

  constructor(
    private readonly path: string,
    private readonly clock: Clock,
  ) {
    this.keyPath = `${path}.key`;
    this.key = this.loadKey();
    this.records = this.load();
    this.forgetOldAskers();
  }

  /** The key the addresses are hashed with, or null before the first seat is reserved. */
  private loadKey(): string | null {
    let text: string;
    try {
      text = readFileSync(this.keyPath, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(
        `the gate's key file at ${this.keyPath} cannot be read. Fix its permissions, or delete it and start again: ` +
          "today's count of seats per network address then starts over.",
      );
    }
    if (!KEY_TEXT.test(text)) {
      throw new Error(
        `the gate's key file at ${this.keyPath} is not in the form this service writes. ` +
          "Delete it and start again: today's count of seats per network address then starts over.",
      );
    }
    return text;
  }

  /** Creates the key, readable by this service alone, the first time a seat is reserved. */
  private async ensureKey(): Promise<string> {
    if (this.key !== null) return this.key;
    const fresh = randomBytes(32).toString("hex");
    await mkdir(dirname(this.keyPath), { recursive: true });
    await writeFile(this.keyPath, `${fresh}\n`, { mode: 0o600, flag: "wx" });
    this.key = fresh;
    return fresh;
  }

  private askerOf(ip: string, key: string): string {
    return createHmac("sha256", key).update(ip).digest("hex").slice(0, 16);
  }

  /** An address is only needed for the day it counts in. Older records keep their seat and lose the hash. */
  private forgetOldAskers(): void {
    const today = utcDay(this.clock.nowMs());
    for (const record of this.records) {
      if (utcDay(record.atMs) < today) delete record.asker;
    }
  }

  private load(): SeatRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(
        `the gate's seat record at ${this.path} cannot be read. Fix its permissions or restore it from a backup: ` +
          "the gate will not start without it, because it would forget who already has a seat.",
      );
    }
    let parsed: Partial<SeatFile> = {};
    try {
      parsed = JSON.parse(text.trim() || '{"seats":[]}') as Partial<SeatFile>;
    } catch {
      // Falls through to the form check below, which says what to do.
    }
    if (!Array.isArray(parsed.seats) || !parsed.seats.every(isRecord)) {
      throw new Error(
        `the gate's seat record at ${this.path} is not in the form this service writes. ` +
          "Restore it from a backup: the gate will not start without it, because it would forget who already has a seat.",
      );
    }
    return parsed.seats;
  }

  /** The record of this invite, if a seat was ever signed for it. */
  forInvite(invite: string): SeatRecord | undefined {
    return this.records.find((record) => record.invite === invite);
  }

  /** The seat `owner` holds, as far as this service knows. */
  openedFor(owner: string): SeatRecord | undefined {
    return this.records.find((record) => record.owner === owner && record.state === "opened");
  }

  /** Seats signed for in the UTC day of `nowMs`, not counting those under `except`. */
  seatsToday(nowMs: number, except?: string): number {
    return this.today(nowMs, except).length;
  }

  /** As `seatsToday`, for one asker. */
  seatsTodayFor(ip: string, nowMs: number, except?: string): number {
    if (this.key === null) return 0;
    const asker = this.askerOf(ip, this.key);
    return this.today(nowMs, except).filter((record) => record.asker === asker).length;
  }

  private today(nowMs: number, except?: string): SeatRecord[] {
    return this.records.filter(
      (record) => record.invite !== except && utcDay(record.atMs) === utcDay(nowMs),
    );
  }

  /** Makes the key the addresses are hashed with, so that `reserve` has nothing to wait for. */
  async ready(): Promise<void> {
    await this.ensureKey();
  }

  /** Seats sent and not confirmed, with the signatures that say whether they landed. */
  awaitingSettlement(): SeatRecord[] {
    return this.records.filter(
      (record) => record.state === "unconfirmed" && (record.signatures?.length ?? 0) > 0,
    );
  }

  /**
   * Seats reserved at or before `cutoffMs` with no transaction ever recorded for them. A transaction
   * is handed out only after `track` has saved its signature, so nothing was sent for these.
   */
  reservedWithoutTransaction(cutoffMs: number): SeatRecord[] {
    return this.records.filter(
      (record) =>
        record.state === "unconfirmed" &&
        (record.signatures?.length ?? 0) === 0 &&
        record.atMs <= cutoffMs,
    );
  }

  /**
   * Records a seat as sent and saves it. Throws if it cannot be saved: nothing may be signed unrecorded.
   * Call `ready` first: with the key made, the record is in memory before this first waits, so a
   * decision made just before it cannot be overtaken. The signatures of an earlier try for the same
   * invite are kept.
   */
  async reserve(invite: string, owner: string, ip: string, nowMs: number): Promise<void> {
    const asker = this.askerOf(ip, this.key ?? (await this.ensureKey()));
    const replaced = this.forInvite(invite);
    const record: SeatRecord = { invite, owner, atMs: nowMs, state: "unconfirmed", asker };
    if (replaced?.signatures) record.signatures = replaced.signatures;
    if (replaced?.lastValidBlockHeight !== undefined) {
      record.lastValidBlockHeight = replaced.lastValidBlockHeight;
    }
    this.records = this.records.filter((entry) => entry.invite !== invite);
    this.records.push(record);
    try {
      await this.save();
    } catch (error) {
      this.records = this.records.filter((entry) => entry !== record);
      if (replaced) this.records.push(replaced);
      throw error;
    }
  }

  /** Adds a transaction handed out for this seat. Throws, changing nothing, if it cannot be saved. */
  async track(invite: string, signature: string, lastValidBlockHeight: number): Promise<void> {
    const record = this.forInvite(invite);
    if (!record) throw new Error("no seat is reserved for this invite");
    const before = {
      signatures: record.signatures,
      lastValidBlockHeight: record.lastValidBlockHeight,
    };
    record.signatures = [...(record.signatures ?? []), signature];
    record.lastValidBlockHeight = Math.max(record.lastValidBlockHeight ?? 0, lastValidBlockHeight);
    try {
      await this.save();
    } catch (error) {
      Object.assign(record, before);
      throw error;
    }
  }

  /** The rollup confirmed the seat. */
  async confirm(invite: string): Promise<void> {
    const record = this.forInvite(invite);
    if (record) {
      record.state = "opened";
      delete record.signatures;
      delete record.lastValidBlockHeight;
    }
    await this.save();
  }

  /** The seat was not opened: the invite and the day's count are free again. */
  async release(invite: string): Promise<void> {
    this.records = this.records.filter((record) => record.invite !== invite);
    await this.save();
  }

  private save(): Promise<void> {
    this.forgetOldAskers();
    const text = JSON.stringify({ seats: this.records } satisfies SeatFile);
    const write = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, text);
      await rename(`${this.path}.tmp`, this.path);
    });
    this.saving = write.catch(() => {});
    return write;
  }
}
