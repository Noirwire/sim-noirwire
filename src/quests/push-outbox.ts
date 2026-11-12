import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../engine/clock.js";
import { type Backoff, backoffDelayMs } from "../scheduling/backoff.js";
import { JsonFile } from "./json-file.js";

const REQUEST_TIMEOUT_MS = 10_000;
const REJECTED_RETRY_MS = 60 * 60_000;
const OUTAGE_BACKOFF: Backoff = { baseMs: 30_000, maxMs: 15 * 60_000 };
const FIRST_SUCCESS = 200;
const FIRST_REDIRECT = 300;
const HTTP_UNAUTHORIZED = 401;
const FIRST_CLIENT_ERROR = 400;
const FIRST_SERVER_ERROR = 500;

const entrySchema = z.object({
  id: z.string(),
  wallet: z.string(),
  questId: z.string(),
  week: z.number().int(),
  nextAttemptAtMs: z.number(),
  /** After this a quest MagicBlock keeps refusing is let go. */
  giveUpAtMs: z.number(),
  failures: z.number().int(),
});
const fileSchema = z.object({
  entries: z.array(entrySchema),
  lastTimestampMs: z.number(),
});

export type OutboxEntry = z.infer<typeof entrySchema>;
type OutboxFile = z.infer<typeof fileSchema>;

export interface NewOutboxEntry {
  wallet: string;
  questId: string;
  week: number;
  giveUpAtMs: number;
}

export interface PushOutboxOptions {
  path: string;
  clock: Clock;
  url: string;
  apiKey: string;
  fetch: typeof fetch;
  onError(what: string, error: unknown): void;
}

/**
 * Quest completions waiting to be pushed to MagicBlock, one request at a time. It lives on disk,
 * so a restart picks up where it was, and every timestamp it sends is greater than the last.
 * What it logs names an entry by a random id, never by quest, wallet or key.
 */
export class PushOutbox {
  private readonly file: JsonFile<OutboxFile>;
  private entries: OutboxEntry[];
  private lastTimestampMs: number;
  private pushing: Promise<void> | null = null;
  private halted = false;

  constructor(private readonly options: PushOutboxOptions) {
    this.file = new JsonFile(options.path, fileSchema, () => ({
      entries: [],
      lastTimestampMs: 0,
    }));
    const stored = this.file.load();
    this.entries = stored.entries;
    this.lastTimestampMs = stored.lastTimestampMs;
  }

  /**
   * Adds an entry unless the same wallet, quest and week is already waiting, and starts pushing.
   * Resolves once the entry is on disk.
   */
  enqueue(entry: NewOutboxEntry): Promise<void> {
    const waiting = this.entries.some(
      (other) =>
        other.wallet === entry.wallet &&
        other.questId === entry.questId &&
        other.week === entry.week,
    );
    if (waiting) return this.save();
    this.entries.push({
      ...entry,
      id: randomBytes(4).toString("hex"),
      nextAttemptAtMs: this.options.clock.nowMs(),
      failures: 0,
    });
    const saved = this.save();
    void saved
      .then(() => this.pushDue())
      .catch((error: unknown) => this.options.onError("pushing quests", error));
    return saved;
  }

  /** Resolves once the push under way has ended. */
  async idle(): Promise<void> {
    await this.pushing;
  }

  /** Sends every entry that is due, one at a time. Does nothing after the key was refused. */
  pushDue(): Promise<void> {
    if (this.pushing) return this.pushing;
    if (this.halted) return Promise.resolve();
    this.pushing = this.pushEveryDueEntry().finally(() => {
      this.pushing = null;
    });
    return this.pushing;
  }

  private nextDue(): OutboxEntry | undefined {
    const now = this.options.clock.nowMs();
    return this.entries.find((entry) => entry.nextAttemptAtMs <= now);
  }

  private async pushEveryDueEntry(): Promise<void> {
    for (let entry = this.nextDue(); entry && !this.halted; entry = this.nextDue()) {
      await this.push(entry);
    }
  }

  private async push(entry: OutboxEntry): Promise<void> {
    const timestamp = Math.max(this.options.clock.nowMs(), this.lastTimestampMs + 1);
    this.lastTimestampMs = timestamp;
    await this.save();
    const status = await this.send(entry, timestamp);
    const now = this.options.clock.nowMs();
    if (status !== null && status >= FIRST_SUCCESS && status < FIRST_REDIRECT) {
      this.entries = this.entries.filter((other) => other !== entry);
    } else if (status === HTTP_UNAUTHORIZED) {
      this.halted = true;
      this.options.onError(
        "MagicBlock refused the quests API key (401): no quest is pushed until the key is fixed and the service restarts",
        new Error("status 401"),
      );
    } else {
      this.options.onError(
        `quest push ${entry.id}`,
        new Error(status === null ? "no answer" : `status ${status}`),
      );
      entry.failures += 1;
      if (status !== null && status >= FIRST_CLIENT_ERROR && status < FIRST_SERVER_ERROR) {
        this.retryHourly(entry, now);
      } else {
        entry.nextAttemptAtMs = now + backoffDelayMs(entry.failures, OUTAGE_BACKOFF);
      }
    }
    await this.save();
  }

  private retryHourly(entry: OutboxEntry, nowMs: number): void {
    if (nowMs >= entry.giveUpAtMs) {
      this.options.onError(`quest push ${entry.id} dropped: MagicBlock never took it`, null);
      this.entries = this.entries.filter((other) => other !== entry);
      return;
    }
    entry.nextAttemptAtMs = Math.min(nowMs + REJECTED_RETRY_MS, entry.giveUpAtMs);
  }

  /** The response status, or null when no answer came. */
  private async send(entry: OutboxEntry, timestamp: number): Promise<number | null> {
    try {
      const response = await this.options.fetch(this.options.url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          payload: { quest: Number(entry.questId), user: entry.wallet, timestamp },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => {});
      return response.status;
    } catch {
      return null;
    }
  }

  private save(): Promise<void> {
    return this.file.save({ entries: this.entries, lastTimestampMs: this.lastTimestampMs });
  }
}
