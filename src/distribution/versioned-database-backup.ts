import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NativeUpdateBackupLifecycle } from "./native-update-types";

export interface VersionedDatabaseBackupOptions {
  databasePath: string;
  backupRoot: string;
  closeDatabase(): Promise<void> | void;
  reopenDatabaseAfterFailure?(): Promise<void> | void;
  now?: () => Date;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function createVersionedDatabaseBackupLifecycle(
  options: VersionedDatabaseBackupOptions,
): NativeUpdateBackupLifecycle {
  return {
    async prepareForUpdate({ currentVersion, targetVersion }) {
      let backupDirectory: string | null = null;
      try {
        await options.closeDatabase();
        const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
        await fs.mkdir(options.backupRoot, { recursive: true });
        backupDirectory = path.join(
          options.backupRoot,
          `from-${safeSegment(currentVersion)}-to-${safeSegment(targetVersion)}-${timestamp}`,
        );
        await fs.mkdir(backupDirectory, { recursive: false });

        const copiedFiles: string[] = [];
        for (const suffix of ["", "-wal", "-shm"]) {
          const source = `${options.databasePath}${suffix}`;
          try {
            await fs.access(source);
          } catch {
            if (!suffix) throw new Error("The AgentRecall database does not exist.");
            continue;
          }
          const destinationName = `${path.basename(options.databasePath)}${suffix}`;
          await fs.copyFile(source, path.join(backupDirectory, destinationName));
          copiedFiles.push(destinationName);
        }

        await fs.writeFile(
          path.join(backupDirectory, "backup.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            product: "AgentRecall",
            fromVersion: currentVersion,
            targetVersion,
            createdAt: (options.now?.() ?? new Date()).toISOString(),
            files: copiedFiles,
          }, null, 2)}\n`,
          "utf8",
        );
        return { backupPath: backupDirectory };
      } catch (error) {
        if (backupDirectory) {
          await fs.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
        }
        await options.reopenDatabaseAfterFailure?.();
        throw error;
      }
    },
    async recoverAfterInstallLaunchFailure() {
      await options.reopenDatabaseAfterFailure?.();
    },
  };
}
