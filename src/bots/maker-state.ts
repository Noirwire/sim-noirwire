import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * run: quotes both sides. reduce: quotes only the side that shrinks its
 * position, so users can still close against it. stopped: quotes nothing.
 */
export const MAKER_MODES = ["run", "reduce", "stopped"] as const;
export type MakerMode = (typeof MAKER_MODES)[number];

export interface MakerState {
  mode: MakerMode;
  /** Why the mode is not run: what happened, in words. */
  reason: string | null;
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
  day: z.string().nullable(),
  dayStartEquity: amount,
  peakEquity: amount,
  lastCommandAtMs: z.number(),
  spotBaseAtStart: amount,
});

const FRESH: MakerState = {
  mode: "run",
  reason: null,
  day: null,
  dayStartEquity: null,
  peakEquity: null,
  lastCommandAtMs: 0,
  spotBaseAtStart: null,
};

export const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const writeAtomically = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
};

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
  ) {}

  static async open(path: string): Promise<MakerLedger> {
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      return new MakerLedger(path, fileSchema.parse(raw));
    } catch (error) {
      if (isMissing(error)) return new MakerLedger(path, { ...FRESH });
      throw new Error(
        `the maker's state file ${path} cannot be read, so its loss limits cannot be trusted. ` +
          "Check the file, or move it away to start the limits from today.",
        { cause: error },
      );
    }
  }

  get state(): Readonly<MakerState> {
    return this.current;
  }

  /** Changes the state in memory, then on disk. If the disk write fails, the change still holds here. */
  async update(change: Partial<MakerState>): Promise<void> {
    this.current = { ...this.current, ...change };
    const { dayStartEquity, peakEquity, spotBaseAtStart } = this.current;
    const text = JSON.stringify({
      ...this.current,
      dayStartEquity: dayStartEquity?.toString() ?? null,
      peakEquity: peakEquity?.toString() ?? null,
      spotBaseAtStart: spotBaseAtStart?.toString() ?? null,
    });
    await writeAtomically(this.path, text);
  }
}
