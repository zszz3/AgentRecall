import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionIndexFailureDiagnostic } from "../core/indexer";
import { indexFailureFingerprint } from "../core/session-index-failures";

const DEFAULT_MAX_BYTES = 1024 * 1024;

interface SessionIndexFailureLoggerOptions {
  maxBytes?: number;
  now?: () => Date;
}

export interface SessionIndexFailureLogger {
  logPath: string;
  write: (diagnostic: SessionIndexFailureDiagnostic) => Promise<void>;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function createSessionIndexFailureLogger(
  userDataPath: string,
  options: SessionIndexFailureLoggerOptions = {},
): SessionIndexFailureLogger {
  const logDirectory = path.join(userDataPath, "logs");
  const logPath = path.join(logDirectory, "session-index-failures.jsonl");
  const previousLogPath = path.join(logDirectory, "session-index-failures.previous.jsonl");
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const now = options.now ?? (() => new Date());
  let pending = Promise.resolve();

  return {
    logPath,
    write: (diagnostic) => {
      const write = pending.then(async () => {
        await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
        if (process.platform !== "win32") await fs.chmod(logDirectory, 0o700);

        const timestamp = now().toISOString();
        const fingerprint = indexFailureFingerprint(diagnostic);
        const record = {
          timestamp,
          fingerprint,
          firstSeen: timestamp,
          lastSeen: timestamp,
          count: 1,
          source: diagnostic.source,
          sessionKey: diagnostic.sessionKey,
          filePath: diagnostic.filePath,
          ...(diagnostic.revision ? { revision: diagnostic.revision } : {}),
          error: {
            name: diagnostic.error.name,
            message: diagnostic.error.message,
            stack: diagnostic.error.stack,
          },
        };
        let text = "";
        try {
          text = await fs.readFile(logPath, "utf8");
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
        // Keep historical (including partially written) lines as evidence. Only
        // aggregate records with our explicit fingerprint and valid counters.
        const lines = text.trimEnd().split("\n").filter(Boolean);
        let found = false;
        let activeLine = JSON.stringify(record);
        for (let index = 0; index < lines.length; index++) {
          let previous: Record<string, unknown>;
          try { previous = JSON.parse(lines[index]) as Record<string, unknown>; }
          catch { continue; } // Preserve a legacy partial line rather than discarding it.
          if (previous?.fingerprint !== fingerprint || !Number.isSafeInteger(previous.count)
            || typeof previous.count !== "number" || previous.count < 1
            || typeof previous.firstSeen !== "string") continue;
          activeLine = JSON.stringify({ ...record, firstSeen: previous.firstSeen, count: previous.count + 1 });
          lines[index] = activeLine;
          found = true;
          break;
        }
        if (!found) lines.push(activeLine);
        let nextText = `${lines.join("\n")}\n`;
        const rotate = text.length > 0
          && (Buffer.byteLength(text) >= maxBytes || Buffer.byteLength(nextText) > maxBytes);
        if (rotate) {
          // Carry the updated aggregate into the active log. A single oversized
          // diagnostic stays intact; maxBytes is a rotation threshold, not a
          // truncation limit that could discard the failure we need to diagnose.
          nextText = `${activeLine}\n`;
        }
        const temporary = `${logPath}.tmp`;
        try {
          await fs.writeFile(temporary, nextText, { encoding: "utf8", mode: 0o600 });
          // Keep the active aggregate until its replacement is ready, including
          // if archiving or the final rename fails. A retry must not reset count.
          if (rotate) await fs.copyFile(logPath, previousLogPath);
          await fs.rename(temporary, logPath);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      });
      // A failed write still rejects its caller but does not poison later writes.
      pending = write.catch(() => undefined);
      return write;
    },
  };
}
