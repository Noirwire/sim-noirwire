import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualClock } from "../src/engine/clock.js";
import { FlowFence } from "../src/rebalance/flow-adjust.js";
import { StepRefused } from "../src/rebalance/flow-journal.js";
import { OutFlow, type OutPorts } from "../src/rebalance/out-flow.js";
import { scratchRoot } from "./helpers.js";

const ROOT = scratchRoot("rebalance-out");

type Step = "withdraw" | "shuttle" | "transfer";
const AMOUNT = 50_000_000n;

/** Balances that move only when a step runs. `lose` makes a step throw after landing, `drop` before. */
const chain = () => {
  const state = { rollup: 10_000_000n, solana: 0n, bridge: 0n, book: 500_000_000n };
  const sent: Step[] = [];
  const fail: { landThenThrow: Set<Step>; throwFirst: Set<Step>; refuse: Set<Step> } = {
    landThenThrow: new Set(),
    throwFirst: new Set(),
    refuse: new Set(),
  };
  const run = async (step: Step, effect: () => void): Promise<string> => {
    sent.push(step);
    if (fail.refuse.has(step)) {
      fail.refuse.delete(step);
      throw new StepRefused(`${step} refused`);
    }
    if (fail.throwFirst.has(step)) {
      fail.throwFirst.delete(step);
      throw new Error("connection lost");
    }
    effect();
    if (fail.landThenThrow.has(step)) {
      fail.landThenThrow.delete(step);
      throw new Error("connection lost after landing");
    }
    return `${step}-signature`;
  };
  const ports: OutPorts = {
    rollupBalance: async () => state.rollup,
    solanaBalance: async () => state.solana,
    withdrawFromBook: (amount) =>
      run("withdraw", () => {
        state.book -= amount;
        state.rollup += amount;
      }),
    shuttleToSolana: (amount) =>
      run("shuttle", () => {
        state.rollup -= amount;
        state.solana += amount;
      }),
    transferToBridge: (amount) =>
      run("transfer", () => {
        state.solana -= amount;
        state.bridge += amount;
      }),
  };
  return { state, sent, fail, ports };
};

const harness = async (name: string) => {
  await mkdir(ROOT, { recursive: true });
  const path = join(ROOT, `${name}.json`);
  const clock = new ManualClock(5_000_000);
  const fake = chain();
  const fence = new FlowFence();
  const applied: string[] = [];
  const allowed = { yes: true };
  const fenceWhenApplied: boolean[] = [];
  const make = (shared: FlowFence = fence) =>
    new OutFlow({
      path,
      ports: fake.ports,
      fence: shared,
      clock,
      mayWithdraw: async () => allowed.yes,
      onBookWithdrawn: async (id) => {
        fenceWhenApplied.push(shared.active);
        applied.push(id);
      },
      landWaitMs: 0,
    });
  return { flow: make(), make, clock, fake, fence, applied, allowed, fenceWhenApplied, path };
};

describe("the transfer out", () => {
  it("runs withdraw, shuttle and transfer once each, in order, and applies the loss limits between", async () => {
    const h = await harness("happy");
    await h.flow.begin("req-1", AMOUNT);
    const result = await h.flow.advance();

    expect(result).toEqual({ kind: "done", signature: "transfer-signature" });
    expect(h.fake.sent).toEqual(["withdraw", "shuttle", "transfer"]);
    expect(h.fake.state).toMatchObject({ rollup: 10_000_000n, solana: 0n, bridge: AMOUNT });
    expect(h.applied).toEqual(["req-1"]);
    expect(h.fenceWhenApplied).toEqual([true]);
    expect(h.fence.active).toBe(false);
  });

  it("sends nothing when the maker may not withdraw", async () => {
    const h = await harness("not-allowed");
    h.allowed.yes = false;
    await h.flow.begin("req-2", AMOUNT);

    expect(await h.flow.advance()).toMatchObject({ kind: "failed" });
    expect(h.fake.sent).toEqual([]);
    expect(h.fence.active).toBe(false);
  });

  it("ends a withdrawal the program refused, with the fence down", async () => {
    const h = await harness("refused");
    h.fake.fail.refuse.add("withdraw");
    await h.flow.begin("req-3", AMOUNT);

    expect(await h.flow.advance()).toMatchObject({ kind: "failed", reason: "withdraw refused" });
    expect(h.fence.active).toBe(false);
    await h.flow.finish();
    expect(await h.flow.current()).toBeNull();
  });

  it("refuses to begin another request over an unfinished one", async () => {
    const h = await harness("two");
    await h.flow.begin("req-4", AMOUNT);
    await expect(h.flow.begin("req-5", AMOUNT)).rejects.toThrow(/unfinished/);
  });

  describe.each<Step>(["withdraw", "shuttle", "transfer"])("a crash around the %s step", (step) => {
    it("does not send it again when it landed but the answer was lost", async () => {
      const h = await harness(`landed-${step}`);
      h.fake.fail.landThenThrow.add(step);
      await h.flow.begin("req-6", AMOUNT);
      expect(await h.flow.advance()).toMatchObject({ kind: "waiting" });

      const reborn = h.make(new FlowFence());
      await reborn.recover();
      const result = await reborn.advance();

      expect(result.kind).toBe("done");
      expect(h.fake.sent.filter((sent) => sent === step)).toHaveLength(1);
      expect(h.fake.state.bridge).toBe(AMOUNT);
      expect(h.applied).toEqual(["req-6"]);
    });

    it("waits while it may still land, and sends it again only after the resend wait", async () => {
      const h = await harness(`dropped-${step}`);
      h.fake.fail.throwFirst.add(step);
      await h.flow.begin("req-7", AMOUNT);
      expect(await h.flow.advance()).toMatchObject({ kind: "waiting" });

      const reborn = h.make(new FlowFence());
      h.clock.advance(60_000);
      expect(await reborn.advance()).toMatchObject({ kind: "waiting" });
      expect(h.fake.sent.filter((sent) => sent === step)).toHaveLength(1);

      h.clock.advance(5 * 60_000);
      expect((await reborn.advance()).kind).toBe("done");
      expect(h.fake.sent.filter((sent) => sent === step)).toHaveLength(2);
      expect(h.fake.state.bridge).toBe(AMOUNT);
    });
  });

  it("raises the fence again after a restart between the withdrawal and the loss limits", async () => {
    const h = await harness("fence-restart");
    h.fake.fail.landThenThrow.add("withdraw");
    await h.flow.begin("req-8", AMOUNT);
    await h.flow.advance();

    const fence = new FlowFence();
    const reborn = h.make(fence);
    await reborn.recover();
    expect(fence.active).toBe(true);
    await reborn.advance();
    expect(fence.active).toBe(false);
  });

  it("does not move the money on to Solana twice if the journal says it is already there", async () => {
    const h = await harness("midway");
    await h.flow.begin("req-9", AMOUNT);
    await h.flow.advance();
    const again = h.make(new FlowFence());
    expect((await again.advance()).kind).toBe("done");
    expect(h.fake.sent).toEqual(["withdraw", "shuttle", "transfer"]);
  });
});
