import { access, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/** While `fails` is set, no file can be opened for writing, as on a disk that has gone read-only. */
const disk = vi.hoisted(() => ({ fails: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) =>
      disk.fails ? Promise.reject(new Error("EROFS: the disk is read-only")) : actual.open(...args),
  };
});
import { MakerRisk } from "../src/bots/maker-risk.js";
import { MakerLedger, StatePersistenceError, makerStatePath } from "../src/bots/maker-state.js";
import { loadConfig } from "../src/config/config.js";
import { ManualClock } from "../src/engine/clock.js";
import { MARKETS } from "../src/engine/markets.js";
import type { Venue } from "../src/engine/types.js";
import { placingOrdersThrough } from "../src/engine/venue-orders.js";
import { openBots } from "../src/wiring/bots.js";
import type { VenueWiring } from "../src/wiring/venue-wiring.js";
import { dollars, makeVenue } from "./helpers.js";

const PERP = "NSOL-PERP";
const ROOT = join("data-test", `maker-durability-${Date.now()}`);

afterAll(() => rm(ROOT, { recursive: true, force: true }));

const freshDir = async (name: string): Promise<string> => {
  const dir = join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("the recovery marker is looked for with lstat", () => {
  it("opens a maker with no marker as running, and leaves no probe file behind", async () => {
    const dir = await freshDir("no-marker");
    const path = makerStatePath(dir, PERP);

    const ledger = await MakerLedger.open(path);

    expect(ledger.state.mode).toBe("run");
    expect(await readdir(dir)).toEqual([]);
  });

  it("counts a link that points nowhere as a marker, and starts stopped", async () => {
    const dir = await freshDir("dangling-marker");
    const path = makerStatePath(dir, PERP);
    await symlink("does-not-exist", `${path}.failed`);

    const ledger = await MakerLedger.open(path);

    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.hedgeMode).toBe("reduce");
  });

  it("lets an explicit resume replace the dangling link, and the next start runs", async () => {
    const dir = await freshDir("dangling-marker-resume");
    const path = makerStatePath(dir, PERP);
    await symlink("does-not-exist", `${path}.failed`);
    const ledger = await MakerLedger.open(path);

    await ledger.update({ mode: "run", reason: null, lastCommandAtMs: 7 });

    expect(ledger.state.mode).toBe("run");
    expect(await exists(`${path}.failed`)).toBe(false);
    expect((await MakerLedger.open(path)).state.mode).toBe("run");
  });
});

describe("a state write and the marker write that both fail", () => {
  const failBoth = async (dir: string) => {
    const path = makerStatePath(dir, PERP);
    const ledger = await MakerLedger.open(path);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    disk.fails = true;
    try {
      const error = await ledger
        .update({ mode: "reduce", reason: "test" })
        .catch((e: unknown) => e);
      return { ledger, path, error, errors };
    } finally {
      disk.fails = false;
    }
  };

  it("stays stopped in memory, and says no marker could be written", async () => {
    const dir = await freshDir("both-fail");

    const { ledger, error, errors } = await failBoth(dir);

    expect(error).toBeInstanceOf(StatePersistenceError);
    expect((error as StatePersistenceError).durableEvidence).toBe(false);
    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.undurable).toBe(true);
    expect(ledger.hedgeMode).toBe("reduce");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("refuses to start again while the disk still fails, instead of running", async () => {
    const dir = await freshDir("both-fail-restart");
    const { path, errors } = await failBoth(dir);
    errors.mockRestore();

    disk.fails = true;
    try {
      await expect(MakerLedger.open(path)).rejects.toThrow("does not take a durable write");
    } finally {
      disk.fails = false;
    }
  });

  it("leaves the marker on the next write once the disk works, so a restart is stopped", async () => {
    const dir = await freshDir("both-fail-heals");
    const { ledger, path, errors } = await failBoth(dir);
    errors.mockRestore();

    await ledger.update({ reason: "disk is back" });

    expect(ledger.undurable).toBe(false);
    expect(await exists(`${path}.failed`)).toBe(true);
    expect((await MakerLedger.open(path)).state.mode).toBe("stopped");
  });
});

describe("a missing state file on mainnet", () => {
  it("starts the maker stopped, with the hedge told to reduce rather than abandon, and records that", async () => {
    const dir = await freshDir("mainnet-missing");
    const path = makerStatePath(dir, PERP);

    const ledger = await MakerLedger.open(path, { requireSavedState: true });

    expect(ledger.state.mode).toBe("stopped");
    expect(ledger.state.reason).toContain("resume");
    expect(ledger.startedWithoutState).toBe(true);
    expect(ledger.hedgeMode).toBe("reduce");
    expect(await exists(`${path}.failed`)).toBe(true);
  });

  it("is still stopped after another restart, and an explicit resume starts it for good", async () => {
    const dir = await freshDir("mainnet-missing-resume");
    const path = makerStatePath(dir, PERP);
    await MakerLedger.open(path, { requireSavedState: true });

    const again = await MakerLedger.open(path, { requireSavedState: true });
    expect(again.state.mode).toBe("stopped");

    await again.update({ mode: "run", reason: null, lastCommandAtMs: 9 });
    expect(again.hedgeMode).toBe("run");
    const resumed = await MakerLedger.open(path, { requireSavedState: true });
    expect(resumed.state.mode).toBe("run");
    expect(resumed.startedWithoutState).toBe(false);
    expect(await exists(`${path}.failed`)).toBe(false);
  });

  it("is not resumed by a command made before the stop, only by one made after it", async () => {
    const dir = await freshDir("mainnet-missing-stale-resume");
    const path = makerStatePath(dir, PERP);
    const staleAtMs = Date.now() - 60_000;
    const ledger = await MakerLedger.open(path, { requireSavedState: true });
    const risk = new MakerRisk(ledger, new ManualClock(Date.now()), PERP, {
      alert: () => {},
      notice: () => {},
    });

    await risk.follow({ mode: "run", requestedAtMs: staleAtMs }, dollars(1_000));
    expect(ledger.state.mode).toBe("stopped");

    const restarted = await MakerLedger.open(path, { requireSavedState: true });
    const again = new MakerRisk(restarted, new ManualClock(Date.now()), PERP, {
      alert: () => {},
      notice: () => {},
    });
    await again.follow({ mode: "run", requestedAtMs: staleAtMs }, dollars(1_000));
    expect(restarted.state.mode).toBe("stopped");

    await again.follow({ mode: "run", requestedAtMs: Date.now() + 1 }, dollars(1_000));
    expect(restarted.state.mode).toBe("run");
  });

  it("does not start at all when the marker cannot be written", async () => {
    const dir = await freshDir("mainnet-missing-unwritable");
    disk.fails = true;
    try {
      await expect(
        MakerLedger.open(makerStatePath(dir, PERP), { requireSavedState: true }),
      ).rejects.toThrow();
    } finally {
      disk.fails = false;
    }
  });

  it("is unchanged where the state is not required: a first run starts running", async () => {
    const dir = await freshDir("devnet-missing");

    const ledger = await MakerLedger.open(makerStatePath(dir, PERP));

    expect(ledger.state.mode).toBe("run");
    expect(ledger.startedWithoutState).toBe(false);
    expect(await exists(`${makerStatePath(dir, PERP)}.failed`)).toBe(false);
  });
});

describe("the makers opened by the service, on mainnet without a state file", () => {
  const opened = async (name: string, network: string) => {
    const { venue } = makeVenue();
    const counting: Venue = placingOrdersThrough(venue, (trader, order) =>
      venue.placeOrder(trader, order),
    );
    const wiring = {
      venue: counting,
      botVenue: counting,
      botMarkets: [MARKETS[0]],
      botSizes: async () => ({
        makerLevel: dollars(0.3),
        takerMin: 0n,
        takerMax: 0n,
        lotSize: dollars(0.001),
        takerStartingBase: 0n,
      }),
      afterMakersOpen: async () => {},
      needsFundingUpdater: false,
      liquidationTargets: () => [],
    } as unknown as VenueWiring;
    const config = {
      ...loadConfig({
        VENUE: "memory",
        NOISE_TAKERS_ENABLED: "0",
        LIQUIDATOR_ENABLED: "0",
        HOUSE_MAKER_RISK_RULES: "1",
        DATA_DIR: await freshDir(name),
      }),
      NETWORK: network,
    };
    const said: string[] = [];
    const problems = { onError: (what: string) => said.push(what), onRecovered: () => {} };
    return { bots: await openBots(config, wiring, problems), said };
  };

  it("starts the maker stopped, alerts with the command that resumes it, and reports not ready", async () => {
    const { bots, said } = await opened("bots-mainnet", "mainnet");

    expect(said.some((line) => line.includes("kill-switch.js resume"))).toBe(true);
    expect(bots.trading()).toMatchObject({ ready: false });
    expect(bots.trading().reason).toContain("stopped");
  });

  it("starts a devnet maker running, as before", async () => {
    const { bots, said } = await opened("bots-devnet", "devnet");

    expect(said).toEqual([]);
    expect(bots.trading().reason).not.toContain("stopped");
    expect(bots.trading().reason).toContain("the market has not been read yet");
  });

  it("reports a devnet maker ready once the first market read has worked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in this test")));
    try {
      const { bots } = await opened("bots-devnet-ready", "devnet");
      const loops = bots.start();

      await vi.advanceTimersByTimeAsync(5_000);
      for (const loop of loops) loop.stop();

      expect(bots.trading().reason ?? "").not.toContain("stopped");
      expect(bots.trading().reason ?? "").not.toContain("the market has not been read yet");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe("the state file is what the hold is read from", () => {
  it("keeps what a write wrote, so a fresh ledger sees the same hold", async () => {
    const dir = await freshDir("hold-roundtrip");
    const path = makerStatePath(dir, PERP);
    const ledger = await MakerLedger.open(path);
    const hold = { orderIds: ["a#1"], sinceMs: 5, lastAtMs: 6, untilMs: null, seatClearAtMs: 7 };

    await ledger.update({ hold });

    expect((await MakerLedger.open(path)).state.hold).toEqual(hold);
    expect(JSON.parse(await readFile(path, "utf8")).hold).toEqual(hold);
  });
});
