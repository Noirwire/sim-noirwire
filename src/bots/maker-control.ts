import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MAKER_MODES, type MakerMode, isMissing, writeAtomically } from "./maker-state.js";

/** What an operator asks of every maker on this service, through a file only someone on the machine can write. */
export interface ControlCommand {
  mode: MakerMode;
  requestedAtMs: number;
}

const commandSchema = z.object({
  mode: z.enum(MAKER_MODES),
  requestedAtMs: z.number(),
});

export const controlPath = (dataDir: string): string => join(dataDir, "maker-control.json");

export const requestMode = (dataDir: string, mode: MakerMode, nowMs: number): Promise<void> =>
  writeAtomically(controlPath(dataDir), JSON.stringify({ mode, requestedAtMs: nowMs }));

export class MakerControl {
  constructor(private readonly path: string) {}

  /**
   * The command in the file, or null when there is none. A file that cannot
   * be read throws: the maker then quotes nothing new until somebody fixes it.
   */
  async read(): Promise<ControlCommand | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    try {
      return commandSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `the maker control file ${this.path} cannot be read. Run the kill switch again to write it afresh.`,
        { cause: error },
      );
    }
  }
}
