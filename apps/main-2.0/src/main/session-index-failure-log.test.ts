import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionIndexFailureDiagnostic } from "../core/indexer";
import { createSessionIndexFailureLogger } from "./session-index-failure-log";

// A configurable module facade lets each storage-failure case intercept one
// operation without trying to redefine Node's immutable ESM namespace exports.
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

function diagnostic(sessionKey: string): SessionIndexFailureDiagnostic {
  return {
    source: "codex-cli",
    sessionKey,
    filePath: `/tmp/${sessionKey}.jsonl`,
    error: {
      name: "Error",
      message: `Could not index ${sessionKey}`,
      stack: `Error: Could not index ${sessionKey}\n    at test`,
    },
  };
}

describe("session index failure log", () => {
  it("writes only the approved diagnostic fields to a user-only JSONL file", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const logger = createSessionIndexFailureLogger(userDataPath, {
        now: () => new Date("2026-07-30T12:00:00.000Z"),
      });

      await logger.write({
        ...diagnostic("codex:one"),
        messages: [{ role: "user", content: "must not be logged" }],
      } as SessionIndexFailureDiagnostic);

      expect(logger.logPath).toBe(path.join(userDataPath, "logs", "session-index-failures.jsonl"));
      const record = JSON.parse(fs.readFileSync(logger.logPath, "utf8").trim()) as Record<string, unknown>;
      expect(record).toEqual({
        timestamp: "2026-07-30T12:00:00.000Z",
        fingerprint: expect.any(String),
        count: 1,
        firstSeen: "2026-07-30T12:00:00.000Z",
        lastSeen: "2026-07-30T12:00:00.000Z",
        source: "codex-cli",
        sessionKey: "codex:one",
        filePath: "/tmp/codex:one.jsonl",
        error: {
          name: "Error",
          message: "Could not index codex:one",
          stack: "Error: Could not index codex:one\n    at test",
        },
      });
      expect(record).not.toHaveProperty("messages");
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(logger.logPath)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(logger.logPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it("aggregates concurrent repeated failures across logger restarts without losing firstSeen", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      let now = new Date("2026-09-20T00:00:00Z");
      const entry = { ...diagnostic("codex:one"), revision: { fileMtimeMs: 1, fileSize: 10 } };
      let logger = createSessionIndexFailureLogger(root, { now: () => now });
      await logger.write(entry);
      now = new Date("2026-09-20T00:01:00Z");
      logger = createSessionIndexFailureLogger(root, { now: () => now });
      await Promise.all(Array.from({ length: 20 }, () => logger.write(entry)));
      const records = fs.readFileSync(logger.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ count: 21, firstSeen: "2026-09-20T00:00:00.000Z", lastSeen: "2026-09-20T00:01:00.000Z" });
      await logger.write({ ...entry, revision: { fileMtimeMs: 2, fileSize: 10 } });
      await logger.write({ ...entry, sessionKey: "codex:two" });
      expect(fs.readFileSync(logger.logPath, "utf8").trim().split("\n")).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps only the current log and one rotated log", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const logger = createSessionIndexFailureLogger(userDataPath, { maxBytes: 1 });

      await logger.write(diagnostic("codex:one"));
      await logger.write(diagnostic("codex:two"));
      await logger.write(diagnostic("codex:three"));

      const previousPath = path.join(userDataPath, "logs", "session-index-failures.previous.jsonl");
      expect(JSON.parse(fs.readFileSync(previousPath, "utf8")).sessionKey).toBe("codex:two");
      expect(JSON.parse(fs.readFileSync(logger.logPath, "utf8")).sessionKey).toBe("codex:three");
      expect(fs.readdirSync(path.dirname(logger.logPath)).sort()).toEqual([
        "session-index-failures.jsonl",
        "session-index-failures.previous.jsonl",
      ]);
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it.each([
    ["new", "below", 1000], ["new", "at", 0], ["new", "above", -1],
    ["existing", "below", 1000], ["existing", "at", 0], ["existing", "above", -1],
  ] as const)("retains the active %s failure when the old log is %s the threshold", async (kind, boundary, allowance) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const firstSeen = "2026-09-20T00:00:00.000Z";
      const lastSeen = "2026-09-20T00:01:00.000Z";
      const initial = createSessionIndexFailureLogger(root, { now: () => new Date(firstSeen) });
      await initial.write(diagnostic("codex:other"));
      await initial.write(diagnostic("codex:one"));
      const before = fs.readFileSync(initial.logPath, "utf8");
      const logger = createSessionIndexFailureLogger(root, {
        maxBytes: Buffer.byteLength(before) + allowance, now: () => new Date(lastSeen),
      });
      const active = diagnostic(kind === "new" ? "codex:two" : "codex:one");
      await logger.write(active);
      const records = fs.readFileSync(logger.logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records.find(record => record.sessionKey === active.sessionKey)).toMatchObject({
        ...active, count: kind === "new" ? 1 : 2,
        firstSeen: kind === "new" ? lastSeen : firstSeen, lastSeen,
      });
      const previousPath = path.join(root, "logs", "session-index-failures.previous.jsonl");
      if (boundary === "below") {
        expect(records).toHaveLength(kind === "new" ? 3 : 2);
        expect(fs.existsSync(previousPath)).toBe(false);
      } else {
        expect(records).toHaveLength(1);
        expect(fs.readFileSync(previousPath, "utf8")).toBe(before);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["new", "existing"])("rotates before a pending %s record overflows the UTF-8 byte threshold", async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const initial = createSessionIndexFailureLogger(root);
      await initial.write(diagnostic("codex:other"));
      await initial.write(diagnostic("codex:one"));
      const before = fs.readFileSync(initial.logPath, "utf8");
      const active = diagnostic(kind === "new" ? "codex:two" : "codex:one");
      active.error.stack = "合成诊断".repeat(100);
      const maxBytes = Buffer.byteLength(before) + 1;
      const logger = createSessionIndexFailureLogger(root, { maxBytes });
      await logger.write(active);
      const current = fs.readFileSync(logger.logPath, "utf8");
      const record = JSON.parse(current);
      expect(record).toMatchObject({ ...active, count: kind === "new" ? 1 : 2 });
      expect(fs.readFileSync(path.join(root, "logs", "session-index-failures.previous.jsonl"), "utf8")).toBe(before);
      // Oversized individual diagnostics remain complete, including metadata and
      // the JSONL newline; subsequent repeats still update a single aggregate.
      expect(Buffer.byteLength(current)).toBeGreaterThan(maxBytes);
      await logger.write(active);
      expect(JSON.parse(fs.readFileSync(logger.logPath, "utf8"))).toMatchObject({
        ...active, firstSeen: record.firstSeen, count: record.count + 1,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a complete JSONL value exactly at the threshold, then rotates its next update", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const now = () => new Date("2026-09-20T00:00:00.000Z");
      const initial = createSessionIndexFailureLogger(root, { now });
      await initial.write(diagnostic("codex:one"));
      const before = fs.readFileSync(initial.logPath, "utf8");
      await initial.write(diagnostic("codex:two"));
      const maxBytes = fs.statSync(initial.logPath).size;
      fs.writeFileSync(initial.logPath, before);
      const logger = createSessionIndexFailureLogger(root, { now, maxBytes });
      const previousPath = path.join(root, "logs", "session-index-failures.previous.jsonl");
      await logger.write(diagnostic("codex:two"));
      expect(fs.statSync(logger.logPath).size).toBe(maxBytes);
      expect(fs.existsSync(previousPath)).toBe(false);
      await logger.write(diagnostic("codex:two"));
      expect(JSON.parse(fs.readFileSync(logger.logPath, "utf8"))).toMatchObject({ sessionKey: "codex:two", count: 2 });
      expect(fs.statSync(previousPath).size).toBe(maxBytes);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["writeFile", "copyFile", "rename"] as const)("preserves the active aggregate when rotation %s fails, then retries", async operation => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    try {
      const io = vi.spyOn(fsPromises, operation);
      let now = new Date("2026-09-20T00:00:00.000Z");
      const initial = createSessionIndexFailureLogger(root, { now: () => now });
      const entry = diagnostic("codex:one");
      await initial.write(entry);
      await initial.write(entry);
      await initial.write(diagnostic("codex:other"));
      const before = fs.readFileSync(initial.logPath, "utf8");
      const previousPath = path.join(root, "logs", "session-index-failures.previous.jsonl");
      fs.writeFileSync(previousPath, "older diagnostic evidence\n");
      const logger = createSessionIndexFailureLogger(root, { maxBytes: Buffer.byteLength(before), now: () => now });
      now = new Date("2026-09-20T00:01:00.000Z");
      io.mockRejectedValueOnce(Object.assign(new Error("Synthetic storage failure"), { code: "ENOSPC" }));
      await expect(logger.write(entry)).rejects.toMatchObject({ code: "ENOSPC" });
      expect(fs.readFileSync(logger.logPath, "utf8")).toBe(before);
      expect(fs.existsSync(`${logger.logPath}.tmp`)).toBe(false);
      if (operation === "writeFile") {
        expect(fs.readFileSync(previousPath, "utf8")).toBe("older diagnostic evidence\n");
      }
      now = new Date("2026-09-20T00:02:00.000Z");
      await logger.write(entry);
      expect(JSON.parse(fs.readFileSync(logger.logPath, "utf8"))).toMatchObject({
        ...entry, count: 3, firstSeen: "2026-09-20T00:00:00.000Z", lastSeen: now.toISOString(),
      });
      expect(fs.readFileSync(previousPath, "utf8")).toBe(before);
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects when the user-data log directory cannot be created", async () => {
    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-index-log-"));
    const blockingPath = path.join(tempPath, "not-a-directory");
    fs.writeFileSync(blockingPath, "file");
    try {
      const logger = createSessionIndexFailureLogger(blockingPath);
      await expect(logger.write(diagnostic("codex:one"))).rejects.toThrow();
    } finally {
      fs.rmSync(tempPath, { recursive: true, force: true });
    }
  });
});
