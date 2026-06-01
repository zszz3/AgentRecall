import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadClaudeCliSessions, loadCodexSessionFile, parseCodexSessionMetaLine } from "./session-loader";

describe("Codex session loading", () => {
  it("extracts id, cwd, originator, first question, and visible messages from a rollout file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-1", cwd: "/repo", originator: "Codex Desktop", git: { branch: "feat/session-tags" } },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md\nnoise" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "修复登录态失效" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:03:00Z",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "我来检查 auth 逻辑" }] },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session).toMatchObject({
      sessionKey: "codex:codex-1",
      rawId: "codex-1",
      source: "codex-app",
      projectPath: "/repo",
      firstQuestion: "修复登录态失效",
      originalTitle: "修复登录态失效",
      gitBranch: "feat/session-tags",
    });
    expect(loaded?.messages.map((m) => m.content)).toEqual(["修复登录态失效", "我来检查 auth 逻辑"]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses old and new Codex metadata lines", () => {
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id: "new-id", cwd: "/new", git: { branch: "feat/session-tags" } },
      }),
    ).toMatchObject({ id: "new-id", projectPath: "/new", gitBranch: "feat/session-tags" });

    expect(
      parseCodexSessionMetaLine({
        id: "old-id",
        timestamp: "2025-01-01T00:00:00Z",
        instructions: "...",
        git: { cwd: "/old" },
      }),
    ).toMatchObject({ id: "old-id", projectPath: "/old" });
  });
});

describe("Claude session loading", () => {
  it("extracts branch metadata from Claude Code jsonl rows", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-1",
          gitBranch: "feat/claude-tags",
          message: { role: "user", content: "修复会话列表" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-1",
          gitBranch: "feat/claude-tags",
          message: { role: "assistant", content: "我来处理" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "claude:claude-1",
      rawId: "claude-1",
      source: "claude-cli",
      projectPath: "/repo",
      gitBranch: "feat/claude-tags",
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
});
