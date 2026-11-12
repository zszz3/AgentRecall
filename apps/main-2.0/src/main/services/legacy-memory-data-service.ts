import fs from "node:fs/promises";
import path from "node:path";
import type { LegacyMemoryDataStatus } from "../../shared/ipc/legacy-memory-data";

export interface LegacyMemoryDataServiceOptions {
  /** `<userData>/openviking`, which held the retired runtime, models and memory store. */
  dataDir: string;
  /** Home-directory pointer the retired feature wrote for its hooks and MCP tools. */
  pointerPath: string;
  removeDirectory?: (target: string) => Promise<void>;
}

/**
 * Owns the on-disk data of the retired directory Memory feature. The directory
 * can hold several gigabytes, so it is only measured and deleted when the user
 * asks; nothing here runs at startup.
 */
export class LegacyMemoryDataService {
  private removal: Promise<LegacyMemoryDataStatus> | null = null;

  constructor(private readonly options: LegacyMemoryDataServiceOptions) {}

  async status(): Promise<LegacyMemoryDataStatus> {
    const sizeBytes = await directorySize(this.options.dataDir);
    return sizeBytes === null ? { present: false, sizeBytes: 0 } : { present: true, sizeBytes };
  }

  /** Overlapping requests share the running deletion; a failed deletion can be retried. */
  remove(): Promise<LegacyMemoryDataStatus> {
    this.removal ??= this.performRemoval().finally(() => {
      this.removal = null;
    });
    return this.removal;
  }

  private async performRemoval(): Promise<LegacyMemoryDataStatus> {
    const removeDirectory = this.options.removeDirectory
      ?? ((target: string) => fs.rm(target, { recursive: true, force: true }));
    // fs.rm removes symbolic links themselves and never descends into their targets.
    await removeDirectory(this.options.dataDir);
    await fs.rm(this.options.pointerPath, { force: true });
    return this.status();
  }
}

/** Returns null when the directory does not exist. Symbolic links count as themselves, not their targets. */
async function directorySize(root: string): Promise<number | null> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!rootStat.isDirectory()) return rootStat.size;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      try {
        total += (await fs.lstat(entryPath)).size;
      } catch (error) {
        // A file removed while measuring no longer occupies space.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}
