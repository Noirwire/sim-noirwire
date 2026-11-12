import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotStore } from "../src/data/snapshot.js";
import { StatsTracker, countsFill } from "../src/data/stats.js";
import type { Fill } from "../src/engine/types.js";
import { UserOrderCount } from "../src/wiring/user-order-count.js";
import { dollars } from "./helpers.js";

const fillAt = (sequence: number, price: number): Fill => ({
  market: "NSOL-NUSD",
  price: dollars(price),
  size: dollars(1),
  takerSide: "buy",
  takerTag: 1n,
  makerTag: 2n,
  timestampMs: 1_000 + sequence,
  sequence,
});

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "stats-persistence-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What the rollup venue does on a tape read: a fill at or below the saved cursor is only replayed. */
const readTape = (
  fills: Fill[],
  cursor: number,
  stats: StatsTracker,
  restored: boolean,
  countingSinceMs: number,
): void => {
  for (const fill of fills) {
    if (fill.sequence <= cursor) continue;
    if (countsFill(fill, restored, countingSinceMs)) stats.recordFill(fill, "user");
  }
};

describe("stats that survive a restart", () => {
  it("counts a fill once across a restart, and counts one that arrived while down", async () => {
    const dir = newDir();
    const first = new StatsTracker();
    first.recordTrader("alice");
    readTape([fillAt(1, 100)], 0, first, false, 0);
    const store = new SnapshotStore(dir);
    await store.save({
      savedAtMs: 5_000,
      candles: [],
      fundedAddresses: [],
      tapeCursors: { "NSOL-NUSD": 1 },
      stats: first.toStored(),
    });

    const saved = await new SnapshotStore(dir).load();
    const second = new StatsTracker();
    second.restore(saved!.stats!);
    const startedAtMs = 9_000;
    readTape([fillAt(1, 100), fillAt(2, 50)], 1, second, true, startedAtMs);

    const counted = second.snapshot(0);
    expect(counted.user.fills).toBe(2);
    expect(counted.user.volume).toBe(dollars(150));
    expect(counted.tradersTotal).toBe(1);
  });

  it("loads an old snapshot without stats and counts from zero by start time", async () => {
    const dir = newDir();
    await new SnapshotStore(dir).save({ savedAtMs: 1, candles: [], fundedAddresses: [] });

    const saved = await new SnapshotStore(dir).load();
    expect(saved?.stats).toBeUndefined();
    expect(saved?.userOrderBaseline).toBeUndefined();

    const stats = new StatsTracker();
    readTape([fillAt(1, 100), fillAt(2, 100)], 0, stats, false, 1_002);
    expect(stats.snapshot(0).user.fills).toBe(1);
  });

  it("keeps the user order count growing from the saved baseline, orders placed while down included", () => {
    const before = new UserOrderCount();
    before.afterChainOrders(100n);
    before.botOrderExecuted();
    expect(before.afterChainOrders(110n)).toBe(9);

    const after = new UserOrderCount();
    after.startFrom(before.baseline()!);
    expect(after.afterChainOrders(115n)).toBe(14);
  });
});
