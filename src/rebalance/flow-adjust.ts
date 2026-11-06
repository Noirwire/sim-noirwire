import type { MakerLedger, MakerState } from "../bots/maker-state.js";

type Limits = Pick<MakerState, "dayStartEquity" | "peakEquity">;

/**
 * The loss limits' reference equity after `delta` moved in (positive) or out (negative) of the
 * seat without any trading result, so a transfer never reads as a gain or a loss. Money sent out
 * lowers both references. Money brought in raises them, but never past the equity the maker
 * holds now: a peak above it would read as a drawdown.
 */
export const shiftedLimits = (limits: Limits, delta: bigint, equity: bigint): Limits => {
  const shift = (reference: bigint | null): bigint | null => {
    if (reference === null) return null;
    const moved = reference + delta;
    if (delta < 0n) return moved > 0n ? moved : 0n;
    const ceiling = equity > reference ? equity : reference;
    return moved < ceiling ? moved : ceiling;
  };
  return { dayStartEquity: shift(limits.dayStartEquity), peakEquity: shift(limits.peakEquity) };
};

/**
 * Counts one completed transfer in the maker's loss limits, once per `flowId`, saved with the
 * limits in the same write. Returns false when the flow was already counted.
 */
export const applyFlow = async (
  ledger: MakerLedger,
  flowId: string,
  delta: bigint,
  equity: bigint,
): Promise<boolean> => {
  if (ledger.state.lastFlowId === flowId) return false;
  await ledger.update({ ...shiftedLimits(ledger.state, delta, equity), lastFlowId: flowId });
  return true;
};

/**
 * Up while a transfer out is leaving the seat and its amount is not yet taken off the loss
 * limits. The loss check waits for it to come down: the equity it would read in between has
 * dropped by the transfer and is no loss.
 */
export class FlowFence {
  private raised = false;

  get active(): boolean {
    return this.raised;
  }

  raise(): void {
    this.raised = true;
  }

  lower(): void {
    this.raised = false;
  }
}
