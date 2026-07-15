import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryStore } from "./session-store";
import {
  buildRemoteSyncSshArgs,
  encodeRemotePayloadForTest,
  fetchRemoteSessionMessagePage,
  fetchRemoteSessionFilePayload,
  formatRemoteSyncProcessError,
  REMOTE_SYNC_EXEC_OPTIONS,
  syncRemoteEnvironment,
} from "./remote-sync";
import type { RemoteSessionFilePayload } from "./remote-session-loader";
import type { SessionSearchResult } from "./types";

function decodeCollectorScript(command: string): string {
  return Buffer.from(command.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "", "base64").toString("utf-8");
}

function upsertSshEnvironment(store: ReturnType<typeof createInMemoryStore>) {
  return store.upsertEnvironment({
    id: "ssh-devbox",
    kind: "ssh",
    label: "devbox",
    hostAlias: "devbox",
    host: "devbox.example.com",
    authMode: "none",
    enabled: true,
  });
}

function validCodexPayload(rawId = "remote-codex"): RemoteSessionFilePayload {
  return {
    kind: "codex-session",
    path: "/home/me/.codex/sessions/rollout.jsonl",
    mtimeMs: 100,
    size: 1,
    content: [
      JSON.stringify({ type: "session_meta", timestamp: "2026-06-04T10:00:00Z", payload: { id: rawId, cwd: "/repo" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-04T10:01:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remote sync" }] },
      }),
    ].join("\n"),
  };
}

describe("remote sync", () => {
  it("collects summaries from all five CLI sources and keeps same raw IDs isolated by source", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-remote-five-sources-"));
    const writeJsonl = (filePath: string, rows: unknown[]) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    };
    const codexRows = (rawId: string) => [
      { type: "session_meta", timestamp: "2026-07-15T10:00:00Z", payload: { id: rawId, cwd: "/repo" } },
      { type: "response_item", timestamp: "2026-07-15T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question ${rawId}` }] } },
    ];
    const claudeRows = (rawId: string) => [
      { type: "user", uuid: `${rawId}-user`, sessionId: rawId, cwd: "/repo", timestamp: "2026-07-15T10:00:00Z", message: { content: [{ type: "text", text: `question ${rawId}` }] } },
    ];
    try {
      writeJsonl(path.join(tempHome, ".codex", "sessions", "claude", "codex.jsonl"), codexRows("codex-1"));
      writeJsonl(path.join(tempHome, ".claude", "projects", "repo", "claude-1.jsonl"), claudeRows("claude-1"));
      writeJsonl(path.join(tempHome, ".tclaude", "projects", "repo", "tclaude-1.jsonl"), claudeRows("tclaude-1"));
      writeJsonl(path.join(tempHome, ".tcodex", "sessions", "tcodex.jsonl"), codexRows("tcodex-1"));
      writeJsonl(path.join(tempHome, ".codebuddy", "projects", "repo", "codebuddy.jsonl"), [
        { type: "ai-title", aiTitle: "CodeBuddy title", sessionId: "codebuddy-1", cwd: "/repo", timestamp: 1_752_573_600_000 },
        { type: "message", role: "user", content: [{ type: "input_text", text: "CodeBuddy question" }], sessionId: "codebuddy-1", cwd: "/repo", timestamp: 1_752_573_601_000 },
        {
          id: "codebuddy-assistant",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "CodeBuddy answer" }],
          timestamp: 1_752_573_602_000,
          providerData: {
            usage: {
              inputTokens: 100,
              outputTokens: 40,
              inputTokensDetails: [{ cached_tokens: 20 }],
              outputTokensDetails: [{ reasoning_tokens: 10 }],
              totalTokens: 140,
            },
          },
        },
      ]);
      writeJsonl(path.join(tempHome, ".claude", "projects", "repo", "same-id.jsonl"), claudeRows("same-id"));
      writeJsonl(path.join(tempHome, ".tclaude", "projects", "repo", "same-id.jsonl"), claudeRows("same-id"));

      let collectorCommand = "";
      await syncRemoteEnvironment(store, environment, {
        enabledOptionalSources: ["tclaude-cli", "tcodex-cli", "codebuddy-cli"],
        runSsh: async (_environment, remoteCommand) => {
          collectorCommand = remoteCommand;
          return execFileSync("python3", ["-c", decodeCollectorScript(remoteCommand)], {
            encoding: "utf8",
            env: { ...process.env, HOME: tempHome },
          });
        },
      });

      const summaries = execFileSync("python3", ["-c", decodeCollectorScript(collectorCommand)], {
        encoding: "utf8",
        env: { ...process.env, HOME: tempHome },
      }).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { source?: string; rawId: string });
      expect(summaries.map((item) => [item.source, item.rawId])).toEqual(expect.arrayContaining([
        ["claude-cli", "claude-1"],
        ["codex-cli", "codex-1"],
        ["tclaude-cli", "tclaude-1"],
        ["tcodex-cli", "tcodex-1"],
        ["codebuddy-cli", "codebuddy-1"],
      ]));
      expect(store.getSession("ssh:ssh-devbox:claude-cli:same-id")).not.toBeNull();
      expect(store.getSession("ssh:ssh-devbox:tclaude-cli:same-id")).not.toBeNull();
      expect(store.getSession("ssh:ssh-devbox:codebuddy-cli:codebuddy-1")?.tokenUsage).toEqual({
        inputTokens: 80,
        outputTokens: 30,
        cachedInputTokens: 20,
        reasoningOutputTokens: 10,
        totalTokens: 140,
      });
    } finally {
      store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("gates optional remote summaries and collector descriptors by the current source settings", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const summary = `${JSON.stringify({
      kind: "claude-project",
      source: "tclaude-cli",
      path: "/home/me/.tclaude/projects/repo/tclaude.jsonl",
      mtimeMs: 100,
      size: 10,
      rawId: "optional-tclaude",
      projectPath: "/repo",
      timestamp: 100,
      originalTitle: "TClaude",
      firstQuestion: "question",
      messageCount: 1,
    })}\n`;
    let disabledScript = "";
    await syncRemoteEnvironment(store, environment, {
      enabledOptionalSources: [],
      runSsh: async (_environment, command) => {
        disabledScript = decodeCollectorScript(command);
        return summary;
      },
    });
    expect(store.getSession("ssh:ssh-devbox:tclaude-cli:optional-tclaude")).toBeNull();
    expect(disabledScript).not.toContain('"tclaude-cli", home / ".tclaude"');

    let enabledScript = "";
    await syncRemoteEnvironment(store, environment, {
      enabledOptionalSources: ["tclaude-cli"],
      runSsh: async (_environment, command) => {
        enabledScript = decodeCollectorScript(command);
        return summary;
      },
    });
    expect(store.getSession("ssh:ssh-devbox:tclaude-cli:optional-tclaude")).not.toBeNull();
    expect(enabledScript).toContain('"tclaude-cli", home / ".tclaude"');
    store.close();
  });

  it("limits the merged remote collector result to 2500 files across all enabled sources", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-remote-limit-"));
    try {
      for (const [root, prefix, count] of [
        [path.join(tempHome, ".codex", "sessions"), "codex", 1251],
        [path.join(tempHome, ".tcodex", "sessions"), "tcodex", 1250],
      ] as const) {
        fs.mkdirSync(root, { recursive: true });
        for (let index = 0; index < count; index += 1) {
          fs.writeFileSync(path.join(root, `${prefix}-${index}.jsonl`), JSON.stringify({
            type: "session_meta",
            timestamp: "2026-07-15T10:00:00Z",
            payload: { id: `${prefix}-${index}`, cwd: "/repo" },
          }));
        }
      }
      let collectorScript = "";
      await syncRemoteEnvironment(store, environment, {
        enabledOptionalSources: ["tcodex-cli"],
        runSsh: async (_environment, command) => {
          collectorScript = decodeCollectorScript(command);
          return "";
        },
      });
      const output = execFileSync("python3", ["-c", collectorScript], {
        encoding: "utf8",
        env: { ...process.env, HOME: tempHome },
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(output.trim().split(/\r?\n/)).toHaveLength(2500);
    } finally {
      store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("indexes remote sessions returned by the ssh runner and updates sync status", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = encodeRemotePayloadForTest([validCodexPayload()]);

    const status = await syncRemoteEnvironment(store, environment, {
      runSsh: async () => output,
    });

    expect(status.indexed).toBe(1);
    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.sessionKey)).toEqual([
      "ssh:ssh-devbox:codex-cli:remote-codex",
    ]);
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({ syncState: "watching", lastError: null });
  });

  it("indexes lightweight remote session summaries without transferring file content", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-codex-summary",
      projectPath: "/repo",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      originalTitle: "Remote Summary",
      firstQuestion: "summary first question",
      messageCount: 12,
      gitBranch: "main",
    })}\n`;

    const status = await syncRemoteEnvironment(store, environment, {
      runSsh: async () => output,
    });

    const session = store.getSession("ssh:ssh-devbox:codex-cli:remote-codex-summary");
    expect(status.indexed).toBe(1);
    expect(session).toMatchObject({
      originalTitle: "Remote Summary",
      displayTitle: "Remote Summary",
      firstQuestion: "summary first question",
      messageCount: 12,
      projectPath: "/repo",
      fileSize: 2048,
    });
    expect(store.getMessages("ssh:ssh-devbox:codex-cli:remote-codex-summary")).toEqual([]);
  });

  it("stores token usage carried by lightweight remote summaries", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-codex-tokens",
      projectPath: "/repo",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      originalTitle: "Remote Tokens",
      firstQuestion: "q",
      messageCount: 4,
      gitBranch: "main",
      tokenUsage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 10, reasoningOutputTokens: 5, totalTokens: 155 },
    })}\n`;

    await syncRemoteEnvironment(store, environment, { runSsh: async () => output });

    expect(store.getSession("ssh:ssh-devbox:codex-cli:remote-codex-tokens")?.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 155,
    });
  });

  it("includes lightweight remote token events in ranged stats and dedupes local mirrors", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const now = new Date("2026-06-04T12:00:00Z").getTime();
    const todayEvent = {
      timestamp: new Date("2026-06-04T10:01:00Z").getTime(),
      dedupeKey: "codex-total:gpt-5:today",
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 115,
    };
    const oldEvent = {
      timestamp: new Date("2026-05-01T10:01:00Z").getTime(),
      dedupeKey: "codex-total:gpt-5:old",
      inputTokens: 30,
      outputTokens: 10,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 40,
    };
    const output = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-codex-events",
      projectPath: "/repo",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      originalTitle: "Remote Token Events",
      firstQuestion: "q",
      messageCount: 4,
      tokenUsage: { inputTokens: 110, outputTokens: 30, cachedInputTokens: 10, reasoningOutputTokens: 5, totalTokens: 155 },
      tokenEvents: [todayEvent, oldEvent],
    })}\n`;

    await syncRemoteEnvironment(store, environment, { runSsh: async () => output });

    expect(store.getStats({ period: "today" }, now).total.totalTokens).toBe(115);
    expect(store.getStats({ period: "allTime" }, now).total.totalTokens).toBe(155);

    store.upsertIndexedSession(
      {
        sessionKey: "codex:local-mirror",
        rawId: "local-mirror",
        source: "codex-app",
        projectPath: "/repo",
        filePath: "/tmp/local-mirror.jsonl",
        originalTitle: "Local mirror",
        firstQuestion: "q",
        timestamp: todayEvent.timestamp,
        fileMtimeMs: 100,
        fileSize: 200,
        prUrl: null,
        prNumber: null,
      },
      [],
      [todayEvent],
    );

    expect(store.getStats({ period: "today" }, now).total.totalTokens).toBe(115);
    expect(store.getStats({ period: "allTime" }, now).total.totalTokens).toBe(155);
    store.close();
  });

  it("includes lightweight remote message events in ranged stats and keeps old summaries compatible", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const now = new Date("2026-06-04T12:00:00Z").getTime();
    const summary = {
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-message-events",
      projectPath: "/repo",
      timestamp: new Date("2026-05-01T10:00:00Z").getTime(),
      originalTitle: "Remote Message Events",
      firstQuestion: "q",
      messageCount: 2,
    };
    const messageEvents = [
      { index: 0, timestamp: new Date("2026-05-01T10:01:00Z").getTime() },
      { index: 1, timestamp: new Date("2026-06-04T10:01:00Z").getTime() },
    ];

    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => `${JSON.stringify({ ...summary, messageEvents })}\n`,
    });

    expect(store.getStats({ period: "today" }, now).total).toMatchObject({ sessionCount: 1, messageCount: 1 });
    expect(store.getStats({ period: "allTime" }, now).total.messageCount).toBe(2);

    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => `${JSON.stringify({ ...summary, mtimeMs: 101 })}\n`,
    });
    expect(store.getStats({ period: "today" }, now).total.messageCount).toBe(1);

    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => `${JSON.stringify({ ...summary, mtimeMs: 102, messageCount: 0, messageEvents: [] })}\n`,
    });
    expect(store.getStats({ period: "today" }, now).total.messageCount).toBe(0);
    store.close();
  });

  it("rejects malformed remote message events", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-invalid-message-events",
      projectPath: "/repo",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      originalTitle: "Invalid Remote Message Events",
      firstQuestion: "q",
      messageCount: 1,
      messageEvents: [{ index: 0.5, timestamp: new Date("2026-06-04T10:01:00Z").getTime() }],
    })}\n`;

    await expect(syncRemoteEnvironment(store, environment, { runSsh: async () => output })).rejects.toThrow(/messageEvents/i);
    store.close();
  });

  it("preserves remote token events when an older summary omits the field", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const now = new Date("2026-06-04T12:00:00Z").getTime();
    const summary = {
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-compatible-events",
      projectPath: "/repo",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      originalTitle: "Compatible Remote Events",
      firstQuestion: "q",
      messageCount: 4,
      tokenUsage: { inputTokens: 80, outputTokens: 20, cachedInputTokens: 10, reasoningOutputTokens: 5, totalTokens: 115 },
    };
    const tokenEvent = {
      timestamp: new Date("2026-06-04T10:01:00Z").getTime(),
      dedupeKey: "codex-total:gpt-5:compatible",
      inputTokens: 80,
      outputTokens: 20,
      cachedInputTokens: 10,
      reasoningOutputTokens: 5,
      totalTokens: 115,
    };

    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => `${JSON.stringify({ ...summary, tokenEvents: [tokenEvent] })}\n`,
    });
    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => `${JSON.stringify(summary)}\n`,
    });

    expect(store.getStats({ period: "today" }, now).total.totalTokens).toBe(115);
    store.close();
  });

  it("rejects malformed remote token events", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/me/.codex/sessions/rollout.jsonl",
      mtimeMs: 100,
      size: 2048,
      rawId: "remote-invalid-events",
      projectPath: "/repo",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      originalTitle: "Invalid Remote Events",
      firstQuestion: "q",
      messageCount: 4,
      tokenEvents: [
        {
          timestamp: "2026-06-04T10:01:00Z",
          dedupeKey: "invalid-event",
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 15,
        },
      ],
    })}\n`;

    await expect(syncRemoteEnvironment(store, environment, { runSsh: async () => output })).rejects.toThrow(/tokenEvents/i);
    store.close();
  });

  it("emits remote summary token usage from the collector script", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    let collectorCommand = "";
    await syncRemoteEnvironment(store, environment, {
      runSsh: async (_environment, remoteCommand) => {
        collectorCommand = remoteCommand;
        return "";
      },
    });
    const collectorScript = Buffer.from(collectorCommand.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "", "base64").toString("utf-8");
    expect(collectorScript).toContain("total_token_usage");
    expect(collectorScript).toContain('"tokenUsage"');
  });

  it("emits timestamped remote token events from the collector script", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-remote-token-events-"));
    try {
      const sessionsDir = path.join(tempHome, ".codex", "sessions", "2026", "06", "04");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionsDir, "rollout.jsonl"),
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-06-04T10:00:00Z",
            payload: { id: "collector-token-events", cwd: "/repo" },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:00:40Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real question" }] },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:00:50Z",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "real answer" }] },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:00:55Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<system_notification>noise</system_notification>" }] },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:00:56Z",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "The beginning of the above subagent result is already visible noise" }],
            },
          }),
          JSON.stringify({ type: "turn_context", timestamp: "2026-06-04T10:00:30Z", payload: { model: "gpt-5" } }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-06-04T10:01:00Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 100,
                  output_tokens: 30,
                  cached_input_tokens: 20,
                  reasoning_output_tokens: 5,
                },
              },
            },
          }),
          JSON.stringify({
            type: "event_msg",
            timestamp: "2026-06-04T10:02:00Z",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 150,
                  output_tokens: 50,
                  cached_input_tokens: 30,
                  reasoning_output_tokens: 10,
                },
              },
            },
          }),
        ].join("\n"),
        "utf8",
      );
      const claudeProjectDir = path.join(tempHome, ".claude", "projects", "-repo");
      fs.mkdirSync(claudeProjectDir, { recursive: true });
      fs.writeFileSync(
        path.join(claudeProjectDir, "claude-token-events.jsonl"),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-04T10:03:00Z",
            message: {
              id: "msg_1",
              content: [{ type: "text", text: "first" }],
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 30,
                cache_creation_input_tokens: 5,
                reasoning_output_tokens: 2,
              },
            },
          }),
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-06-04T10:04:00Z",
            message: {
              id: "msg_2",
              content: [{ type: "text", text: "second" }],
              usage: {
                input_tokens: 3,
                output_tokens: 4,
                cached_input_tokens: 2,
                reasoning_output_tokens: 1,
              },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      let collectorCommand = "";
      await syncRemoteEnvironment(store, environment, {
        runSsh: async (_environment, remoteCommand) => {
          collectorCommand = remoteCommand;
          return "";
        },
      });
      const collectorScript = Buffer.from(collectorCommand.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "", "base64").toString("utf-8");
      const output = execFileSync("python3", ["-c", collectorScript], {
        encoding: "utf8",
        env: { ...process.env, HOME: tempHome },
      });
      const summary = output
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((item) => item.rawId === "collector-token-events");

      expect(summary?.tokenEvents).toEqual([
        {
          timestamp: new Date("2026-06-04T10:01:00Z").getTime(),
          dedupeKey: `codex-total:gpt-5:${new Date("2026-06-04T10:01:00Z").getTime()}:80:25:20:5`,
          inputTokens: 80,
          outputTokens: 25,
          cachedInputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 130,
        },
        {
          timestamp: new Date("2026-06-04T10:02:00Z").getTime(),
          dedupeKey: `codex-total:gpt-5:${new Date("2026-06-04T10:02:00Z").getTime()}:120:40:30:10`,
          inputTokens: 40,
          outputTokens: 15,
          cachedInputTokens: 10,
          reasoningOutputTokens: 5,
          totalTokens: 70,
        },
      ]);
      expect(summary?.tokenUsage).toEqual({
        inputTokens: 120,
        outputTokens: 40,
        cachedInputTokens: 30,
        reasoningOutputTokens: 10,
        totalTokens: 200,
      });
      expect(summary?.messageEvents).toEqual([
        { index: 0, timestamp: new Date("2026-06-04T10:00:40Z").getTime() },
        { index: 1, timestamp: new Date("2026-06-04T10:00:50Z").getTime() },
      ]);
      expect(summary?.messageCount).toBe(2);
      const claudeSummary = output
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((item) => item.rawId === "claude-token-events");
      expect(claudeSummary?.tokenEvents).toEqual([
        {
          timestamp: new Date("2026-06-04T10:03:00Z").getTime(),
          dedupeKey: "claude-code:msg_1",
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 35,
          reasoningOutputTokens: 2,
          totalTokens: 67,
        },
        {
          timestamp: new Date("2026-06-04T10:04:00Z").getTime(),
          dedupeKey: "claude-code:msg_2",
          inputTokens: 3,
          outputTokens: 4,
          cachedInputTokens: 2,
          reasoningOutputTokens: 1,
          totalTokens: 10,
        },
      ]);
      expect(claudeSummary?.tokenUsage).toEqual({
        inputTokens: 13,
        outputTokens: 24,
        cachedInputTokens: 37,
        reasoningOutputTokens: 3,
        totalTokens: 77,
      });
    } finally {
      store.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fetches a remote session message page without transferring the full session payload", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const session = {
      sessionKey: "ssh:ssh-devbox:codex-cli:remote-codex-summary",
      rawId: "remote-codex-summary",
      source: "codex-cli",
      filePath: "/home/me/.codex/sessions/rollout.jsonl",
      projectPath: "/repo",
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
      environmentLabel: "devbox",
      originalTitle: "Remote Summary",
      firstQuestion: "older prompt",
      timestamp: new Date("2026-06-04T10:00:00Z").getTime(),
      fileMtimeMs: 100,
      fileSize: 2048,
      prUrl: null,
      prNumber: null,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      customTitle: null,
      displayTitle: "Remote Summary",
      favorited: false,
      pinned: false,
      hidden: false,
      tags: [],
      matchSnippet: null,
      lastOpenedAt: null,
      lastResumedAt: null,
      lastActivityAt: new Date("2026-06-04T10:00:00Z").getTime(),
      messageCount: 12,
      aiSummary: null,
      aiSummaryStale: false,
    } as SessionSearchResult;

    const page = await fetchRemoteSessionMessagePage(environment, session, 10, 2, {
      runSsh: async (_environment, remoteCommand) => {
        expect(remoteCommand).toContain("python3 -c");
        return JSON.stringify({
          messages: [
            { index: 10, role: "user", content: "older prompt", timestamp: "2026-06-04T10:10:00Z" },
            { index: 11, role: "assistant", content: "older answer", timestamp: "2026-06-04T10:11:00Z" },
          ],
        });
      },
    });

    expect(page).toEqual([
      { index: 10, role: "user", content: "older prompt", timestamp: "2026-06-04T10:10:00Z" },
      { index: 11, role: "assistant", content: "older answer", timestamp: "2026-06-04T10:11:00Z" },
    ]);
  });

  it("pages CodeBuddy messages with the shared remote parser", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-remote-codebuddy-page-"));
    const filePath = path.join(tempDir, "codebuddy.jsonl");
    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "ai-title", aiTitle: "title", sessionId: "codebuddy-page" }),
        JSON.stringify({ type: "message", role: "user", content: [{ type: "input_text", text: "question" }], timestamp: "2026-07-15T10:00:00Z" }),
        JSON.stringify({ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }], timestamp: "2026-07-15T10:00:01Z" }),
      ].join("\n"));
      const messages = await fetchRemoteSessionMessagePage(
        environment,
        { source: "codebuddy-cli", filePath } as SessionSearchResult,
        0,
        10,
        {
          runSsh: async (_environment, command) => {
            const script = decodeCollectorScript(command);
            expect(script).toContain('"kind":"codebuddy"');
            return execFileSync("python3", ["-c", script], { encoding: "utf8" });
          },
        },
      );
      expect(messages).toEqual([
        { index: 0, role: "user", content: "question", timestamp: "2026-07-15T10:00:00Z" },
        { index: 1, role: "assistant", content: "answer", timestamp: "2026-07-15T10:00:01Z" },
      ]);
    } finally {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid remote payload protocol output and records sync error", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);

    await expect(
      syncRemoteEnvironment(store, environment, {
        runSsh: async () => JSON.stringify({}),
      }),
    ).rejects.toThrow(/Invalid remote payload/i);

    expect(store.searchSessions({ environmentId: "ssh-devbox" })).toEqual([]);
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: expect.stringMatching(/Invalid remote payload/i),
    });
  });

  it("rejects malformed remote payload records instead of treating them as empty sessions", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const missingContent = JSON.stringify({ kind: "codex-session", path: "x", mtimeMs: 1, size: 1 });

    await expect(
      syncRemoteEnvironment(store, environment, {
        runSsh: async () => missingContent,
      }),
    ).rejects.toThrow(/remote payload/i);

    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "error",
      lastError: expect.stringMatching(/remote payload/i),
    });
  });

  it("keeps existing indexed sessions when ssh fails", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    await syncRemoteEnvironment(store, environment, {
      runSsh: async () => encodeRemotePayloadForTest([validCodexPayload("seeded-codex")]),
    });

    await expect(
      syncRemoteEnvironment(store, environment, {
        runSsh: async () => {
          throw new Error("Permission denied");
        },
      }),
    ).rejects.toThrow("Permission denied");
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({ syncState: "error", lastError: "Permission denied" });
    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.sessionKey)).toEqual([
      "ssh:ssh-devbox:codex-cli:seeded-codex",
    ]);
  });

  it("treats an empty remote payload stream as a successful zero-session sync", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);

    const status = await syncRemoteEnvironment(store, environment, {
      runSsh: async () => "",
    });

    expect(status).toEqual({ environmentId: "ssh-devbox", indexed: 0, error: null });
    expect(store.getEnvironment("ssh-devbox")).toMatchObject({
      syncState: "watching",
      lastError: null,
      lastSyncedAt: expect.any(Number),
    });
  });

  it("sends the remote collector as a single shell-safe python command", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    let capturedCommand = "";

    await syncRemoteEnvironment(store, environment, {
      runSsh: async (_environment, remoteCommand) => {
        capturedCommand = remoteCommand;
        return "";
      },
    });

    expect(capturedCommand).toMatch(/^python3 -c '[^']+'$/);
    expect(capturedCommand).not.toContain("<<");
    expect(capturedCommand).not.toContain("\n");
  });

  it("sends the remote collector as a manifest scanner without embedding session content", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    let capturedCommand = "";

    await syncRemoteEnvironment(store, environment, {
      runSsh: async (_environment, remoteCommand) => {
        capturedCommand = remoteCommand;
        return "";
      },
    });

    const encodedScript = capturedCommand.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "";
    const script = Buffer.from(encodedScript, "base64").toString("utf-8");
    expect(script).toContain("emit_codex_summary");
    expect(script).toContain("emit_claude_summary");
    expect(script).toContain("sorted(candidates");
    expect(script).not.toContain("contentBase64");
    expect(script).not.toContain("read_bytes()");
  });

  it("counts remote summary messages with the same parser used for on-demand paging", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);

    let collectorCommand = "";
    await syncRemoteEnvironment(store, environment, {
      runSsh: async (_environment, remoteCommand) => {
        collectorCommand = remoteCommand;
        return "";
      },
    });

    let pageCommand = "";
    await fetchRemoteSessionMessagePage(
      environment,
      { source: "codex-cli", filePath: "/home/me/.codex/sessions/rollout.jsonl" } as SessionSearchResult,
      0,
      10,
      {
        runSsh: async (_environment, remoteCommand) => {
          pageCommand = remoteCommand;
          return JSON.stringify({ messages: [] });
        },
      },
    );

    const decodeScript = (command: string): string =>
      Buffer.from(command.match(/b64decode\("([^"]+)"\)/)?.[1] ?? "", "base64").toString("utf-8");
    const collectorScript = decodeScript(collectorCommand);
    const pageScript = decodeScript(pageCommand);

    for (const script of [collectorScript, pageScript]) {
      expect(script).toContain("def parse_message(row, kind):");
      expect(script).toContain("def meaningful_user(text):");
      expect(script).toContain("(AGENTS|CLAUDE)");
      expect(script).toContain("system-reminder");
    }
    // The collector must not keep the looser legacy heuristic that disagreed with paging.
    expect(collectorScript).not.toContain("def meaningful(text):");
  });

  it("fetches one remote session file on demand without exposing the path to the remote shell", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const session = {
      source: "codex-cli",
      filePath: "/home/me/private sessions/rollout.jsonl",
    } as SessionSearchResult;
    let capturedCommand = "";

    const payload = await fetchRemoteSessionFilePayload(environment, session, {
      runSsh: async (_environment, remoteCommand) => {
        capturedCommand = remoteCommand;
        return encodeRemotePayloadForTest([validCodexPayload("on-demand-codex")]);
      },
    });

    expect(capturedCommand).toMatch(/^python3 -c '[^']+'$/);
    expect(capturedCommand).not.toContain("/home/me/private sessions");
    expect(payload.kind).toBe("codex-session");
    expect(payload.content).toContain("on-demand-codex");
  });

  it("fetches CodeBuddy remote files with their source-specific payload kind", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-search-remote-codebuddy-file-"));
    const filePath = path.join(tempDir, "codebuddy.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({ type: "message", role: "user", content: "question" }));
    try {
      const payload = await fetchRemoteSessionFilePayload(
        environment,
        { source: "codebuddy-cli", filePath } as SessionSearchResult,
        {
          runSsh: async (_environment, command) => execFileSync("python3", ["-c", decodeCollectorScript(command)], { encoding: "utf8" }),
        },
      );
      expect(payload).toMatchObject({ kind: "codebuddy-project", source: "codebuddy-cli", path: filePath });
    } finally {
      store.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizes failed remote protocol stdout instead of leaking session JSON", () => {
    const stdout = `${JSON.stringify({
      kind: "codex-session",
      path: "/home/alice/.codex/sessions/private.jsonl",
      contentBase64: "AAAA",
      mtimeMs: 1,
      size: 1,
    })}\n`.repeat(500);

    const message = formatRemoteSyncProcessError({ killed: true, code: 255 }, stdout, "");

    expect(message).toContain("timed out");
    expect(message).toContain("remote produced");
    expect(message).not.toContain("/home/alice");
    expect(message).not.toContain("contentBase64");
    expect(message.length).toBeLessThan(500);
  });

  it("builds noninteractive ssh args before the destination terminator and exposes a finite exec timeout", () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const args = buildRemoteSyncSshArgs(environment, "echo ok");

    expect(args.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
    expect(args).toContain("--");
    expect(args.indexOf("-o")).toBeLessThan(args.indexOf("--"));
    expect(args.slice(args.indexOf("--"))).toEqual(["--", "devbox", "echo ok"]);
    expect(REMOTE_SYNC_EXEC_OPTIONS.timeout).toBeGreaterThan(0);
    expect(Number.isFinite(REMOTE_SYNC_EXEC_OPTIONS.timeout)).toBe(true);

    const dashedAliasEnvironment = { ...environment, hostAlias: "-oProxyCommand=bad" };
    expect(buildRemoteSyncSshArgs(dashedAliasEnvironment, "echo ok").slice(4)).toEqual(["--", "-oProxyCommand=bad", "echo ok"]);
  });
});
