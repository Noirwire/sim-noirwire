import { readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissing, writeAtomically } from "../bots/maker-state.js";
import type { Clock } from "../engine/clock.js";
import { waitFor } from "../scheduling/backoff.js";
import type { FlowFence } from "./flow-adjust.js";

/** A step that provably did not run, so sending it again is safe. */
export class StepRefused extends Error {
  constructor(what: string) {
    super(what);
    this.name = "StepRefused";
  }
}

/** What the maker does for a transfer out, one at a time. Balances are in quote atoms. */
export interface OutPorts {
  /** The owner's token balance inside the rollup. */
  rollupBalance(): Promise<bigint>;
  /** The owner's token balance on Solana. */
  solanaBalance(): Promise<bigint>;
  /** The owner-signed withdrawal from the seat into the owner's rollup balance. */
  withdrawFromBook(amount: bigint): Promise<string>;
  /** The shuttle that carries exactly `amount` from the rollup balance to the owner's account on Solana. */
  shuttleToSolana(amount: bigint): Promise<string>;
  /** The token transfer of exactly `amount` from the owner's account on Solana to the bridge's. */
  transferToBridge(amount: bigint): Promise<string>;
}

const PHASES = [
  "accepted",
  "withdraw-armed",
  "book-withdrawn",
  "equity-applied",
  "shuttle-armed",
  "on-solana",
  "transfer-armed",
  "sent-to-bridge",
] as const;

const recordSchema = z.object({
  requestId: z.string(),
  amount: z.string().regex(/^\d+$/),
  phase: z.enum(PHASES),
  armedAtMs: z.number(),
  rollupBefore: z.string().regex(/^\d+$/).optional(),
  solanaBefore: z.string().regex(/^\d+$/).optional(),
  signature: z.string().optional(),
});

export type OutRecord = z.infer<typeof recordSchema>;

/** While a withdrawal from the book may have landed and the loss limits do not yet know of it. */
const FENCED = new Set<OutRecord["phase"]>(["withdraw-armed", "book-withdrawn"]);

export type Advance =
  | { kind: "done"; signature: string | undefined }
  | { kind: "waiting"; phase: OutRecord["phase"] }
  | { kind: "failed"; reason: string };

export interface OutFlowOptions {
  path: string;
  ports: OutPorts;
  fence: FlowFence;
  clock: Clock;
  /** Asked once, before the first money moves: false ends the flow with nothing sent. */
  mayWithdraw(amount: bigint): Promise<boolean>;
  /** Takes the withdrawn amount off the loss limits. Called again after a crash until it succeeds; it must count once. */
  onBookWithdrawn(requestId: string, amount: bigint): Promise<void>;
  /** A step with no sign of landing is sent again only after this long: past any blockhash a first try could land under. */
  resendAfterMs?: number;
  /** How long a step is watched for its balance to move before the flow reports waiting. */
  landWaitMs?: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
}

const DEFAULT_RESEND_AFTER_MS = 5 * 60_000;
const DEFAULT_LAND_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 2_000;

/**
 * The maker's side of a transfer out: withdraw from the book, shuttle to Solana, send to the bridge.
 * Each step is saved with a sync before it is sent. After a restart a step that is saved as sent
 * but not as landed is judged by the balances it moves, and sent again only when they have not
 * moved for `resendAfterMs`.
 */
export class OutFlow {
  constructor(private readonly options: OutFlowOptions) {}

  async current(): Promise<OutRecord | null> {
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

  private async save(record: OutRecord | null): Promise<void> {
    await writeAtomically(this.options.path, JSON.stringify(record));
  }

  /** Raises the fence again after a restart that finds a withdrawal the loss limits may not know of. */
  async recover(): Promise<void> {
    const record = await this.current();
    if (record && FENCED.has(record.phase)) this.options.fence.raise();
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
      armedAtMs: this.options.clock.nowMs(),
    });
  }

  /** Clears the journal once the request is closed. */
  async finish(): Promise<void> {
    this.options.fence.lower();
    await this.save(null);
  }

  /** Runs the flow as far as it can go now. */
  async advance(): Promise<Advance> {
    for (;;) {
      const record = await this.current();
      if (!record) return { kind: "failed", reason: "there is no transfer in progress" };
      const result = await this.step(record);
      if (result !== "progress") return result;
    }
  }

  private async step(record: OutRecord): Promise<Advance | "progress"> {
    const { ports, fence, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const resendAfterMs = this.options.resendAfterMs ?? DEFAULT_RESEND_AFTER_MS;
    const stale = now - record.armedAtMs >= resendAfterMs;
    const waiting = (): Advance => ({ kind: "waiting", phase: record.phase });

    switch (record.phase) {
      case "accepted": {
        if (!(await this.options.mayWithdraw(amount))) {
          return { kind: "failed", reason: "the maker may not withdraw now" };
        }
        fence.raise();
        try {
          const rollupBefore = (await ports.rollupBalance()).toString();
          await this.save({ ...record, phase: "withdraw-armed", armedAtMs: now, rollupBefore });
        } catch (error) {
          fence.lower();
          throw error;
        }
        return this.send("withdraw-armed", () => ports.withdrawFromBook(amount), "withdraw");
      }
      case "withdraw-armed": {
        const before = BigInt(record.rollupBefore ?? "0");
        if (await this.landed(async () => (await ports.rollupBalance()) >= before + amount)) {
          await this.save({ ...record, phase: "book-withdrawn" });
          return "progress";
        }
        if (!stale) return waiting();
        return this.send(record.phase, () => ports.withdrawFromBook(amount), "withdraw", record);
      }
      case "book-withdrawn": {
        await this.options.onBookWithdrawn(record.requestId, amount);
        await this.save({ ...record, phase: "equity-applied" });
        fence.lower();
        return "progress";
      }
      case "equity-applied": {
        const solanaBefore = (await ports.solanaBalance()).toString();
        await this.save({ ...record, phase: "shuttle-armed", armedAtMs: now, solanaBefore });
        return this.send("shuttle-armed", () => ports.shuttleToSolana(amount), "shuttle");
      }
      case "shuttle-armed": {
        const before = BigInt(record.solanaBefore ?? "0");
        if (await this.landed(async () => (await ports.solanaBalance()) >= before + amount)) {
          await this.save({ ...record, phase: "on-solana" });
          return "progress";
        }
        if (!stale) return waiting();
        return this.send(record.phase, () => ports.shuttleToSolana(amount), "shuttle", record);
      }
      case "on-solana": {
        const held = await ports.solanaBalance();
        if (held < amount) return waiting();
        await this.save({
          ...record,
          phase: "transfer-armed",
          armedAtMs: now,
          solanaBefore: held.toString(),
        });
        return this.send("transfer-armed", () => ports.transferToBridge(amount), "transfer");
      }
      case "transfer-armed": {
        const before = BigInt(record.solanaBefore ?? "0");
        if (await this.landed(async () => (await ports.solanaBalance()) <= before - amount)) {
          await this.save({ ...record, phase: "sent-to-bridge" });
          return "progress";
        }
        if (!stale) return waiting();
        return this.send(record.phase, () => ports.transferToBridge(amount), "transfer", record);
      }
      case "sent-to-bridge":
        return { kind: "done", signature: record.signature };
    }
  }

  /**
   * Sends one step whose armed record is already saved. A step that provably did not run ends a
   * withdrawal from the book for good, and is tried again later for the others.
   */
  private async send(
    from: OutRecord["phase"],
    action: () => Promise<string>,
    what: "withdraw" | "shuttle" | "transfer",
    rearm?: OutRecord,
  ): Promise<Advance | "progress"> {
    if (rearm) {
      await this.save({ ...rearm, armedAtMs: this.options.clock.nowMs() });
    }
    let signature: string;
    try {
      signature = await action();
    } catch (error) {
      if (error instanceof StepRefused && what === "withdraw" && !rearm) {
        this.options.fence.lower();
        return { kind: "failed", reason: error.message };
      }
      return { kind: "waiting", phase: from };
    }
    if (what === "transfer") {
      const record = await this.current();
      if (record) await this.save({ ...record, signature });
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
