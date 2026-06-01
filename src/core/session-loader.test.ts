import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadClaudeCliSessions, loadCodexSessionFile, loadCodexSessions, parseCodexSessionMetaLine } from "./session-loader";

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

  it("extracts Codex token usage from token_count events without double counting duplicates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-token-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 350,
                reasoning_output_tokens: 50,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: {
                input_tokens: 1200,
                cached_input_tokens: 200,
                output_tokens: 350,
                reasoning_output_tokens: 50,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 1000,
      outputTokens: 300,
      cachedInputTokens: 200,
      reasoningOutputTokens: 50,
      totalTokens: 1550,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex:gpt-5-codex:1000:300:200:50:0:0",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 300,
        cachedInputTokens: 200,
        reasoningOutputTokens: 50,
        totalTokens: 1550,
      },
    ]);

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

  it("loads Codex internal sessions with a separate source and session key namespace", () => {
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-internal-"));
    const sessionDir = path.join(codexDir, "sessions", "2026", "06", "01");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-internal-1", cwd: "/internal", git: { branch: "feat/internal" } },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "内部会话" }] },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessions(codexDir, "codex-internal");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "codex-internal:codex-internal-1",
      rawId: "codex-internal-1",
      source: "codex-internal",
      projectPath: "/internal",
      gitBranch: "feat/internal",
    });

    fs.rmSync(codexDir, { recursive: true, force: true });
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

  it("loads Claude internal sessions with a separate source and session key namespace", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-internal-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-internal-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-internal-1",
          gitBranch: "feat/internal",
          message: { role: "user", content: "内部 Claude 会话" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir, "claude-internal");

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "claude-internal:claude-internal-1",
      rawId: "claude-internal-1",
      source: "claude-internal",
      projectPath: "/repo",
      gitBranch: "feat/internal",
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("extracts Claude token usage from assistant message usage without double counting duplicate message ids", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    const assistant = {
      type: "assistant",
      timestamp: "2026-06-01T10:01:00Z",
      cwd: "/repo",
      sessionId: "claude-token-1",
      message: {
        id: "msg_1",
        role: "assistant",
        content: "我来处理",
        usage: {
          input_tokens: 900,
          output_tokens: 120,
          cache_read_input_tokens: 300,
          reasoning_output_tokens: 40,
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, "claude-token-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-token-1",
          message: { role: "user", content: "统计 tokens" },
        }),
        JSON.stringify(assistant),
        JSON.stringify(assistant),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 900,
      outputTokens: 120,
      cachedInputTokens: 300,
      reasoningOutputTokens: 40,
      totalTokens: 1360,
    });
    expect(loaded[0].tokenEvents).toEqual([
      {
        dedupeKey: "claude-code:msg_1",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 900,
        outputTokens: 120,
        cachedInputTokens: 300,
        reasoningOutputTokens: 40,
        totalTokens: 1360,
      },
    ]);

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
});
