import type { Connection, SignatureResult } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProgramRefused, confirmedWithin } from "../src/rollup/transactions.js";

type Status = { confirmationStatus: string; err: unknown } | null;

/** A rollup whose websocket and status reads are scripted, and which counts the reads. */
const fakeRollup = (options: {
  socket: "answers" | "silent" | "down";
  socketAnswersAfterMs?: number;
  socketResult?: SignatureResult;
  statusAfterMs?: number;
  status?: Status;
}) => {
  const startedAt = Date.now();
  const reads = { count: 0 };
  const removed: number[] = [];
  const connection = {
    onSignature: (_signature: string, listener: (result: SignatureResult) => void) => {
      if (options.socket === "down") throw new Error("the websocket is down");
      if (options.socket === "answers") {
        setTimeout(
          () => listener(options.socketResult ?? { err: null }),
          options.socketAnswersAfterMs ?? 0,
        );
      }
      return 7;
    },
    removeSignatureListener: async (id: number) => {
      removed.push(id);
    },
    getSignatureStatus: async () => {
      reads.count += 1;
      const landed = Date.now() - startedAt >= (options.statusAfterMs ?? Infinity);
      return {
        value: landed ? (options.status ?? { confirmationStatus: "confirmed", err: null }) : null,
      };
    },
  } as unknown as Connection;
  return { connection, reads, removed };
};

const settle = (outcome: Promise<string>) =>
  outcome.then(
    (value) => ({ value }),
    (error: Error) => ({ error }),
  );

describe("waiting for a transaction to execute", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("takes the websocket's word, and reads nothing from the rollup", async () => {
    const rollup = fakeRollup({ socket: "answers", socketAnswersAfterMs: 300 });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 30_000));
    await vi.advanceTimersByTimeAsync(400);

    expect(await outcome).toEqual({ value: "sig" });
    expect(rollup.reads.count).toBe(0);
  });

  it("reads the status when the websocket stays silent, and finds the transaction executed", async () => {
    const rollup = fakeRollup({ socket: "silent", statusAfterMs: 1_200 });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 30_000));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await outcome).toEqual({ value: "sig" });
    expect(rollup.reads.count).toBe(2);
    expect(rollup.removed).toEqual([7]);
  });

  it("reads the status when the websocket cannot be opened", async () => {
    const rollup = fakeRollup({ socket: "down", statusAfterMs: 0 });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 30_000));
    await vi.advanceTimersByTimeAsync(1_100);

    expect(await outcome).toEqual({ value: "sig" });
    expect(rollup.reads.count).toBe(1);
  });

  it("does not take a read that shows the transaction only processed", async () => {
    const rollup = fakeRollup({
      socket: "silent",
      statusAfterMs: 0,
      status: { confirmationStatus: "processed", err: null },
    });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 3_000));
    await vi.advanceTimersByTimeAsync(3_500);

    expect((await outcome) as { error: Error }).toHaveProperty("error.message");
  });

  it("reads once more at the deadline before it calls the transaction expired", async () => {
    const rollup = fakeRollup({ socket: "silent", statusAfterMs: 1_999 });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 2_000));
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await outcome).toEqual({ value: "sig" });
  });

  it("expires with its own message when nothing ever shows, after a last read", async () => {
    const rollup = fakeRollup({ socket: "silent" });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 2_000));
    await vi.advanceTimersByTimeAsync(2_100);

    const { error } = (await outcome) as { error: Error };
    expect(error.message).toBe("transaction sig was not confirmed in 2000 ms");
    expect(rollup.reads.count).toBe(3);
    expect(rollup.removed).toEqual([7]);
  });

  it("refuses with the program's error when the websocket reports one", async () => {
    const err = { InstructionError: [0, { Custom: 6038 }] };
    const rollup = fakeRollup({ socket: "answers", socketResult: { err } });
    const outcome = settle(confirmedWithin(rollup.connection, "sig", 30_000));
    await vi.advanceTimersByTimeAsync(10);

    const { error } = (await outcome) as { error: ProgramRefused };
    expect(error).toBeInstanceOf(ProgramRefused);
    expect(error.code).toBe(6038);
    expect(rollup.reads.count).toBe(0);
  });
});
