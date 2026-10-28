import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HouseMaker } from "../src/bots/house-maker.js";
import { MakerControl, controlPath } from "../src/bots/maker-control.js";
import { MAKER_LIMITS } from "../src/bots/maker-limits.js";
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerSafety } from "../src/bots/maker-safety.js";
import { MakerLedger, makerStatePath } from "../src/bots/maker-state.js";
import { ManualClock } from "../src/engine/clock.js";
import type { OrderView } from "../src/engine/types.js";
import { dollars, makeVenue, openFunded, publish } from "./helpers.js";

const PERP = "NSOL-PERP";
const START_MS = Date.parse("2026-11-02T12:00:00Z");
const ROOT = join("data-test", `maker-status-${Date.now()}`);

afterAll(() => rm(ROOT, { recursive: true, force: true }));

const order = (side: "buy" | "sell", remainingSize: number): OrderView => ({
  orderId: `${side}-${remainingSize}`,
  tag: 0n,
  market: PERP,
  side,
  type: "postOnly",
  price: dollars(150),
  size: dollars(remainingSize),
  remainingSize: dollars(remainingSize),
  reduceOnly: false,
});

const riskOn = async (name: string) => {
  const dir = join(ROOT, name);
  await mkdir(dir, { recursive: true });
  const clock = new ManualClock(START_MS);
  const notices: string[] = [];
  const alerts: string[] = [];
  const voice = {
    alert: (message: string) => alerts.push(message),
    notice: (message: string) => notices.push(message),
  };
  const ledger = await MakerLedger.open(makerStatePath(dir, PERP));
  return {
    dir,
    clock,
    notices,
    alerts,
    ledger,
    voice,
    risk: new MakerRisk(ledger, clock, PERP, voice),
  };
};

describe("the maker's status line", () => {
  it("is said on the first reading, not again before the interval, and again after it", async () => {
    const { clock, notices, alerts, ledger, risk } = await riskOn("interval");
    await ledger.update({ dayStartEquity: dollars(1_000), peakEquity: dollars(1_020.5) });
    const resting = [order("buy", 0.3), order("buy", 0.3), order("sell", 0.5)];

    risk.report(dollars(990.25), dollars(1.5), dollars(150), resting);

    expect(notices).toEqual([
      `${PERP} maker: equity 990.25 nUSD, position 1.5 SOL (225.00 nUSD), resting 2 bids / 1 asks (0.6 / 0.5 SOL), ` +
        "day start 1000.00 nUSD, peak 1020.50 nUSD, mode run",
    ]);

    clock.advance(MAKER_LIMITS.statusEveryMs - 1);
    risk.report(dollars(990.25), dollars(1.5), dollars(150), resting);
    expect(notices).toHaveLength(1);

    clock.advance(1);
    risk.report(dollars(980), dollars(-2), dollars(150), []);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("equity 980.00 nUSD, position -2.0 SOL (-300.00 nUSD)");
    expect(notices[1]).toContain("resting 0 bids / 0 asks (0.0 / 0.0 SOL)");
    expect(alerts).toEqual([]);
  });

  it("says unknown for a figure the ledger has not recorded, and still says the line", async () => {
    const { notices, risk } = await riskOn("unknown");

    risk.report(0n, 0n, dollars(150), []);

    expect(notices).toEqual([
      `${PERP} maker: equity 0.00 nUSD, position 0.0 SOL (0.00 nUSD), resting 0 bids / 0 asks (0.0 / 0.0 SOL), ` +
        "day start unknown, peak unknown, mode run",
    ]);
  });

  it("comes out of a tick of the maker, from the seat it read for the risk rules", async () => {
    const { venue, clock } = makeVenue();
    await publish(venue, clock, PERP, 100);
    const { dir, notices, alerts, voice, risk } = await riskOn("tick");
    const safety = new MakerSafety({
      reference: { read: async () => ({ ok: true, price: dollars(100) }) },
      risk,
      control: new MakerControl(controlPath(dir)),
      clock,
      voice,
      market: PERP,
    });
    const maker = new HouseMaker({
      market: PERP,
      kind: "perp",
      baseToken: "SOL",
      quoteToken: "nUSD",
      levels: 2,
      spreadBps: 10,
      levelStepBps: 5,
      baseSizePerLevel: dollars(1),
      requoteThresholdBps: 5,
      requoteIntervalMs: 1_000,
      positionLimitNotional: dollars(1_000),
      maxSkewBps: 20,
      lotSize: 1_000n,
      startingQuoteBalance: dollars(100_000),
      startingBaseBalance: 0n,
      clock,
      safety,
    });
    await openFunded(venue, "taker", { nUSD: 100_000 });
    await maker.ensureOpen(venue);

    await maker.tick(venue);
    clock.advance(MAKER_LIMITS.statusEveryMs - 1);
    await maker.tick(venue);

    const lines = notices.filter((line) => line.includes("maker: equity"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^NSOL-PERP maker: equity [\d.]+ nUSD, position 0\.0 SOL/);
    expect(alerts).toEqual([]);
  });
});
