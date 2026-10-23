import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * run: quotes both sides. reduce (the soft stop): quotes only the side that
 * shrinks its position, so users can still close against it. flatten: a loss
 * limit was passed, so it works its position down to flat with reduce-only
 * orders around the reference price. stopped (the hard stop): quotes nothing,
 * which leaves users unable to close against it.
 */
export const MAKER_MODES = ["run", "reduce", "flatten", "stopped"] as const;
export type MakerMode = (typeof MAKER_MODES)[number];

export interface MakerState {
  mode: MakerMode;
  /** Why the mode is not run: what happened, in words. */
  reason: string | null;
  /** When it began to flatten, while it is flattening. */
  flattenStartedAtMs: number | null;
  /** The UTC day the loss limit counts from, as YYYY-MM-DD. */
  day: string | null;
  dayStartEquity: bigint | null;
  peakEquity: bigint | null;
  /** The newest command from the control file this maker has already followed. */
  lastCommandAtMs: number;
  /** A spot maker's base balance when it first opened, kept so a restart does not take today's for it. */
  spotBaseAtStart: bigint | null;
}

const amount = z
  .string()
  .regex(/^-?\d+$/)
  .nullable()
  .transform((text) => (text === null ? null : BigInt(text)));

const fileSchema = z.object({
  mode: z.enum(MAKER_MODES),
  reason: z.string().nullable(),
  flattenStartedAtMs: z.number().nullable().default(null),
  day: z.string().nullable(),
  dayStartEquity: amount,
  peakEquity: amount,
  lastCommandAtMs: z.number(),
  spotBaseAtStart: amount,
});

const FRESH: MakerState = {
  mode: "run",
  reason: null,
  flattenStartedAtMs: null,
  day: null,
  dayStartEquity: null,
  peakEquity: null,
  lastCommandAtMs: 0,
  spotBaseAtStart: null,
};

export const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** The maker's state could not be written, so a restart would not see it. */
export class StatePersistenceError extends Error {
  constructor(path: string, cause: unknown) {
    super(`the maker's state file ${path} could not be written`, { cause });
    this.name = "StatePersistenceError";
  }
}

/** Writes the file, syncs it, renames it into place, and syncs the directory so the rename survives a crash. */
export const writeAtomically = async (path: string, text: string): Promise<void> => {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  writes += 1;
  const temporary = `${path}.${process.pid}.${writes}.tmp`;
  try {
    const file = await open(temporary, "w");
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(directory);
};

/** Counts writes, so each one has a temporary file of its own. */
let writes = 0;

const syncDirectory = async (directory: string): Promise<void> => {
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
};

/** Present while a state write has failed and an operator has not yet resumed the maker. */
const failedMarkerPath = (statePath: string): string => `${statePath}.failed`;

/**
 * What the marker says. "failed": a state write failed and nothing since has
 * been resumed. "resumed": the operator's resume with `commandTs` was saved,
 * and only the removal of the marker is left.
 */
interface Marker {
  phase: "failed" | "resumed";
  commandTs: number | null;
}

const markerSchema = z.object({
  phase: z.enum(["failed", "resumed"]),
  commandTs: z.number().nullable(),
});

const FAILED_MARKER: Marker = { phase: "failed", commandTs: null };

const writeMarker = (statePath: string, marker: Marker): Promise<void> =>
  writeAtomically(failedMarkerPath(statePath), JSON.stringify(marker));

/**
 * The marker, or null when it is not there. A marker that cannot be read at
 * all means it cannot be known whether a write failed, and is thrown; one
 * that is not valid counts as "failed".
 */
const readMarker = async (statePath: string): Promise<Marker | null> => {
  const path = failedMarkerPath(statePath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(
      `the maker's recovery marker ${path} cannot be checked, so it is not known whether a state ` +
        "write failed before. Repair the state directory and inspect the state file, then start again.",
      { cause: error },
    );
  }
  try {
    return markerSchema.parse(JSON.parse(text));
  } catch {
    return FAILED_MARKER;
  }
};

/** Removes the marker and syncs the directory, so the removal survives a crash. */
const removeMarker = async (statePath: string): Promise<void> => {
  const path = failedMarkerPath(statePath);
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
};

const RECOVERY_REQUIRED =
  "its resume was saved, but the recovery marker could not be removed. Run the kill switch " +
  '"resume" again to finish the recovery';

/** The file of one maker's state, in the data directory. */
export const makerStatePath = (dataDir: string, market: string): string =>
  join(dataDir, `maker-${market}.json`);

/**
 * What a maker must remember across a restart: its mode, the equity its loss
 * limits count from, and a spot maker's starting base. A file that is missing
 * is a first run; one that cannot be read stops the start, because quietly
 * starting over would reset the loss limits.
 */
export class MakerLedger {
  private constructor(
    private readonly path: string,
    private current: MakerState,
    private recoveryRequired: boolean,
    private faulted: boolean,
  ) {}

  /** A hard stop was asked for, saved or not, and no later write has moved the maker off it. */
  private hardStopIntent = false;

  static async open(path: string): Promise<MakerLedger> {
    const marker = await readMarker(path);
    let loaded: MakerState;
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      loaded = fileSchema.parse(raw);
    } catch (error) {
      if (!isMissing(error)) {
        throw new Error(
          `the maker's state file ${path} cannot be read, so its loss limits cannot be trusted. ` +
            "Check the file, or move it away to start the limits from today.",
          { cause: error },
        );
      }
      loaded = { ...FRESH };
    }
    if (marker === null) return new MakerLedger(path, loaded, false, false);
    if (
      marker.phase === "resumed" &&
      loaded.mode === "run" &&
      loaded.lastCommandAtMs === marker.commandTs
    ) {
      try {
        await removeMarker(path);
        return new MakerLedger(path, loaded, false, false);
      } catch {
        return new MakerLedger(
          path,
          { ...loaded, mode: "stopped", reason: RECOVERY_REQUIRED },
          true,
          true,
        );
      }
    }
    const held: MakerState = {
      ...loaded,
      mode: "stopped",
      reason: "a state write failed before the last shutdown, so the saved mode cannot be trusted",
    };
    return new MakerLedger(path, held, true, true);
  }

  get state(): Readonly<MakerState> {
    return this.current;
  }

  /**
   * The mode the hedge follows. A state that could not be saved stops the
   * maker's quoting but is no decision to abandon its exposure, so the hedge
   * sees the soft stop: it may shrink what it holds and open nothing new.
   */
  get hedgeMode(): MakerMode {
    if (this.hardStopIntent) return this.current.mode;
    return this.faulted && this.current.mode === "stopped" ? "reduce" : this.current.mode;
  }

  /**
   * Writes the changed state to disk, and holds it in memory only once that
   * has worked. If the write fails the maker fails closed: the mode here
   * becomes `stopped`, a marker file next to the state file makes a restart
   * start stopped too, and the failure is thrown as a `StatePersistenceError`.
   * While the marker stands, only a change to `run` (the operator's resume)
   * can leave `stopped`, and it removes the marker once its write has worked.
   */
  async update(change: Partial<MakerState>): Promise<void> {
    const resumes = change.mode === "run";
    const next = { ...this.current, ...change };
    if (this.recoveryRequired && !resumes) next.mode = "stopped";
    // Set before the write: a hard stop whose save fails is still a decision to stop.
    if (change.mode === "stopped") this.hardStopIntent = true;
    const { dayStartEquity, peakEquity, spotBaseAtStart } = next;
    const text = JSON.stringify({
      ...next,
      dayStartEquity: dayStartEquity?.toString() ?? null,
      peakEquity: peakEquity?.toString() ?? null,
      spotBaseAtStart: spotBaseAtStart?.toString() ?? null,
    });
    try {
      await writeAtomically(this.path, text);
    } catch (error) {
      this.current = {
        ...this.current,
        mode: "stopped",
        reason: "its state could not be saved to disk",
      };
      this.recoveryRequired = true;
      this.faulted = true;
      await writeMarker(this.path, FAILED_MARKER).catch((markerError) =>
        console.error(
          `sim-noirwire: ALERT could not write ${failedMarkerPath(this.path)} either, so a restart may ` +
            "quote again. The maker stays stopped in memory. Do not restart it until the disk is fixed.",
          markerError instanceof Error ? markerError.message : markerError,
        ),
      );
      throw new StatePersistenceError(this.path, error);
    }
    if (this.recoveryRequired && resumes) {
      try {
        await writeMarker(this.path, { phase: "resumed", commandTs: next.lastCommandAtMs });
        await removeMarker(this.path);
      } catch (error) {
        this.current = { ...next, mode: "stopped", reason: RECOVERY_REQUIRED };
        throw new StatePersistenceError(failedMarkerPath(this.path), error);
      }
      this.recoveryRequired = false;
      this.faulted = false;
    }
    if (change.mode === "stopped") this.faulted = false;
    if (next.mode !== "stopped") this.hardStopIntent = false;
    this.current = next;
    if (this.recoveryRequired && change.lastCommandAtMs !== undefined && !resumes) {
      // A newer command is saved: a resume still waiting for its marker to go must not pass any more.
      await writeMarker(this.path, FAILED_MARKER).catch(() => {});
    }
  }

  /**
   * Whether the marker on disk says this operator resume was saved and only
   * the marker's removal is left, so the same command may be run again.
   */
  async canRetryResume(requestedAtMs: number): Promise<boolean> {
    if (!this.recoveryRequired) return false;
    const marker = await readMarker(this.path).catch(() => null);
    return (
      marker?.phase === "resumed" &&
      marker.commandTs === requestedAtMs &&
      this.current.lastCommandAtMs === requestedAtMs
    );
  }
}
