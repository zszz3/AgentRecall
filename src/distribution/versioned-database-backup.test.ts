import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVersionedDatabaseBackupLifecycle } from "./versioned-database-backup";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
  temporaryDirectories.clear();
});

describe("versioned database backup lifecycle", () => {
  it("closes the synthetic database and writes a versioned backup manifest", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-recall-native-backup-"));
    temporaryDirectories.add(home);
    const databasePath = path.join(home, "user-data", "session-search.sqlite");
    await writeFile(databasePath, "synthetic database", { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.dirname(databasePath), { recursive: true });
      await writeFile(databasePath, "synthetic database");
    });
    const closeDatabase = vi.fn();
    const lifecycle = createVersionedDatabaseBackupLifecycle({
      databasePath,
      backupRoot: path.join(home, "update-backups"),
      closeDatabase,
      now: () => new Date("2026-07-25T10:11:12.345Z"),
    });

    const result = await lifecycle.prepareForUpdate({
      currentVersion: "0.9.0",
      targetVersion: "1.0.0",
    });

    expect(closeDatabase).toHaveBeenCalledOnce();
    expect(path.basename(result.backupPath)).toBe(
      "from-0.9.0-to-1.0.0-2026-07-25T10-11-12-345Z",
    );
    expect(await readFile(path.join(result.backupPath, "session-search.sqlite"), "utf8"))
      .toBe("synthetic database");
    expect(JSON.parse(await readFile(path.join(result.backupPath, "backup.json"), "utf8")))
      .toMatchObject({
        schemaVersion: 1,
        fromVersion: "0.9.0",
        targetVersion: "1.0.0",
        files: ["session-search.sqlite"],
      });
  });

  it("removes an incomplete backup and reopens the database after failure", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-recall-native-backup-"));
    temporaryDirectories.add(home);
    const reopen = vi.fn();
    const lifecycle = createVersionedDatabaseBackupLifecycle({
      databasePath: path.join(home, "missing.sqlite"),
      backupRoot: path.join(home, "update-backups"),
      closeDatabase: vi.fn(),
      reopenDatabaseAfterFailure: reopen,
      now: () => new Date("2026-07-25T10:11:12.345Z"),
    });

    await expect(lifecycle.prepareForUpdate({
      currentVersion: "0.9.0",
      targetVersion: "1.0.0",
    })).rejects.toThrow("does not exist");
    expect(reopen).toHaveBeenCalledOnce();
  });
});
