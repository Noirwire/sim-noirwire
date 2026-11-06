import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissing, writeAtomically } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { waitFor } from "../scheduling/backoff.js";
import { StepRefused } from "./out-flow.js";

/** What the maker does to bring a bridge delivery from its wallet into its seat. Balances are in quote atoms. */
export interface InPorts {
  /** The owner's token balance inside the rollup. */
  rollupBalance(): Promise<bigint>;
  /** The owner's token balance on Solana. */
  solanaBalance(): Promise<bigint>;
  /** The transfer of exactly `amount` from the owner's account on Solana into the owner's rollup balance. */
  shuttleToRollup(amount: bigint): Promise<string>;
  /** The owner-signed deposit of exactly `amount` from the owner's rollup balance into the seat's collateral. */
  depositToBook(amount: bigint): Promise<string>;
}

const PHASES = [
  "accepted",
  "shuttle-armed",
  "in-rollup",
  "deposit-armed",
  "deposited",
  "equity-applied",
] as const;

const recordSchema = z.object({
  requestId: z.string(),
  amount: z.string().regex(/^\d+$/),
  phase: z.enum(PHASES),
  armedAtMs: z.number(),
  rollupBefore: z.string().regex(/^\d+$/).optional(),
  solanaBefore: z.string().regex(/^\d+$/).optional(),
});

export type InRecord = z.infer<typeof recordSchema>;

export type InAdvance = { kind: "done" } | { kind: "waiting"; phase: InRecord["phase"] };

export interface InFlowOptions {
  path: string;
  ports: InPorts;
  clock: Clock;
  /** Counts the deposited amount in the loss limits. Called again after a crash until it succeeds; it must count once. */
  onDeposited(requestId: string, amount: bigint): Promise<void>;
  /** A step with no sign of landing is sent again only after this long. */
  resendAfterMs?: number;
  landWaitMs?: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_RESEND_AFTER_MS = 5 * 60_000;
const DEFAULT_LAND_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

/**
 * The maker's side of a transfer in: the bridge has put USDC on the maker's own account on Solana,
 * and the maker carries it into the rollup and deposits it into its seat. Each step is saved
 * before it is sent; after a restart a step is judged by the balances it moves and sent again only
 * when they have not moved for `resendAfterMs`.
 */
export class InFlow {
  constructor(private readonly options: InFlowOptions) {}

  async current(): Promise<InRecord | null> {
    try {
      const text = await readFile(this.options.path, "utf8");
      return z.union([recordSchema, z.null()]).parse(JSON.parse(text));
    } catch (error) {
      if (isMissing(error)) return null;
      throw new Error(`the rebalance journal ${this.options.path} cannot be read`, {
        cause: error,
      });
    }
  }

  private async save(record: InRecord | null): Promise<void> {
    await writeAtomically(this.options.path, JSON.stringify(record));
  }

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
      armedAtMs: this.options.clock.nowMs(),
    });
  }

  async finish(): Promise<void> {
    await this.save(null);
  }

  async advance(): Promise<InAdvance> {
    for (;;) {
      const record = await this.current();
      if (!record) return { kind: "done" };
      const result = await this.step(record);
      if (result !== "progress") return result;
    }
  }

  private async step(record: InRecord): Promise<InAdvance | "progress"> {
    const { ports, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const resendAfterMs = this.options.resendAfterMs ?? DEFAULT_RESEND_AFTER_MS;
    const stale = now - record.armedAtMs >= resendAfterMs;
    const waiting = (): InAdvance => ({ kind: "waiting", phase: record.phase });

    switch (record.phase) {
      case "accepted": {
        const solanaBefore = (await ports.solanaBalance()).toString();
        await this.save({ ...record, phase: "shuttle-armed", armedAtMs: now, solanaBefore });
        return this.send(record, "accepted", () => ports.shuttleToRollup(amount));
      }
      case "shuttle-armed": {
        const before = BigInt(record.solanaBefore ?? "0");
        if (await this.landed(async () => (await ports.solanaBalance()) <= before - amount)) {
          await this.save({ ...record, phase: "in-rollup" });
          return "progress";
        }
        if (!stale) return waiting();
        return this.send(record, record.phase, () => ports.shuttleToRollup(amount), true);
      }
      case "in-rollup": {
        const held = await ports.rollupBalance();
        if (held < amount) return waiting();
        await this.save({
          ...record,
          phase: "deposit-armed",
          armedAtMs: now,
          rollupBefore: held.toString(),
        });
        return this.send(record, "in-rollup", () => ports.depositToBook(amount));
      }
      case "deposit-armed": {
        const before = BigInt(record.rollupBefore ?? "0");
        if (await this.landed(async () => (await ports.rollupBalance()) <= before - amount)) {
          await this.save({ ...record, phase: "deposited" });
          return "progress";
        }
        if (!stale) return waiting();
        return this.send(record, record.phase, () => ports.depositToBook(amount), true);
      }
      case "deposited": {
        await this.options.onDeposited(record.requestId, amount);
        await this.save({ ...record, phase: "equity-applied" });
        return "progress";
      }
      case "equity-applied":
        return { kind: "done" };
    }
  }

  /** Sends one step whose armed record is saved. A step that provably did not run goes back to `undo`. */
  private async send(
    record: InRecord,
    undo: InRecord["phase"],
    action: () => Promise<string>,
    rearm = false,
  ): Promise<InAdvance | "progress"> {
    if (rearm) await this.save({ ...record, armedAtMs: this.options.clock.nowMs() });
    try {
      await action();
    } catch (error) {
      if (error instanceof StepRefused && !rearm) {
        await this.save({ ...record, phase: undo });
        return { kind: "waiting", phase: undo };
      }
      return { kind: "waiting", phase: record.phase };
    }
    return "progress";
  }

  private async landed(check: () => Promise<boolean>): Promise<boolean> {
    const { landWaitMs = DEFAULT_LAND_WAIT_MS, pollMs = DEFAULT_POLL_MS } = this.options;
    const sleep = this.options.sleep ?? waitFor;
    const deadline = this.options.clock.nowMs() + landWaitMs;
    for (;;) {
      if (await check().catch(() => false)) return true;
      if (this.options.clock.nowMs() >= deadline) return false;
      await sleep(pollMs);
    }
  }
}
