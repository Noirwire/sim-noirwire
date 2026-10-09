import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandleSnapshotEntry } from "./candles.js";

export interface SnapshotData {
  savedAtMs: number;
  candles: CandleSnapshotEntry[];
  fundedAddresses: string[];
  /** Per market, the last on-chain fill sequence already recorded into the candles. */
  tapeCursors?: Record<string, number>;
}

const FILE_NAME = "snapshot.json";

/** The on-disk candle and fund-grant snapshot: written on an interval and on shutdown, read once at start. */
export class SnapshotStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly tempPath: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.filePath = join(dataDir, FILE_NAME);
    this.tempPath = join(dataDir, `${FILE_NAME}.tmp`);
  }

  async load(): Promise<SnapshotData | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as SnapshotData;
    } catch {
      return null;
    }
  }

  async save(data: SnapshotData): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.tempPath, JSON.stringify(data));
    await rename(this.tempPath, this.filePath);
  }
}
