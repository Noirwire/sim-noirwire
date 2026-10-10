import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { every } from "../src/scheduling/repeating.js";

describe("a repeating task", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("skips a turn while the run before it is still going, and takes the next one after", async () => {
    let started = 0;
    let finishRun = (): void => {};
    const loop = every(
      1_000,
      () => {
        started += 1;
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(3_500);
    expect(started).toBe(1);

    finishRun();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);
    loop.stop();
  });

  it("hands a failed run to its failure handler and runs again on the next turn", async () => {
    const failures: unknown[] = [];
    let runs = 0;
    const loop = every(
      1_000,
      async () => {
        runs += 1;
        if (runs === 1) throw new Error("the network is away");
      },
      (error) => failures.push(error),
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(failures).toHaveLength(1);
    expect(runs).toBe(2);
    loop.stop();
  });

  it("is idle only once the run in flight has ended, and runs no more after a stop", async () => {
    let runs = 0;
    let finishRun = (): void => {};
    const loop = every(
      1_000,
      () => {
        runs += 1;
        return new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_000);
    loop.stop();

    let idle = false;
    void loop.idle().then(() => {
      idle = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(idle).toBe(false);

    finishRun();
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
    expect(runs).toBe(1);
  });
});
