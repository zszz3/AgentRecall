import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadClaudeCliSessionRows,
  loadClaudeCliSessions,
  loadCodeBuddyCliSessionFile,
  loadCodeBuddyCliSessionRows,
  loadCodeBuddyCliSessions,
  loadCodexSessionFile,
  loadCodexSessionsIterator,
  loadCodexSessions,
  loadDefaultSessions,
  parseCodexSessionMetaLine,
} from "./session-loader";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";

describe("Codex session loading", () => {
  it("detects current and legacy subagent metadata without treating ordinary forks as subagents", () => {
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: {
          id: "child-current",
          source: { subagent: { thread_spawn: { parent_thread_id: "parent-current", depth: 1 } } },
        },
      }),
    ).toMatchObject({ isSubagent: true, parentSessionId: "parent-current" });
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: { id: "child-legacy", thread_source: "subagent", parent_thread_id: "parent-legacy" },
      }),
    ).toMatchObject({ isSubagent: true, parentSessionId: "parent-legacy" });
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        payload: { id: "ordinary-fork", forked_from_id: "some-session", originator: "codex-tui", session_id: "ordinary-fork" },
      }),
    ).toMatchObject({ isSubagent: false, parentSessionId: null });
  });

  it("skips unchanged source files before parsing JSONL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-skip-"));
    const filePath = path.join(root, "sessions", "2026", "06", "26", "rollout.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not valid jsonl");
    const skipped: string[] = [];

    const loaded = [
      ...loadCodexSessionsIterator(root, undefined, {
        shouldSkipFile: () => true,
        onSkippedFile: (skippedPath) => skipped.push(skippedPath),
      }),
    ];

    expect(loaded).toEqual([]);
    expect(skipped).toEqual([filePath]);

    fs.rmSync(root, { recursive: true, force: true });
  });

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

  it("recognizes the current Codex desktop originator", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-app-originator-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-07-19T14:37:55Z",
          payload: {
            id: "codex-current-desktop",
            cwd: "/Users/test/Documents/Codex/2026-07-19/rewrite-feishu-doc",
            originator: "codex_work_desktop",
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-07-19T14:38:17Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "重写飞书文档" }] },
        }),
      ].join("\n"),
    );

    expect(loadCodexSessionFile(filePath)?.session.source).toBe("codex-app");

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

  it("uses the cumulative total_token_usage rather than summing per-turn last usage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-total-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              last_token_usage: { input_tokens: 1000, output_tokens: 200 },
              total_token_usage: { input_tokens: 1000, output_tokens: 200 },
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
              // last reflects only the final request of the turn (1200 input),
              // but the cumulative total grew to 4000 input because intermediate
              // tool-call requests were not emitted as their own last usage.
              last_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 100, reasoning_output_tokens: 10 },
              total_token_usage: { input_tokens: 4000, cached_input_tokens: 1000, output_tokens: 600, reasoning_output_tokens: 60 },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    // Authoritative cumulative total: input 4000 - cached 1000 = 3000 fresh,
    // output 600 - reasoning 60 = 540, cached 1000, reasoning 60.
    // (Summing per-turn last usage would wrongly yield input 1200, output 290.)
    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 540,
      cachedInputTokens: 1000,
      reasoningOutputTokens: 60,
      totalTokens: 4600,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex-total:gpt-5-codex:1780308060000:1000:200:0:0",
        timestamp: new Date("2026-06-01T10:01:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 200,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1200,
      },
      {
        dedupeKey: "codex-total:gpt-5-codex:1780308120000:3000:540:1000:60",
        timestamp: new Date("2026-06-01T10:02:00Z").getTime(),
        inputTokens: 2000,
        outputTokens: 340,
        cachedInputTokens: 1000,
        reasoningOutputTokens: 60,
        totalTokens: 3400,
      },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("splits Codex cumulative token totals into dated deltas for period stats", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-04T10:00:00Z",
          payload: { id: "codex-long-running", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-04T10:01:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 10_000,
                cached_input_tokens: 8_000,
                output_tokens: 500,
                reasoning_output_tokens: 100,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-16T06:23:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5-codex",
              total_token_usage: {
                input_tokens: 12_500,
                cached_input_tokens: 9_500,
                output_tokens: 700,
                reasoning_output_tokens: 150,
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-16T06:24:00Z",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5.4",
              total_token_usage: {
                input_tokens: 12_500,
                cached_input_tokens: 9_500,
                output_tokens: 700,
                reasoning_output_tokens: 150,
              },
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 550,
      cachedInputTokens: 9500,
      reasoningOutputTokens: 150,
      totalTokens: 13200,
    });
    expect(loaded?.tokenEvents).toEqual([
      {
        dedupeKey: "codex-total:gpt-5-codex:1780567260000:2000:400:8000:100",
        timestamp: new Date("2026-06-04T10:01:00Z").getTime(),
        inputTokens: 2000,
        outputTokens: 400,
        cachedInputTokens: 8000,
        reasoningOutputTokens: 100,
        totalTokens: 10500,
      },
      {
        dedupeKey: "codex-total:gpt-5-codex:1781590980000:3000:550:9500:150",
        timestamp: new Date("2026-06-16T06:23:00Z").getTime(),
        inputTokens: 1000,
        outputTokens: 150,
        cachedInputTokens: 1500,
        reasoningOutputTokens: 50,
        totalTokens: 2700,
      },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles interleaved Codex cumulative token sequences in one session file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-interleaved-total", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 50_000_000, output_tokens: 1_000 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 13_000_000, output_tokens: 500 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:03:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 50_100_000, output_tokens: 1_200 } },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:04:00Z",
          payload: {
            type: "token_count",
            info: { model: "gpt-5-codex", total_token_usage: { input_tokens: 13_100_000, output_tokens: 700 } },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.session.tokenUsage).toEqual({
      inputTokens: 63_200_000,
      outputTokens: 1_900,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 63_201_900,
    });
    expect(loaded?.tokenEvents?.map((event) => event.totalTokens)).toEqual([50_001_000, 13_000_500, 100_200, 100_200]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("extracts Codex tool calls and execution events as trace events", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-trace-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "列一下文件" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:02:00Z",
          payload: {
            type: "function_call",
            name: "shell_command",
            call_id: "call-1",
            arguments: JSON.stringify({ command: "ls -la", workdir: "/repo" }),
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:03:00Z",
          payload: { type: "function_call_output", call_id: "call-1", output: "total 8" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:04:00Z",
          payload: {
            type: "exec_command_end",
            call_id: "call-1",
            command: "ls -la",
            cwd: "/repo",
            exit_code: 0,
            stdout: "total 8",
            stderr: "",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:05:00Z",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1 } } },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);

    expect(loaded?.traceEvents).toHaveLength(2);
    expect(loaded?.traceEvents?.[0]).toMatchObject({
      kind: "tool_call",
      source: "codex",
      title: "shell_command · ls -la",
      callId: "call-1",
    });
    expect(loaded?.traceEvents?.[1]).toMatchObject({
      kind: "event",
      source: "codex",
      eventType: "exec_command_end",
      title: "shell · ls -la",
      callId: "call-1",
      status: "success",
    });
    expect(loaded?.traceEvents?.[1].detail).toContain("total 8");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("caps large Codex trace details during loading", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-"));
    const filePath = path.join(dir, "rollout.jsonl");
    const stdout = "x".repeat(TRACE_DETAIL_PREVIEW_MAX_CHARS + 50);
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-trace-large", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-01T10:01:00Z",
          payload: {
            type: "exec_command_end",
            command: "npm test",
            exit_code: 0,
            stdout,
          },
        }),
      ].join("\n"),
    );

    const loaded = loadCodexSessionFile(filePath);
    const detail = loaded?.traceEvents?.[0]?.detail || "";

    expect(detail.length).toBeLessThanOrEqual(TRACE_DETAIL_PREVIEW_MAX_CHARS);
    expect(detail).toContain("Indexed preview truncated");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses old and new Codex metadata lines", () => {
    expect(
      parseCodexSessionMetaLine({
        type: "session_meta",
        timestamp: "2026-06-01T10:00:00Z",
        payload: { id: "new-id", cwd: "/new", title: "内嵌标题 🚀", git: { branch: "feat/session-tags" } },
      }),
    ).toMatchObject({
      id: "new-id",
      projectPath: "/new",
      title: "内嵌标题 🚀",
      gitBranch: "feat/session-tags",
    });

    expect(
      parseCodexSessionMetaLine({
        id: "old-id",
        timestamp: "2025-01-01T00:00:00Z",
        instructions: "...",
        git: { cwd: "/old" },
      }),
    ).toMatchObject({ id: "old-id", projectPath: "/old" });
  });

  it("prefers an explicit Codex title over the embedded metadata title", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codex-title-"));
    const filePath = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "codex-title", cwd: "/repo", title: "内嵌标题" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "首问标题" }] },
        }),
      ].join("\n"),
    );

    expect(loadCodexSessionFile(filePath)?.session.originalTitle).toBe("内嵌标题");
    expect(loadCodexSessionFile(filePath, "显式标题")?.session.originalTitle).toBe("显式标题");

    fs.rmSync(dir, { recursive: true, force: true });
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
  it("discovers Claude subagent files and links them to the parent session", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-subagent-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    const subagentsDir = path.join(projectDir, "parent-1", "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(subagentsDir, "agent-child-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          agentId: "child-1",
          sessionId: "parent-1",
          isSidechain: true,
          cwd: "/repo",
          message: { role: "user", content: "Inspect the parser" },
        }),
        JSON.stringify({
          type: "assistant",
          agentId: "child-1",
          sessionId: "parent-1",
          isSidechain: true,
          message: { role: "assistant", content: "Parser inspected" },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      rawId: "child-1",
      projectPath: "/repo",
      isSubagent: true,
      parentSessionId: "parent-1",
    });
    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("reads ai-title metadata without exposing it as a message or changing the explicit source", () => {
    const loaded = loadClaudeCliSessionRows(
      "/tmp/claude-title.jsonl",
      [
        { type: "ai-title", aiTitle: "Claude 标题 ✨", sessionId: "claude-title" },
        {
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          message: { role: "user", content: "真实问题" },
        },
      ],
      { rawId: "claude-title", source: "claude-internal" },
    );

    expect(loaded?.session).toMatchObject({
      source: "claude-internal",
      originalTitle: "Claude 标题 ✨",
    });
    expect(loaded?.messages.map((message) => message.content)).toEqual(["真实问题"]);
  });

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

  it("counts cache_creation_input_tokens as processed input", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-cache-create.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-cache-create",
          message: { role: "user", content: "首轮请求会写入缓存" },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-cache-create",
          message: {
            id: "msg_cache",
            role: "assistant",
            content: "好的",
            usage: {
              input_tokens: 500,
              output_tokens: 100,
              cache_creation_input_tokens: 2000,
              cache_read_input_tokens: 300,
            },
          },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    // cached bucket = cache_read 300 + cache_creation 2000 = 2300; the 2000
    // cache-creation tokens were previously dropped entirely.
    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      cachedInputTokens: 2300,
      reasoningOutputTokens: 0,
      totalTokens: 2900,
    });

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });

  it("extracts Claude tool_use and tool_result blocks as trace events", () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-claude-"));
    const projectDir = path.join(claudeDir, "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "claude-trace-1.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-01T10:01:00Z",
          cwd: "/repo",
          sessionId: "claude-trace-1",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "我先读文件" },
              { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/repo/src/App.tsx" } },
              { type: "tool_result", tool_use_id: "tool-1", content: "export function App() {}" },
            ],
          },
        }),
      ].join("\n"),
    );

    const loaded = loadClaudeCliSessions(claudeDir);

    expect(loaded[0].messages.map((message) => message.content)).toEqual(["我先读文件"]);
    expect(loaded[0].traceEvents).toHaveLength(2);
    expect(loaded[0].traceEvents?.[0]).toMatchObject({
      kind: "tool_call",
      source: "claude",
      title: "Read · /repo/src/App.tsx",
      callId: "tool-1",
    });
    expect(loaded[0].traceEvents?.[1]).toMatchObject({
      kind: "tool_result",
      source: "claude",
      callId: "tool-1",
    });
    expect(loaded[0].traceEvents?.[1].detail).toContain("export function App");

    fs.rmSync(claudeDir, { recursive: true, force: true });
  });
});

describe("CodeBuddy session loading", () => {
  it("loads CodeBuddy rows without a temporary file", () => {
    const rows = [
      { type: "ai-title", aiTitle: "远程 CodeBuddy", sessionId: "cb-remote", cwd: "/repo" },
      {
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "远程问题" }],
        sessionId: "cb-remote",
        cwd: "/repo",
        timestamp: 1_780_000_000_000,
      },
    ];
    const loaded = loadCodeBuddyCliSessionRows(
      "/home/me/.codebuddy/projects/repo/cb-remote.jsonl",
      rows,
      { mtimeMs: 1_780_000_000_000, size: 100 },
    );

    expect(loaded?.session).toMatchObject({
      rawId: "cb-remote",
      source: "codebuddy-cli",
      originalTitle: "远程 CodeBuddy",
      projectPath: "/repo",
    });
  });

  it("loads one CodeBuddy CLI jsonl file with the same behavior as the iterator", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-file-"));
    const filePath = path.join(codeBuddyDir, "codebuddy-file.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "ai-title",
          aiTitle: "单文件标题",
          sessionId: "codebuddy-file",
          cwd: "/repo/单文件",
        }),
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "读取单文件" }],
          sessionId: "codebuddy-file",
          cwd: "/repo/单文件",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessionFile(filePath);

    expect(loaded?.session).toMatchObject({
      rawId: "codebuddy-file",
      source: "codebuddy-cli",
      projectPath: "/repo/单文件",
      originalTitle: "单文件标题",
    });
    expect(loaded?.messages.map((message) => message.content)).toEqual(["读取单文件"]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("loads CodeBuddy CLI jsonl sessions with a separate source namespace", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-1.jsonl"),
      [
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "接入 CodeBuddy CLI" }],
          sessionId: "codebuddy-1",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "msg-assistant",
          parentId: "msg-user",
          timestamp: 1_780_321_303_135,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "我来处理" }],
          providerData: {
            messageId: "provider-message-1",
            // Real CodeBuddy shape: camelCase totals where inputTokens already
            // includes cached, outputTokens already includes reasoning, and the
            // detail breakdowns are arrays.
            usage: {
              requests: 1,
              inputTokens: 120,
              outputTokens: 30,
              totalTokens: 150,
              inputTokensDetails: [{ cached_tokens: 10 }],
              outputTokensDetails: [{ reasoning_tokens: 5 }],
            },
          },
          sessionId: "codebuddy-1",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "codebuddy:codebuddy-1",
      rawId: "codebuddy-1",
      source: "codebuddy-cli",
      projectPath: "/repo",
      firstQuestion: "接入 CodeBuddy CLI",
      originalTitle: "接入 CodeBuddy CLI",
      timestamp: 1_780_321_278_404,
      // input split into non-cached (110) + cached (10); output into
      // non-reasoning (25) + reasoning (5); total matches CodeBuddy's 150.
      tokenUsage: {
        inputTokens: 110,
        outputTokens: 25,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 150,
      },
    });
    expect(loaded[0].messages.map((message) => message.content)).toEqual(["接入 CodeBuddy CLI", "我来处理"]);
    expect(loaded[0].tokenEvents).toEqual([
      {
        dedupeKey: "codebuddy:provider-message-1",
        timestamp: 1_780_321_303_135,
        inputTokens: 110,
        outputTokens: 25,
        cachedInputTokens: 10,
        reasoningOutputTokens: 5,
        totalTokens: 150,
      },
    ]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("sums token usage from function_call records, counting parallel tool calls separately", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-fc-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-fc.jsonl"),
      [
        JSON.stringify({
          id: "msg-user",
          timestamp: 1_780_000_000_000,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "edit some files" }],
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        // A tool-ending assistant turn keeps no usage on the message; the usage
        // lives on each function_call. Two parallel tool calls in one turn share
        // a messageId but are separately billed requests keyed by callId.
        JSON.stringify({
          id: "asst-1",
          timestamp: 1_780_000_001_000,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
          providerData: { messageId: "m-1", model: "gpt" },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "fc-1",
          callId: "call-a",
          timestamp: 1_780_000_001_100,
          type: "function_call",
          name: "Read",
          providerData: {
            messageId: "m-1",
            usage: { requests: 1, inputTokens: 1000, outputTokens: 10, totalTokens: 1010 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "fc-2",
          callId: "call-b",
          timestamp: 1_780_000_001_200,
          type: "function_call",
          name: "Edit",
          providerData: {
            messageId: "m-1",
            usage: { requests: 1, inputTokens: 2000, outputTokens: 20, totalTokens: 2020 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
        // A later text-ending turn keeps usage on the assistant message itself.
        JSON.stringify({
          id: "asst-2",
          timestamp: 1_780_000_002_000,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
          providerData: {
            messageId: "m-2",
            usage: { requests: 1, inputTokens: 3000, outputTokens: 30, totalTokens: 3030 },
          },
          sessionId: "codebuddy-fc",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded).toHaveLength(1);
    const session = loaded[0]!;
    // 1010 + 2020 (two parallel tool calls) + 3030 (text turn) = 6060.
    expect(session.session.tokenUsage).toEqual({
      inputTokens: 6000,
      outputTokens: 60,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 6060,
    });
    expect(session.tokenEvents?.map((event) => event.dedupeKey).sort()).toEqual([
      "codebuddy:call-a",
      "codebuddy:call-b",
      "codebuddy:m-2",
    ]);

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("reads token usage from the OpenAI-style rawUsage fallback", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-raw-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-raw.jsonl"),
      [
        JSON.stringify({
          id: "u",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
          sessionId: "codebuddy-raw",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "a",
          timestamp: 1_780_321_303_135,
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
          providerData: {
            messageId: "pm-2",
            rawUsage: {
              prompt_tokens: 200,
              completion_tokens: 50,
              total_tokens: 250,
              prompt_tokens_details: { cached_tokens: 40 },
              completion_tokens_details: { reasoning_tokens: 8 },
            },
          },
          sessionId: "codebuddy-raw",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded[0].session.tokenUsage).toEqual({
      inputTokens: 160,
      outputTokens: 42,
      cachedInputTokens: 40,
      reasoningOutputTokens: 8,
      totalTokens: 250,
    });

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });

  it("prefers the CodeBuddy ai-title over slash-command first messages", () => {
    const codeBuddyDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-codebuddy-title-"));
    const projectDir = path.join(codeBuddyDir, "projects", "Users-xjx");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "codebuddy-title.jsonl"),
      [
        // Root bootstrap "code" message is dropped, and the first real user
        // message is a slash command that should NOT become the title.
        JSON.stringify({
          id: "root",
          timestamp: 1_780_321_278_000,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "code" }],
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
        JSON.stringify({
          id: "cmd",
          parentId: "root",
          timestamp: 1_780_321_278_404,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "/model" }],
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
        JSON.stringify({
          type: "ai-title",
          aiTitle: "Switch the active model",
          sessionId: "codebuddy-title",
          cwd: "/repo",
        }),
      ].join("\n"),
    );

    const loaded = loadCodeBuddyCliSessions(codeBuddyDir);

    expect(loaded[0].session.originalTitle).toBe("Switch the active model");

    fs.rmSync(codeBuddyDir, { recursive: true, force: true });
  });
});

describe("tclaude / tcodex optional sources", () => {
  it("indexes ~/.tclaude with the tclaude source and its own session-key namespace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tclaude-"));
    const projectDir = path.join(home, ".tclaude", "projects", "-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "tclaude-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-01T10:00:00Z",
          cwd: "/repo",
          sessionId: "tclaude-1",
          message: { role: "user", content: "tclaude 会话" },
        }),
      ].join("\n"),
    );

    const off = loadDefaultSessions({ homeDir: home });
    expect(off.some((item) => item.session.source === "tclaude-cli")).toBe(false);

    const loaded = loadDefaultSessions({ homeDir: home, includeTclaude: true });
    const session = loaded.find((item) => item.session.source === "tclaude-cli")?.session;
    expect(session).toMatchObject({
      sessionKey: "tclaude:tclaude-1",
      rawId: "tclaude-1",
      source: "tclaude-cli",
      projectPath: "/repo",
    });

    fs.rmSync(home, { recursive: true, force: true });
  });

  it("indexes ~/.tcodex with the tcodex source and its own session-key namespace", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-tcodex-"));
    const sessionDir = path.join(home, ".tcodex", "sessions", "2026", "06", "01");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-01T10:00:00Z",
          payload: { id: "tcodex-1", cwd: "/repo" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-01T10:01:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "tcodex 会话" }] },
        }),
      ].join("\n"),
    );

    const off = loadDefaultSessions({ homeDir: home });
    expect(off.some((item) => item.session.source === "tcodex-cli")).toBe(false);

    const loaded = loadDefaultSessions({ homeDir: home, includeTcodex: true });
    const session = loaded.find((item) => item.session.source === "tcodex-cli")?.session;
    expect(session).toMatchObject({
      sessionKey: "tcodex:tcodex-1",
      rawId: "tcodex-1",
      source: "tcodex-cli",
      projectPath: "/repo",
    });

    fs.rmSync(home, { recursive: true, force: true });
  });
});
