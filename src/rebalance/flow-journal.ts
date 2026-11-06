import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissing, writeAtomically } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { waitFor } from "../scheduling/backoff.js";

/** A step that provably did not run, so sending it again is safe. */
export class StepRefused extends Error {
  constructor(what: string) {
    super(what);
    this.name = "StepRefused";
  }
}

export interface FlowRecord {
  requestId: string;
  amount: string;
  phase: string;
  armedAtMs: number;
}

export interface FlowTiming {
  /** A step with no sign of landing is sent again only after this long: past any blockhash a first try could land under. */
  resendAfterMs?: number;
  /** How long a step is watched for its balance to move before the flow reports waiting. */
  landWaitMs?: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface Waiting<R extends FlowRecord> {
  kind: "waiting";
  phase: R["phase"];
}

const DEFAULT_RESEND_AFTER_MS = 5 * 60_000;
const DEFAULT_LAND_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

/** The saved record of one request, and the clock work every flow does around it. */
export class FlowJournal<R extends FlowRecord> {
  private readonly schema: z.ZodType<R | null>;

  constructor(
    private readonly path: string,
    schema: z.ZodType<R>,
    private readonly clock: Clock,
    private readonly timing: FlowTiming,
  ) {
    this.schema = z.union([schema, z.null()]);
  }

  async current(): Promise<R | null> {
    try {
      const text = await readFile(this.path, "utf8");
      return this.schema.parse(JSON.parse(text));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`the rebalance journal ${this.path} cannot be read`, { cause: error });
    }
  }

  async save(record: R | null): Promise<void> {
    await writeAtomically(this.path, JSON.stringify(record));
  }

  /** Starts the journal of an accepted request. A second request is refused while one is unfinished. */
  async begin(requestId: string, amount: bigint): Promise<void> {
    const existing = await this.current();
    if (existing) {
      if (existing.requestId === requestId) return;
      throw new Error(`the rebalance journal still holds unfinished request ${existing.requestId}`);
    }
    await this.save({
      requestId,
      amount: amount.toString(),
      phase: "accepted",
      armedAtMs: this.clock.nowMs(),
    } as R);
  }

  /** Saves the record as armed again now. */
  async rearm(record: R): Promise<void> {
    await this.save({ ...record, armedAtMs: this.clock.nowMs() });
  }

  async landed(check: () => Promise<boolean>): Promise<boolean> {
    const { landWaitMs = DEFAULT_LAND_WAIT_MS, pollMs = DEFAULT_POLL_MS } = this.timing;
    const sleep = this.timing.sleep ?? waitFor;
    const deadline = this.clock.nowMs() + landWaitMs;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (this.clock.nowMs() >= deadline) return false;
      await sleep(pollMs);
    }
  }

  /**
   * One armed step: moves to `next` once `check` sees the balance move, reports waiting while the
   * armed record is younger than the resend delay, and otherwise sends the step again.
   */
  async armed<T>(
    record: R,
    check: () => Promise<boolean>,
    next: R["phase"],
    resend: () => Promise<T>,
  ): Promise<"progress" | Waiting<R> | T> {
    const resendAfterMs = this.timing.resendAfterMs ?? DEFAULT_RESEND_AFTER_MS;
    const stale = this.clock.nowMs() - record.armedAtMs >= resendAfterMs;
    if (await this.landed(check)) {
      await this.save({ ...record, phase: next });
      return "progress";
    }
    if (!stale) return { kind: "waiting", phase: record.phase };
    return resend();
  }
}
