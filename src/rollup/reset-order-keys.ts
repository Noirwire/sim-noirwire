import type { Keypair } from "@solana/web3.js";
import type { KeyCheckpoint } from "./chain-types.js";

/** One maker whose order keys could be reset: the market it quotes and the owner key of its seat. */
export interface ResetCandidate {
  market: string;
  owner: Keypair;
}

export interface ResetPorts {
  /** Replaces all four order keys of `owner` and returns where they then stand; null when the owner has no seat. */
  reset(owner: Keypair): Promise<KeyCheckpoint | null>;
  /** Saves where `owner`'s keys now stand, so the next start finds a checkpoint. */
  saveCheckpoint(ownerAddress: string, checkpoint: KeyCheckpoint): Promise<void>;
}

export type ResetOutcome =
  | { market: string; owner: string; status: "reset" }
  | { market: string; owner: string; status: "no-seat" }
  | { market: string; owner: string; status: "not-confirmed" }
  | { market: string; owner: string; status: "failed"; reason: string };

/**
 * The operator's deliberate key reset. Nothing is sent for an owner the operator did not name:
 * confirming means typing the owner address, which `describeReset` printed. Every owner is
 * attempted on its own, so one failure does not hide what happened to the others. A reset that
 * landed but could not be recorded is a failure that says so, because the next start would refuse.
 */
export const resetOrderKeys = async (
  candidates: readonly ResetCandidate[],
  confirmed: ReadonlySet<string>,
  ports: ResetPorts,
): Promise<ResetOutcome[]> => {
  const outcomes: ResetOutcome[] = [];
  for (const { market, owner } of candidates) {
    const address = owner.publicKey.toBase58();
    if (!confirmed.has(address)) {
      outcomes.push({ market, owner: address, status: "not-confirmed" });
      continue;
    }
    try {
      const checkpoint = await ports.reset(owner);
      if (!checkpoint) {
        outcomes.push({ market, owner: address, status: "no-seat" });
        continue;
      }
      try {
        await ports.saveCheckpoint(address, checkpoint);
      } catch (error) {
        outcomes.push({
          market,
          owner: address,
          status: "failed",
          reason: `the keys were replaced on chain but the checkpoint was not saved (${error instanceof Error ? error.message : String(error)}); save it by hand or reset again`,
        });
        continue;
      }
      outcomes.push({ market, owner: address, status: "reset" });
    } catch (error) {
      outcomes.push({
        market,
        owner: address,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
};

/** What the command tells an operator who has not confirmed anything yet. */
export const describeReset = (candidates: readonly ResetCandidate[]): string =>
  [
    "This replaces ALL FOUR order keys of each maker seat below with the first four keys of its derivation.",
    "It is signed by the owner key, so any other running copy that holds the same owner key can undo it.",
    "Stop every other instance first, and use it only when the saved checkpoint is gone or no longer fits.",
    "",
    ...candidates.map(({ market, owner }) => `  ${market}  owner ${owner.publicKey.toBase58()}`),
    "",
    "To go ahead, run again and confirm each owner you mean: --confirm <owner address> (repeat the flag).",
  ].join("\n");
