import { z } from "zod";
import type { Clock } from "../engine/clock.js";
import type { FlowFence } from "./flow-adjust.js";
import { FlowJournal, type FlowTiming, StepRefused } from "./flow-journal.js";

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

type Step = Advance | "progress";

export interface OutFlowOptions extends FlowTiming {
  path: string;
  ports: OutPorts;
  fence: FlowFence;
  clock: Clock;
  /** Asked once, before the first money moves: false ends the flow with nothing sent. */
  mayWithdraw(amount: bigint): Promise<boolean>;
  /** Takes the withdrawn amount off the loss limits. Called again after a crash until it succeeds; it must count once. */
  onBookWithdrawn(requestId: string, amount: bigint): Promise<void>;
}

/**
 * The maker's side of a transfer out: withdraw from the book, shuttle to Solana, send to the bridge.
 * Each step is saved with a sync before it is sent. After a restart a step that is saved as sent
 * but not as landed is judged by the balances it moves, and sent again only when they have not
 * moved for `resendAfterMs`.
 */
export class OutFlow {
  private readonly journal: FlowJournal<OutRecord>;

  constructor(private readonly options: OutFlowOptions) {
    this.journal = new FlowJournal(options.path, recordSchema, options.clock, options);
  }

  current(): Promise<OutRecord | null> {
    return this.journal.current();
  }

  /** Raises the fence again after a restart that finds a withdrawal the loss limits may not know of. */
  async recover(): Promise<void> {
    const record = await this.current();
    if (record && FENCED.has(record.phase)) this.options.fence.raise();
  }

  /** Starts the journal of an accepted request. A second request is refused while one is unfinished. */
  begin(requestId: string, amount: bigint): Promise<void> {
    return this.journal.begin(requestId, amount);
  }

  /** Clears the journal once the request is closed. */
  async finish(): Promise<void> {
    this.options.fence.lower();
    await this.journal.save(null);
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

  private step(record: OutRecord): Promise<Step> | Step {
    switch (record.phase) {
      case "accepted":
        return this.accepted(record);
      case "withdraw-armed":
        return this.withdrawArmed(record);
      case "book-withdrawn":
        return this.bookWithdrawn(record);
      case "equity-applied":
        return this.equityApplied(record);
      case "shuttle-armed":
        return this.shuttleArmed(record);
      case "on-solana":
        return this.onSolana(record);
      case "transfer-armed":
        return this.transferArmed(record);
      case "sent-to-bridge":
        return { kind: "done", signature: record.signature };
    }
  }

  private async accepted(record: OutRecord): Promise<Step> {
    const { ports, fence, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    if (!(await this.options.mayWithdraw(amount))) {
      return { kind: "failed", reason: "the maker may not withdraw now" };
    }
    fence.raise();
    try {
      const rollupBefore = (await ports.rollupBalance()).toString();
      await this.journal.save({ ...record, phase: "withdraw-armed", armedAtMs: now, rollupBefore });
    } catch (error) {
      fence.lower();
      throw error;
    }
    return this.send("withdraw-armed", () => ports.withdrawFromBook(amount), "withdraw");
  }

  private withdrawArmed(record: OutRecord): Promise<Step> {
    const { ports } = this.options;
    const amount = BigInt(record.amount);
    const before = BigInt(record.rollupBefore ?? "0");
    return this.journal.armed(
      record,
      async () => (await ports.rollupBalance()) >= before + amount,
      "book-withdrawn",
      () => this.send(record.phase, () => ports.withdrawFromBook(amount), "withdraw", record),
    );
  }

  private async bookWithdrawn(record: OutRecord): Promise<Step> {
    await this.options.onBookWithdrawn(record.requestId, BigInt(record.amount));
    await this.journal.save({ ...record, phase: "equity-applied" });
    this.options.fence.lower();
    return "progress";
  }

  private async equityApplied(record: OutRecord): Promise<Step> {
    const { ports, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const solanaBefore = (await ports.solanaBalance()).toString();
    await this.journal.save({ ...record, phase: "shuttle-armed", armedAtMs: now, solanaBefore });
    return this.send("shuttle-armed", () => ports.shuttleToSolana(amount), "shuttle");
  }

  private shuttleArmed(record: OutRecord): Promise<Step> {
    const { ports } = this.options;
    const amount = BigInt(record.amount);
    const before = BigInt(record.solanaBefore ?? "0");
    return this.journal.armed(
      record,
      async () => (await ports.solanaBalance()) >= before + amount,
      "on-solana",
      () => this.send(record.phase, () => ports.shuttleToSolana(amount), "shuttle", record),
    );
  }

  private async onSolana(record: OutRecord): Promise<Step> {
    const { ports, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const held = await ports.solanaBalance();
    if (held < amount) return { kind: "waiting", phase: record.phase };
    await this.journal.save({
      ...record,
      phase: "transfer-armed",
      armedAtMs: now,
      solanaBefore: held.toString(),
    });
    return this.send("transfer-armed", () => ports.transferToBridge(amount), "transfer");
  }

  private transferArmed(record: OutRecord): Promise<Step> {
    const { ports } = this.options;
    const amount = BigInt(record.amount);
    const before = BigInt(record.solanaBefore ?? "0");
    return this.journal.armed(
      record,
      async () => (await ports.solanaBalance()) <= before - amount,
      "sent-to-bridge",
      () => this.send(record.phase, () => ports.transferToBridge(amount), "transfer", record),
    );
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
  ): Promise<Step> {
    if (rearm) await this.journal.rearm(rearm);
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
      if (record) await this.journal.save({ ...record, signature });
    }
    return "progress";
  }
}
