import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { ManualClock } from "../src/engine/clock.js";
import { FlowFence, applyFlow, shiftedLimits } from "../src/rebalance/flow-adjust.js";
import { USDC, scratchRoot } from "./helpers.js";

const ROOT = scratchRoot("rebalance-adjust");
const voice = () => {
  const alerts: string[] = [];
  return { alerts, voice: { alert: (m: string) => void alerts.push(m), notice: () => {} } };
};

const ledgerWith = async (name: string, start: bigint, peak: bigint) => {
  await mkdir(ROOT, { recursive: true });
  const ledger = await MakerLedger.open(makerStatePath(ROOT, name));
  await ledger.update({ day: "1970-01-01", dayStartEquity: start, peakEquity: peak });
  return { ledger, path: makerStatePath(ROOT, name) };
};

describe("loss limits across a transfer", () => {
  it("lowers both references when money goes out, and never below zero", () => {
    const shifted = shiftedLimits(
      { dayStartEquity: 1_000n * USDC, peakEquity: 1_200n * USDC },
      -300n * USDC,
      700n * USDC,
    );
    expect(shifted).toEqual({ dayStartEquity: 700n * USDC, peakEquity: 900n * USDC });
    expect(shiftedLimits({ dayStartEquity: 100n, peakEquity: null }, -500n, 0n)).toEqual({
      dayStartEquity: 0n,
      peakEquity: null,
    });
  });

  it("raises them when money comes in, but not past the equity held", () => {
    const limits = { dayStartEquity: 500n * USDC, peakEquity: 600n * USDC };
    expect(shiftedLimits(limits, 200n * USDC, 900n * USDC)).toEqual({
      dayStartEquity: 700n * USDC,
      peakEquity: 800n * USDC,
    });
    expect(shiftedLimits(limits, 200n * USDC, 650n * USDC)).toEqual({
      dayStartEquity: 650n * USDC,
      peakEquity: 650n * USDC,
    });
  });

  it("a withdrawal reads as no loss once applied, and as a loss without it", async () => {
    const clock = new ManualClock(Date.parse("1970-01-01T12:00:00Z"));
    const { ledger } = await ledgerWith("no-loss", 1_000n * USDC, 1_000n * USDC);
    const said = voice();
    const risk = new MakerRisk(ledger, clock, "NBTC-PERP", said.voice);

    await applyFlow(ledger, "req-a", -400n * USDC, 0n);
    await risk.check(600n * USDC, 0n);
    expect(ledger.state.mode).toBe("run");
    expect(said.alerts).toEqual([]);

    const { ledger: unadjusted } = await ledgerWith("loss", 1_000n * USDC, 1_000n * USDC);
    const other = new MakerRisk(unadjusted, clock, "NBTC-PERP", voice().voice);
    await other.check(600n * USDC, 0n);
    expect(unadjusted.state.mode).toBe("flatten");
  });

  it("a deposit reads as no gain: a later real loss is still measured from the adjusted line", async () => {
    const clock = new ManualClock(Date.parse("1970-01-01T12:00:00Z"));
    const { ledger } = await ledgerWith("deposit", 1_000n * USDC, 1_000n * USDC);
    const risk = new MakerRisk(ledger, clock, "NBTC-PERP", voice().voice);
    await risk.check(1_500n * USDC, 0n);
    await applyFlow(ledger, "req-b", 500n * USDC, 1_500n * USDC);
    expect(ledger.state.dayStartEquity).toBe(1_500n * USDC);
    await risk.check(1_480n * USDC, 0n);
    expect(ledger.state.mode).toBe("run");
    await risk.check(1_400n * USDC, 0n);
    expect(ledger.state.mode).toBe("flatten");
  });

  it("counts a flow once, across a restart", async () => {
    const { ledger, path } = await ledgerWith("once", 1_000n * USDC, 1_000n * USDC);
    expect(await applyFlow(ledger, "req-c", -100n * USDC, 0n)).toBe(true);
    const reopened = await MakerLedger.open(path);
    expect(await applyFlow(reopened, "req-c", -100n * USDC, 0n)).toBe(false);
    expect(reopened.state.dayStartEquity).toBe(900n * USDC);
    expect(reopened.state.peakEquity).toBe(900n * USDC);
  });

  it("holds the loss check while the fence is up", async () => {
    const clock = new ManualClock(Date.parse("1970-01-01T12:00:00Z"));
    const { ledger } = await ledgerWith("fenced", 1_000n * USDC, 1_000n * USDC);
    const fence = new FlowFence();
    const risk = new MakerRisk(ledger, clock, "NBTC-PERP", voice().voice, fence);
    fence.raise();
    await risk.check(100n * USDC, 0n);
    expect(ledger.state.mode).toBe("run");
    fence.lower();
    await risk.check(100n * USDC, 0n);
    expect(ledger.state.mode).toBe("flatten");
  });
});
