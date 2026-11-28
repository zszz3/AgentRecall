import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { deleteLocalSessionSources, sessionSourceDeletionPaths } from "./session-source-delete";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };

describe("session source deletion", () => {
  it("rejects relative source paths before deleting anything", () => {
    expect(() => sessionSourceDeletionPaths([{
      source: "codex-cli",
      rawId: "relative",
      filePath: "sessions/relative.jsonl",
      isSubagent: false,
    }])).toThrow("Session source file path must be absolute.");
  });

  it("deletes Claude subagent files and owned companion directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-session-tree-delete-"));
    const parentId = "parent-session";
    const parentFile = path.join(root, `${parentId}.jsonl`);
    const sessionDirectory = path.join(root, parentId);
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const toolResultsDirectory = path.join(sessionDirectory, "tool-results");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const childMetadata = path.join(subagentsDirectory, "agent-child.meta.json");
    const unrelatedFile = path.join(sessionDirectory, "keep.txt");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.mkdirSync(toolResultsDirectory, { recursive: true });
    for (const filePath of [parentFile, childFile, childMetadata, unrelatedFile]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }

    try {
      deleteLocalSessionSources([
        { source: "claude-cli", rawId: parentId, filePath: parentFile, isSubagent: false },
        { source: "claude-cli", rawId: "child", filePath: childFile, isSubagent: true },
      ]);

      expect(fs.existsSync(parentFile)).toBe(false);
      expect(fs.existsSync(subagentsDirectory)).toBe(false);
      expect(fs.existsSync(toolResultsDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
      expect(fs.existsSync(sessionDirectory)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("derives the same owned artifacts for Windows paths", () => {
    expect(sessionSourceDeletionPaths([
      {
        source: "claude-cli",
        rawId: "parent-session",
        filePath: "C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl",
        isSubagent: false,
      },
    ], path.win32)).toEqual({
      files: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session.jsonl"],
      directories: [
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\subagents",
        "C:\\Users\\me\\.claude\\projects\\repo\\parent-session\\tool-results",
      ],
      emptyDirectories: ["C:\\Users\\me\\.claude\\projects\\repo\\parent-session"],
      requiredAbsentFiles: [],
    });
    expect(sessionSourceDeletionPaths([{
      source: "claude-cli",
      rawId: "child",
      filePath: "C:\\Users\\me\\.claude\\projects\\repo\\missing-parent\\subagents\\agent-child.jsonl",
      isSubagent: true,
      orphanedParentSessionId: "missing-parent",
    }], path.win32).requiredAbsentFiles).toEqual([
      "C:\\Users\\me\\.claude\\projects\\repo\\missing-parent.jsonl",
    ]);
  });

  it("adds only the omp session's own artifact folder", () => {
    const bucket = "/home/me/.omp/agent/sessions/--work--";
    expect(sessionSourceDeletionPaths([
      { source: "omp-cli", rawId: "root-id", filePath: `${bucket}/2026-11-27T14-03-03-110Z_root-id.jsonl`, isSubagent: false },
      { source: "omp-cli", rawId: "child-id", filePath: `${bucket}/2026-11-27T14-03-03-110Z_root-id/AgentX.jsonl`, isSubagent: true },
    ], path.posix)).toEqual({
      files: [
        `${bucket}/2026-11-27T14-03-03-110Z_root-id.jsonl`,
        `${bucket}/2026-11-27T14-03-03-110Z_root-id/AgentX.jsonl`,
      ],
      directories: [
        `${bucket}/2026-11-27T14-03-03-110Z_root-id`,
        `${bucket}/2026-11-27T14-03-03-110Z_root-id/AgentX`,
      ],
      emptyDirectories: [],
      requiredAbsentFiles: [],
    });
    // A root file whose name does not carry its session id never claims a folder.
    expect(sessionSourceDeletionPaths([
      { source: "omp-cli", rawId: "root-id", filePath: `${bucket}/renamed.jsonl`, isSubagent: false },
    ], path.posix).directories).toEqual([]);
  });

  it("removes the complete artifact directory for an orphaned Claude family", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-orphan-tree-delete-"));
    const sessionDirectory = path.join(root, "missing-parent");
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const toolResultsDirectory = path.join(sessionDirectory, "tool-results");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    const siblingFile = path.join(subagentsDirectory, "agent-sibling.jsonl");
    const unrelatedFile = path.join(sessionDirectory, "keep.txt");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.mkdirSync(toolResultsDirectory, { recursive: true });
    for (const filePath of [childFile, siblingFile, path.join(toolResultsDirectory, "tool.txt"), unrelatedFile]) {
      fs.writeFileSync(filePath, "fixture", "utf8");
    }

    try {
      deleteLocalSessionSources([{
        source: "claude-cli",
        rawId: "child",
        filePath: childFile,
        isSubagent: true,
        orphanedParentSessionId: "missing-parent",
      }]);

      expect(fs.existsSync(subagentsDirectory)).toBe(false);
      expect(fs.existsSync(toolResultsDirectory)).toBe(false);
      expect(fs.existsSync(unrelatedFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates every path before deleting any source file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-atomic-source-delete-"));
    const validFile = path.join(root, "valid.jsonl");
    const invalidDirectory = path.join(root, "invalid.jsonl");
    fs.writeFileSync(validFile, "fixture", "utf8");
    fs.mkdirSync(invalidDirectory);

    try {
      expect(() => deleteLocalSessionSources([
        { source: "codex-cli", rawId: "valid", filePath: validFile, isSubagent: false },
        { source: "codex-cli", rawId: "invalid", filePath: invalidDirectory, isSubagent: false },
      ])).toThrow("Refusing to delete a directory as a session file.");
      expect(fs.existsSync(validFile)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps an orphan candidate untouched when its parent source still exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-orphan-parent-guard-"));
    const parentId = "missing-from-index";
    const parentFile = path.join(root, `${parentId}.jsonl`);
    const sessionDirectory = path.join(root, parentId);
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.writeFileSync(parentFile, "parent", "utf8");
    fs.writeFileSync(childFile, "child", "utf8");

    try {
      expect(() => deleteLocalSessionSources([{
        source: "claude-cli",
        rawId: "child",
        filePath: childFile,
        isSubagent: true,
        orphanedParentSessionId: parentId,
      }])).toThrow("parent session source still exists");
      expect(fs.existsSync(parentFile)).toBe(true);
      expect(fs.existsSync(childFile)).toBe(true);
      expect(fs.existsSync(subagentsDirectory)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale Codex App state rows when the rollout file is already missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-app-state-delete-"));
    const codexHome = path.join(root, ".codex");
    const rolloutPath = path.join(codexHome, "sessions", "2026", "08", "18", "rollout-stale.jsonl");
    const statePath = path.join(codexHome, "state_1.sqlite");
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const childId = "650e8400-e29b-41d4-a716-446655440000";
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: sessionId, thread_name: "stale" })}\n${JSON.stringify({ id: "keep", thread_name: "keep" })}\n`,
    );
    const db = new DatabaseSync(statePath);
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY);
    `);
    db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(sessionId, rolloutPath);
    db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(childId, `${rolloutPath}.child`);
    db.prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)").run(sessionId, childId);
    db.close();

    try {
      deleteLocalSessionSources([{
        source: "codex-app",
        rawId: sessionId,
        filePath: rolloutPath,
        isSubagent: false,
      }]);

      const verify = new DatabaseSync(statePath);
      try {
        expect(verify.prepare("SELECT id FROM threads WHERE id = ?").get(sessionId)).toBeUndefined();
        expect(verify.prepare("SELECT id FROM threads WHERE id = ?").get(childId)).toBeUndefined();
        expect(verify.prepare("SELECT child_thread_id FROM thread_spawn_edges WHERE parent_thread_id = ?").get(sessionId)).toBeUndefined();
      } finally {
        verify.close();
      }
      expect(fs.readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8")).toBe(
        `${JSON.stringify({ id: "keep", thread_name: "keep" })}\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail source deletion when Codex state cleanup is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-codex-app-state-best-effort-"));
    const codexHome = path.join(root, ".codex");
    const rolloutPath = path.join(codexHome, "sessions", "2026", "08", "19", "rollout-busy.jsonl");
    const statePath = path.join(codexHome, "state_1.sqlite");
    const sessionId = "750e8400-e29b-41d4-a716-446655440000";
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, "fixture", "utf8");
    fs.writeFileSync(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: sessionId, thread_name: "busy" })}\n`,
    );
    const db = new DatabaseSync(statePath);
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL);
      CREATE TRIGGER block_thread_delete
      BEFORE DELETE ON threads
      BEGIN
        SELECT RAISE(ABORT, 'state cleanup blocked');
      END;
    `);
    db.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run(sessionId, rolloutPath);
    db.close();

    try {
      expect(() => deleteLocalSessionSources([{
        source: "codex-app",
        rawId: sessionId,
        filePath: rolloutPath,
        isSubagent: false,
      }])).not.toThrow();
      expect(fs.existsSync(rolloutPath)).toBe(false);
      expect(fs.readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8")).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
