import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
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
  const file = await open(`${path}.tmp`, "w");
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(`${path}.tmp`, path);
  const folder = await open(directory, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
};

/** Present while a state write has failed and an operator has not yet resumed the maker. */
const failedMarkerPath = (statePath: string): string => `${statePath}.failed`;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

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
  ) {}

  static async open(path: string): Promise<MakerLedger> {
    const interrupted = await exists(failedMarkerPath(path));
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
    if (!interrupted) return new MakerLedger(path, loaded, false);
    const held: MakerState = {
      ...loaded,
      mode: "stopped",
      reason: "a state write failed before the last shutdown, so the saved mode cannot be trusted",
    };
    return new MakerLedger(path, held, true);
  }

  get state(): Readonly<MakerState> {
    return this.current;
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
    const { dayStartEquity, peakEquity, spotBaseAtStart } = next;
    const text = JSON.stringify({
      ...next,
      dayStartEquity: dayStartEquity?.toString() ?? null,
      peakEquity: peakEquity?.toString() ?? null,
      spotBaseAtStart: spotBaseAtStart?.toString() ?? null,
    });
    try {
      await writeAtomically(this.path, text);
      if (this.recoveryRequired && resumes) {
        await rm(failedMarkerPath(this.path), { force: true });
        this.recoveryRequired = false;
      }
    } catch (error) {
      this.current = {
        ...this.current,
        mode: "stopped",
        reason: "its state could not be saved to disk",
      };
      this.recoveryRequired = true;
      await writeAtomically(failedMarkerPath(this.path), "failed").catch((markerError) =>
        console.error(
          `sim-noirwire: ALERT could not write ${failedMarkerPath(this.path)} either, so a restart may ` +
            "quote again. The maker stays stopped in memory. Do not restart it until the disk is fixed.",
          markerError instanceof Error ? markerError.message : markerError,
        ),
      );
      throw new StatePersistenceError(this.path, error);
    }
    this.current = next;
  }
}
