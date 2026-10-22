import { requestMode } from "./bots/maker-control.js";
import type { MakerMode } from "./bots/maker-state.js";

const REQUESTS: Record<string, { mode: MakerMode; meaning: string }> = {
  reduce: {
    mode: "reduce",
    meaning:
      "the maker cancels the quotes that would grow its position and keeps quoting the side that shrinks it",
  },
  stop: {
    mode: "stopped",
    meaning: "the maker cancels every quote and quotes nothing",
  },
  resume: {
    mode: "run",
    meaning: "the maker quotes both sides again, and its loss limits count from its equity now",
  },
};

const usage = (): never => {
  console.error(
    [
      "Usage: node dist/kill-switch.js reduce | stop | resume",
      ...Object.entries(REQUESTS).map(([word, { meaning }]) => `  ${word}: ${meaning}`),
      "Run it on the machine the service runs on, with the same DATA_DIR as the service.",
    ].join("\n"),
  );
  return process.exit(2);
};

const main = async (): Promise<void> => {
  const request = REQUESTS[process.argv[2] ?? ""];
  if (!request) return usage();
  const dataDir = process.env.DATA_DIR ?? "./data";
  await requestMode(dataDir, request.mode, Date.now());
  console.log(
    `Written to ${dataDir}. Within a second, ${request.meaning}. ` +
      "The service's log says when it has followed it, and the choice survives a restart.",
  );
};

main().catch((error) => {
  console.error(
    `The kill switch did not write its request, so nothing changed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
});
