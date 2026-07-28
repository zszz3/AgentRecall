import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadCodexSessionRows } from "./session-loader";
import { readSessionSourceArtifacts } from "./session-source-archive";
import type { SessionSearchResult } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function session(overrides: Partial<SessionSearchResult> = {}): SessionSearchResult {
  return {
    sessionKey: "codex:session-1",
    rawId: "session-1",
    source: "codex-cli",
    projectPath: "/repo",
    filePath: "/tmp/session-1.jsonl",
    originalTitle: "Session",
    firstQuestion: "Question",
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    displayTitle: "Session",
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 1,
    messageCount: 1,
    aiSummary: null,
    aiSummaryStale: false,
    ...overrides,
  };
}

function cursorStatePath(homeDir: string): string {
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function writeCursorDatabase(filePath: string, composerId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);
  `);
  db.prepare("INSERT INTO composerHeaders (composerId, createdAt, value) VALUES (?, ?, ?)")
    .run(composerId, 123, Buffer.from('{"name":"Raw Cursor title"}'));
  const insert = db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  insert.run(`composerData:${composerId}`, Buffer.from('{"fullConversationHeadersOnly":[]}'));
  insert.run(`bubbleId:${composerId}:visible`, Buffer.from('{"text":"visible"}'));
  insert.run(`bubbleId:${composerId}:discarded`, Buffer.from('{"text":"discarded hidden branch"}'));
  insert.run(`checkpointId:${composerId}:checkpoint-1`, Buffer.from('{"state":"discarded checkpoint"}'));
  insert.run(`ofsContent:${composerId}:file-1`, Buffer.from("exact file snapshot"));
  insert.run("bubbleId:another-session:private", Buffer.from('{"text":"unrelated"}'));
  db.close();
}

describe("session source archive", () => {
  it("preserves an ordinary session file byte for byte", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-source-file-"));
    try {
      const filePath = path.join(directory, "rollout.jsonl");
      const content = Buffer.from('{"type":"message","payload":"\\u0000 exact"}\\n');
      fs.writeFileSync(filePath, content);

      const [artifact] = readSessionSourceArtifacts(session({ filePath }));

      expect(artifact.kind).toBe("session-file");
      expect(Buffer.from(artifact.bytes)).toEqual(content);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps rolled-back rows in the archive while hiding them from visible Codex messages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-rollback-source-"));
    try {
      const filePath = path.join(directory, "rollout.jsonl");
      const rows = [
        { type: "session_meta", payload: { id: "codex-rollback", cwd: "/repo" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "discarded question" }] } },
        { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "visible question" }] } },
      ];
      const content = rows.map((row) => JSON.stringify(row)).join("\n");
      fs.writeFileSync(filePath, content);

      const loaded = loadCodexSessionRows(filePath, rows);
      const [artifact] = readSessionSourceArtifacts(session({ rawId: "codex-rollback", filePath }));

      expect(loaded?.messages.map((message) => message.content)).toEqual(["visible question"]);
      expect(Buffer.from(artifact.bytes).toString("utf8")).toBe(content);
      expect(Buffer.from(artifact.bytes).toString("utf8")).toContain("discarded question");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the complete selected Cursor state without unrelated conversations", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-cursor-source-"));
    try {
      const composerId = "cursor-session-1";
      const transcriptPath = path.join(
        homeDir,
        ".cursor",
        "projects",
        "repo",
        "agent-transcripts",
        composerId,
        `${composerId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, '{"role":"user","message":"visible"}');
      writeCursorDatabase(cursorStatePath(homeDir), composerId);

      const artifacts = readSessionSourceArtifacts(session({
        sessionKey: `cursor:repo:${composerId}`,
        rawId: composerId,
        source: "cursor-agent",
        filePath: transcriptPath,
      }));
      const serialized = Buffer.from(artifacts[1].bytes).toString("utf8");

      expect(artifacts.map((artifact) => artifact.kind)).toEqual(["session-file", "cursor-state"]);
      expect(serialized).toContain(Buffer.from('{"text":"discarded hidden branch"}').toString("base64"));
      expect(serialized).toContain(Buffer.from("exact file snapshot").toString("base64"));
      expect(serialized).not.toContain("another-session");
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("extracts only the selected CodeWiz session from its shared database", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-v2-codewiz-source-"));
    try {
      const databasePath = path.join(directory, "codewiz.db");
      const db = new DatabaseSync(databasePath);
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data BLOB);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data BLOB);
      `);
      db.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("selected", "Selected");
      db.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("unrelated", "Unrelated");
      db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("m1", "selected", Buffer.from("selected message"));
      db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run("m2", "unrelated", Buffer.from("unrelated message"));
      db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run("p1", "m1", Buffer.from("selected part"));
      db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run("p2", "m2", Buffer.from("unrelated part"));
      db.close();

      const [artifact] = readSessionSourceArtifacts(session({
        rawId: "selected",
        source: "codewiz-cli",
        filePath: databasePath,
      }));
      const serialized = Buffer.from(artifact.bytes).toString("utf8");

      expect(serialized).toContain(Buffer.from("selected message").toString("base64"));
      expect(serialized).toContain(Buffer.from("selected part").toString("base64"));
      expect(serialized).not.toContain(Buffer.from("unrelated message").toString("base64"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
