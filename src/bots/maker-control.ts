import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isMissing, writeAtomically } from "./maker-state.js";

/** What an operator can ask for. Flattening is the maker's own answer to a loss limit, not a request. */
export const CONTROL_MODES = ["run", "reduce", "stopped"] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];

/** What an operator asks of every maker on this service, through a file only someone on the machine can write. */
export interface ControlCommand {
  mode: ControlMode;
  requestedAtMs: number;
}

const commandSchema = z.object({
  mode: z.enum(CONTROL_MODES),
  requestedAtMs: z.number(),
});

export const controlPath = (dataDir: string): string => join(dataDir, "maker-control.json");

export const requestMode = (dataDir: string, mode: ControlMode, nowMs: number): Promise<void> =>
  writeAtomically(controlPath(dataDir), JSON.stringify({ mode, requestedAtMs: nowMs }));

/** The flag without which the hard stop is refused. It names what the stop does. */
export const CONFIRM_STOP_FLAG = "--confirm-strands-users";

export const STOP_STRANDS_USERS =
  "While it is stopped nobody can close a position against it, so users keep the positions they hold " +
  'until it is resumed with the kill switch "resume". The exchange admin can pause the market in the meantime. ' +
  "Liquidations are the exchange's own keeper's job and go on.";

export type KillSwitchRequest =
  { ok: true; mode: ControlMode; meaning: string } | { ok: false; message: string };

export const KILL_SWITCH_USAGE = [
  `Usage: node dist/kill-switch.js reduce | resume | stop ${CONFIRM_STOP_FLAG}`,
  "  reduce: the soft stop. The maker cancels the quotes that would grow its position and keeps quoting the side that shrinks it, so users can still close",
  `  stop: the hard stop. The maker cancels every quote and quotes nothing, so users cannot close until it is resumed. It is refused without ${CONFIRM_STOP_FLAG}`,
  "  resume: the maker quotes both sides again, and its loss limits count from its equity now",
  "Run it on the machine the service runs on, with the same DATA_DIR as the service.",
].join("\n");

/** What the kill switch was asked for, or why it refuses. Nothing is written for a refusal. */
export const killSwitchRequest = (args: string[]): KillSwitchRequest => {
  const [word, ...flags] = args;
  const unknown = flags.filter((flag) => flag !== CONFIRM_STOP_FLAG);
  if (unknown.length > 0 || (flags.length > 0 && word !== "stop")) {
    return { ok: false, message: KILL_SWITCH_USAGE };
  }
  if (word === "reduce") {
    return {
      ok: true,
      mode: "reduce",
      meaning:
        "the maker cancels the quotes that would grow its position and keeps quoting the side that shrinks it",
    };
  }
  if (word === "resume") {
    return {
      ok: true,
      mode: "run",
      meaning: "the maker quotes both sides again, and its loss limits count from its equity now",
    };
  }
  if (word === "stop") {
    if (!flags.includes(CONFIRM_STOP_FLAG)) {
      return {
        ok: false,
        message:
          `Refused: "stop" cancels every quote and quotes nothing. ${STOP_STRANDS_USERS}\n` +
          `If that is what you want, run it again with ${CONFIRM_STOP_FLAG}. ` +
          'To only stop it growing its position, use "reduce".',
      };
    }
    return {
      ok: true,
      mode: "stopped",
      meaning: `the maker cancels every quote and quotes nothing. ${STOP_STRANDS_USERS}`,
    };
  }
  return { ok: false, message: KILL_SWITCH_USAGE };
};

export class MakerControl {
  constructor(private readonly path: string) {}

  /**
   * The command in the file, or null when there is none. A file that cannot
   * be read throws: the maker then holds itself at the soft stop until somebody
   * fixes the file and resumes it.
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
