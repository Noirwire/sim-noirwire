import type { SeatRecord } from "../gate/seat-ledger.js";
import type { Session } from "./connections.js";

/** How final a success must be before the gate takes the seat as opened, while its block height can still be reached. */
export const LANDED_COMMITMENT = "finalized";

export type SeatVerdict = "pending" | "landed" | "not-landed";

/**
 * What the chain says about the transactions the gate handed out for a seat.
 *
 * - "pending": one of them can still land (the block height is at or below the
 *   last valid one), one is unresolved (a success below `LANDED_COMMITMENT`,
 *   anything at processed, a failure only at confirmed), or the chain could
 *   not be read.
 * - "landed": one of them succeeded at `LANDED_COMMITMENT` or, the block
 *   height being past the last valid one, at confirmed.
 * - "not-landed": the block height is past the last valid one and every
 *   transaction is absent or failed at finalized.
 *
 * It is the one rule the sweep and `prepare` both settle a seat by.
 */
export const reconcileSeat = async (
  session: Session,
  seat: Pick<SeatRecord, "signatures" | "lastValidBlockHeight">,
  onError: (what: string, error: unknown) => void,
): Promise<SeatVerdict> => {
  const signatures = seat.signatures ?? [];
  const lastValid = seat.lastValidBlockHeight ?? 0;
  try {
    return await session.use(async (connection) => {
      const height = await connection.getBlockHeight("confirmed");
      if (height <= lastValid) return "pending";
      let unresolved = false;
      for (const signature of signatures) {
        const { value } = await connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });
        if (value === null) continue;
        const { confirmationStatus: level, err } = value;
        // The block height is past the last valid one, so a success seen at confirmed settles it too.
        if (!err && (level === LANDED_COMMITMENT || level === "confirmed")) return "landed";
        if (!(err && level === "finalized")) unresolved = true;
      }
      return unresolved ? "pending" : "not-landed";
    });
  } catch (error) {
    onError(
      "reading the chain for an unsettled account opening failed, its seat stays reserved",
      error,
    );
    return "pending";
  }
};
