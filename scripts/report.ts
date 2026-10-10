import { mkdir, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { join } from "node:path";

const REPORT_DIR = "loadtest-reports";
const BYTES_PER_GIB = 1024 ** 3;

/** The value after `name` on the command line, or `fallback`. */
export const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 || at === process.argv.length - 1 ? fallback : process.argv[at + 1];
};

/** The machine a load test ran on: its numbers mean nothing without it. */
export const machine = () => ({
  platform: platform(),
  release: release(),
  hostname: hostname(),
  cpuCount: cpus().length,
  cpuModel: cpus()[0]?.model ?? "unknown",
  totalMemoryGiB: Math.round(totalmem() / BYTES_PER_GIB),
  nodeVersion: process.version,
});

/** Prints the report and writes it to `loadtest-reports/<name>`. Returns the path. */
export const writeReport = async (name: string, content: string): Promise<string> => {
  await mkdir(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, name);
  await writeFile(path, content);
  return path;
};
