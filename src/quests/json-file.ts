import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * One JSON record on disk, written to a temporary file and renamed into place. A file that exists
 * and cannot be read stops the start rather than being forgotten.
 */
export class JsonFile<T> {
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly schema: z.ZodType<T>,
    private readonly empty: () => T,
  ) {}

  load(): T {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw new Error(
        `the quest record at ${this.path} cannot be read. Fix its permissions or restore it from a backup: ` +
          "quests will not start without it, because it would forget what was earned.",
      );
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.trim() || "null");
    } catch {
      parsed = null;
    }
    const result = this.schema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `the quest record at ${this.path} is not in the form this service writes. ` +
          "Restore it from a backup: quests will not start without it, because it would forget what was earned.",
      );
    }
    return result.data;
  }

  save(value: T): Promise<void> {
    const text = JSON.stringify(value);
    const write = this.saving.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeFile(`${this.path}.tmp`, text, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    this.saving = write.catch(() => {});
    return write;
  }
}
