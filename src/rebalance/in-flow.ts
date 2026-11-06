import { z } from "zod";
import type { Clock } from "../engine/clock.js";
import { FlowJournal, type FlowTiming, StepRefused } from "./flow-journal.js";

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

type Step = InAdvance | "progress";

export interface InFlowOptions extends FlowTiming {
  path: string;
  ports: InPorts;
  clock: Clock;
  /** Counts the deposited amount in the loss limits. Called again after a crash until it succeeds; it must count once. */
  onDeposited(requestId: string, amount: bigint): Promise<void>;
}

/**
 * The maker's side of a transfer in: the bridge has put USDC on the maker's own account on Solana,
 * and the maker carries it into the rollup and deposits it into its seat. Each step is saved
 * before it is sent; after a restart a step is judged by the balances it moves and sent again only
 * when they have not moved for `resendAfterMs`.
 */
export class InFlow {
  private readonly journal: FlowJournal<InRecord>;

  constructor(private readonly options: InFlowOptions) {
    this.journal = new FlowJournal(options.path, recordSchema, options.clock, options);
  }

  current(): Promise<InRecord | null> {
    return this.journal.current();
  }

  begin(requestId: string, amount: bigint): Promise<void> {
    return this.journal.begin(requestId, amount);
  }

  async finish(): Promise<void> {
    await this.journal.save(null);
  }

  async advance(): Promise<InAdvance> {
    for (;;) {
      const record = await this.current();
      if (!record) return { kind: "done" };
      const result = await this.step(record);
      if (result !== "progress") return result;
    }
  }

  private step(record: InRecord): Promise<Step> | Step {
    switch (record.phase) {
      case "accepted":
        return this.accepted(record);
      case "shuttle-armed":
        return this.shuttleArmed(record);
      case "in-rollup":
        return this.inRollup(record);
      case "deposit-armed":
        return this.depositArmed(record);
      case "deposited":
        return this.deposited(record);
      case "equity-applied":
        return { kind: "done" };
    }
  }

  private async accepted(record: InRecord): Promise<Step> {
    const { ports, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const solanaBefore = (await ports.solanaBalance()).toString();
    await this.journal.save({ ...record, phase: "shuttle-armed", armedAtMs: now, solanaBefore });
    return this.send(record, "accepted", () => ports.shuttleToRollup(amount));
  }

  private shuttleArmed(record: InRecord): Promise<Step> {
    const { ports } = this.options;
    const amount = BigInt(record.amount);
    const before = BigInt(record.solanaBefore ?? "0");
    return this.journal.armed(
      record,
      async () => (await ports.solanaBalance()) <= before - amount,
      "in-rollup",
      () => this.send(record, record.phase, () => ports.shuttleToRollup(amount), true),
    );
  }

  private async inRollup(record: InRecord): Promise<Step> {
    const { ports, clock } = this.options;
    const amount = BigInt(record.amount);
    const now = clock.nowMs();
    const held = await ports.rollupBalance();
    if (held < amount) return { kind: "waiting", phase: record.phase };
    await this.journal.save({
      ...record,
      phase: "deposit-armed",
      armedAtMs: now,
      rollupBefore: held.toString(),
    });
    return this.send(record, "in-rollup", () => ports.depositToBook(amount));
  }

  private depositArmed(record: InRecord): Promise<Step> {
    const { ports } = this.options;
    const amount = BigInt(record.amount);
    const before = BigInt(record.rollupBefore ?? "0");
    return this.journal.armed(
      record,
      async () => (await ports.rollupBalance()) <= before - amount,
      "deposited",
      () => this.send(record, record.phase, () => ports.depositToBook(amount), true),
    );
  }

  private async deposited(record: InRecord): Promise<Step> {
    await this.options.onDeposited(record.requestId, BigInt(record.amount));
    await this.journal.save({ ...record, phase: "equity-applied" });
    return "progress";
  }

  /** Sends one step whose armed record is saved. A step that provably did not run goes back to `undo`. */
  private async send(
    record: InRecord,
    undo: InRecord["phase"],
    action: () => Promise<string>,
    rearm = false,
  ): Promise<Step> {
    if (rearm) await this.journal.rearm(record);
    try {
      await action();
    } catch (error) {
      if (error instanceof StepRefused && !rearm) {
        await this.journal.save({ ...record, phase: undo });
        return { kind: "waiting", phase: undo };
      }
      return { kind: "waiting", phase: record.phase };
    }
    return "progress";
  }
}
