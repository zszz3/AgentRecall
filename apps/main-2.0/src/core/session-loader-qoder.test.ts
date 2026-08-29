import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadQoderIdeSessions, loadQoderSessions } from "./session-loader";

const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentrecall-qoder-v2-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Qoder session loading", () => {
  it("loads new Qoder transcripts stored directly under projects/<slug>", () => {
    const root = temporaryRoot("cli-flat");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "5a5f525e-99bc-4c95-9f03-de30ef8c9a32.jsonl"), [
      { type: "workspace-directories", sessionId: "5a5f525e", directories: ["/Users/me/demo-app"] },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        gitBranch: "main",
        timestamp: "2026-08-21T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Fix the login bug" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-21T10:00:05.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "I will check the auth module." }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "qoder:5a5f525e-99bc-4c95-9f03-de30ef8c9a32",
      source: "qoder",
      projectPath: "/Users/me/demo-app",
      gitBranch: "main",
      firstQuestion: "Fix the login bug",
    });
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("loads new Qoder transcripts from the nested transcript directory and prefers ai-title", () => {
    const root = temporaryRoot("cli-nested");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "transcript", "428f5d29.jsonl"), [
      { type: "ai-title", sessionId: "428f5d29", aiTitle: "Refactor the auth module" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "text", text: "Please refactor auth" }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.rawId).toBe("428f5d29");
    expect(loaded[0].session.originalTitle).toBe("Refactor the auth module");
  });

  it("skips new Qoder tool-execution traces that contain no readable messages", () => {
    const root = temporaryRoot("cli-trace");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "transcript", "trace-only.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      },
      { type: "progress", uuid: "p1", parentUuid: "u1" },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] },
      },
    ]);

    expect(loadQoderSessions(root)).toEqual([]);
  });

  it("keeps legacy Qoder IDE sessions visible next to the new projects layout", () => {
    const root = temporaryRoot("prefer-projects");
    writeJsonl(path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-ide", "task-ide.jsonl"), [
      { role: "user", message: { content: [{ type: "text", text: "IDE question" }] } },
    ]);
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "cli-session.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        message: { role: "user", content: [{ type: "text", text: "CLI question" }] },
      },
    ]);
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "compaction", "not-a-transcript.jsonl"), [
      { kind: "summary", tokens: 42 },
    ]);

    const current = loadQoderSessions(root);
    expect(current.map((entry) => entry.session.firstQuestion)).toEqual(["CLI question"]);
    expect(current.map((entry) => entry.session.source)).toEqual(["qoder"]);

    const legacy = loadQoderIdeSessions(root);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].session).toMatchObject({
      source: "qoder-ide",
      sessionKey: "qoder-ide:demo-app-1a2b3c4d/task-ide",
      firstQuestion: "IDE question",
    });
  });

  it("loads the legacy conversation-history tree when the projects layout is absent", () => {
    const root = temporaryRoot("legacy-only");
    writeJsonl(path.join(root, "cache", "projects", "demo-app-1a2b3c4d", "conversation-history", "task-ide", "task-ide.jsonl"), [
      { role: "user", message: { content: [{ type: "text", text: "IDE question" }] } },
    ]);

    expect(loadQoderSessions(root)).toEqual([]);
    expect(loadQoderIdeSessions(root).map((entry) => entry.session.firstQuestion)).toEqual(["IDE question"]);
  });

  it("drops execution transcripts that duplicate a canonical session but keeps unique runs", () => {
    const root = temporaryRoot("execution-dedupe");
    const slugDir = path.join(root, "projects", "-Users-me-demo-app");
    writeJsonl(path.join(slugDir, "9b1c2d3e.jsonl"), [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:54.457Z",
        message: { role: "user", content: [{ type: "text", text: "Run the long task" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:56.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
      },
    ]);
    writeJsonl(path.join(slugDir, "transcript", "task-dup1.session.execution.jsonl"), [
      {
        type: "user",
        uuid: "x1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:54.457Z",
        message: { role: "user", content: [{ type: "text", text: "Run the long task" }] },
      },
      {
        type: "assistant",
        uuid: "x2",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-09T03:57:55.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Working..." }] },
      },
    ]);
    writeJsonl(path.join(slugDir, "transcript", "task-uniq2.session.execution.jsonl"), [
      {
        type: "user",
        uuid: "y1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-08-08T07:56:17.000Z",
        message: { role: "user", content: [{ type: "text", text: "Continue the review" }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded.map((entry) => entry.session.firstQuestion).sort()).toEqual(["Continue the review", "Run the long task"]);
    expect(loaded.map((entry) => entry.session.rawId).sort()).toEqual(["9b1c2d3e", "task-uniq2.session.execution"]);
  });

  it("keeps every message of transcripts whose turns carry no parentUuid links", () => {
    const root = temporaryRoot("unchained");
    writeJsonl(path.join(root, "projects", "-Users-me-demo-app", "transcript", "task-flat.session.execution.jsonl"), [
      { type: "session_meta", sessionId: "task-flat.session.execution", uuid: "m1" },
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:17:17.000Z",
        message: { role: "user", content: "Install this tool" },
      },
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:17:24.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Downloading it now." }] },
      },
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: null,
        cwd: "/Users/me/demo-app",
        timestamp: "2026-07-27T07:18:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
    ]);

    const loaded = loadQoderSessions(root);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session.firstQuestion).toBe("Install this tool");
    expect(loaded[0].messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
  });
});
