import { Keypair } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import type { KeyCheckpoint } from "../src/rollup/chain-types.js";
import {
  type ResetCandidate,
  describeReset,
  resetOrderKeys,
} from "../src/rollup/reset-order-keys.js";

const candidate = (market: string): ResetCandidate => ({ market, owner: Keypair.generate() });
const addressOf = ({ owner }: ResetCandidate): string => owner.publicKey.toBase58();
const CHECKPOINT: KeyCheckpoint = { indices: [0, 1, 2, 3], nextIndex: 4 };

describe("the operator's explicit order key reset", () => {
  it("sends nothing until an owner is confirmed by its address, and lists what it would do", async () => {
    const [first, second] = [candidate("NSOL-PERP"), candidate("OTHER-PERP")];
    const reset = vi.fn(async () => CHECKPOINT);
    const saveCheckpoint = vi.fn(async () => {});

    const outcomes = await resetOrderKeys([first, second], new Set(), { reset, saveCheckpoint });

    expect(outcomes.map(({ status }) => status)).toEqual(["not-confirmed", "not-confirmed"]);
    expect(reset).not.toHaveBeenCalled();
    const text = describeReset([first, second]);
    expect(text).toContain(addressOf(first));
    expect(text).toContain(addressOf(second));
    expect(text).toContain("--confirm");
    expect(text).toContain("Stop every other instance");
  });

  it("resets and records the checkpoint of exactly the owner that was confirmed", async () => {
    const [first, second] = [candidate("NSOL-PERP"), candidate("OTHER-PERP")];
    const reset = vi.fn(async () => CHECKPOINT);
    const saveCheckpoint = vi.fn(async () => {});

    const outcomes = await resetOrderKeys([first, second], new Set([addressOf(second)]), {
      reset,
      saveCheckpoint,
    });

    expect(outcomes).toEqual([
      { market: "NSOL-PERP", owner: addressOf(first), status: "not-confirmed" },
      { market: "OTHER-PERP", owner: addressOf(second), status: "reset" },
    ]);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(second.owner);
    expect(saveCheckpoint).toHaveBeenCalledWith(addressOf(second), CHECKPOINT);
  });

  it("says there is no seat to reset, and records nothing", async () => {
    const only = candidate("NSOL-PERP");
    const saveCheckpoint = vi.fn(async () => {});

    const outcomes = await resetOrderKeys([only], new Set([addressOf(only)]), {
      reset: async () => null,
      saveCheckpoint,
    });

    expect(outcomes[0]?.status).toBe("no-seat");
    expect(saveCheckpoint).not.toHaveBeenCalled();
  });

  it("reports a send that failed, and still tries the next owner", async () => {
    const [first, second] = [candidate("NSOL-PERP"), candidate("OTHER-PERP")];
    const reset = vi
      .fn<(owner: Keypair) => Promise<KeyCheckpoint | null>>()
      .mockRejectedValueOnce(new Error("the rollup refused"))
      .mockResolvedValueOnce(CHECKPOINT);

    const outcomes = await resetOrderKeys(
      [first, second],
      new Set([addressOf(first), addressOf(second)]),
      { reset, saveCheckpoint: async () => {} },
    );

    expect(outcomes[0]).toMatchObject({ status: "failed", reason: "the rollup refused" });
    expect(outcomes[1]?.status).toBe("reset");
  });

  it("calls a reset that landed but could not be recorded a failure that says the keys moved", async () => {
    const only = candidate("NSOL-PERP");

    const [outcome] = await resetOrderKeys([only], new Set([addressOf(only)]), {
      reset: async () => CHECKPOINT,
      saveCheckpoint: async () => {
        throw new Error("disk full");
      },
    });

    expect(outcome).toMatchObject({ status: "failed" });
    expect((outcome as { reason: string }).reason).toContain("replaced on chain");
    expect((outcome as { reason: string }).reason).toContain("disk full");
  });
});
