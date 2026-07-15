import { describe, expect, it } from "vitest";
import { loadRemoteSessionDetailPayload, loadRemoteSessionPayloads, type RemoteSessionFilePayload } from "./remote-session-loader";
import type { SessionEnvironment, SessionSearchResult } from "./types";

const env: SessionEnvironment = {
  id: "ssh-devbox",
  kind: "ssh",
  label: "devbox",
  hostAlias: "devbox",
  host: "devbox.example.com",
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
  syncState: "idle",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

function payload(kind: RemoteSessionFilePayload["kind"], filePath: string, content: string): RemoteSessionFilePayload {
  return { kind, path: filePath, mtimeMs: 100, size: content.length, content };
}

describe("remote session loader", () => {
  const claudeRows = [
    {
      type: "user",
      timestamp: "2026-07-15T10:00:00Z",
      cwd: "/repo",
      sessionId: "tclaude-remote",
      message: { role: "user", content: "remote tclaude" },
    },
  ];
  const codexRows = [
    {
      type: "session_meta",
      timestamp: "2026-07-15T10:00:00Z",
      payload: { id: "tcodex-remote", cwd: "/repo" },
    },
    {
      type: "response_item",
      timestamp: "2026-07-15T10:01:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remote tcodex" }] },
    },
  ];
  const codeBuddyRows = [
    { type: "ai-title", aiTitle: "Remote CodeBuddy", sessionId: "codebuddy-remote", cwd: "/repo" },
    {
      id: "user-1",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "remote codebuddy" }],
      sessionId: "codebuddy-remote",
      cwd: "/repo",
      timestamp: 1_780_000_000_000,
    },
  ];

  it.each([
    ["tclaude-cli", "claude-project", "/home/me/.tclaude/projects/repo/tc.jsonl", claudeRows, "tclaude-cli"],
    ["tcodex-cli", "codex-session", "/home/me/.tcodex/sessions/2026/07/15/rollout.jsonl", codexRows, "tcodex-cli"],
    ["codebuddy-cli", "codebuddy-project", "/home/me/.codebuddy/projects/repo/cb.jsonl", codeBuddyRows, "codebuddy-cli"],
  ])("loads remote %s payloads", (source, kind, filePath, rows, expectedSource) => {
    const [loaded] = loadRemoteSessionPayloads(env, [{
      source,
      kind,
      path: filePath,
      mtimeMs: 100,
      size: 200,
      content: rows.map((row) => JSON.stringify(row)).join("\n"),
    } as RemoteSessionFilePayload]);

    expect(loaded.session.source).toBe(expectedSource);
    expect(loaded.session.sessionKey).toBe(`ssh:ssh-devbox:${expectedSource}:${loaded.session.rawId}`);
  });

  it("detects remote Claude subagent payloads from structured metadata and path", () => {
    const loaded = loadRemoteSessionPayloads(env, [
      payload(
        "claude-project",
        "/home/me/.claude/projects/-repo/parent-1/subagents/agent-child-1.jsonl",
        JSON.stringify({
          type: "user",
          agentId: "child-1",
          sessionId: "parent-1",
          isSidechain: true,
          cwd: "/repo",
          message: { role: "user", content: "remote child" },
        }),
      ),
    ]);

    expect(loaded[0].session).toMatchObject({
      rawId: "child-1",
      isSubagent: true,
      parentSessionId: "parent-1",
    });
  });

  it("loads remote Codex sessions with environment-scoped keys", () => {
    const loaded = loadRemoteSessionPayloads(env, [
      payload(
        "codex-session",
        "/home/me/.codex/sessions/2026/06/04/rollout.jsonl",
        [
          JSON.stringify({ type: "session_meta", timestamp: "2026-06-04T10:00:00Z", payload: { id: "codex-1", cwd: "/repo" } }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:01:00Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remote codex" }] },
          }),
        ].join("\n"),
      ),
    ]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:codex-cli:codex-1",
      rawId: "codex-1",
      source: "codex-cli",
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
      environmentLabel: "devbox",
      projectPath: "/repo",
    });
  });

  it("loads an on-demand remote Codex detail payload using the existing summary metadata", () => {
    const summary = {
      sessionKey: "ssh:ssh-devbox:codex-cli:codex-1",
      rawId: "codex-1",
      source: "codex-cli",
      projectPath: "/repo",
      filePath: "/home/me/.codex/sessions/2026/06/04/rollout.jsonl",
      originalTitle: "Remote summary title",
      firstQuestion: "summary question",
      timestamp: new Date("2026-06-04T09:00:00Z").getTime(),
      fileMtimeMs: 90,
      fileSize: 90,
      prUrl: null,
      prNumber: null,
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
      environmentLabel: "devbox",
      tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      customTitle: null,
      displayTitle: "Remote summary title",
      favorited: false,
      pinned: false,
      hidden: false,
      tags: [],
      matchSnippet: null,
      lastOpenedAt: null,
      lastResumedAt: null,
      lastActivityAt: new Date("2026-06-04T09:00:00Z").getTime(),
      messageCount: 0,
      aiSummary: null,
      aiSummaryStale: false,
    } satisfies SessionSearchResult;

    const loaded = loadRemoteSessionDetailPayload(
      env,
      payload(
        "codex-session",
        "/home/me/.codex/sessions/2026/06/04/rollout.jsonl",
        [
          JSON.stringify({ type: "session_meta", timestamp: "2026-06-04T10:00:00Z", payload: { id: "codex-1", cwd: "/repo" } }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:01:00Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "detail question" }] },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:02:00Z",
            payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "detail answer" }] },
          }),
        ].join("\n"),
      ),
      summary,
    );

    expect(loaded?.session.sessionKey).toBe("ssh:ssh-devbox:codex-cli:codex-1");
    expect(loaded?.messages.map((message) => message.content)).toEqual(["detail question", "detail answer"]);
  });

  it("keeps remote Codex Desktop-originated sessions classified as Codex CLI", () => {
    const loaded = loadRemoteSessionPayloads(env, [
      payload(
        "codex-session",
        "/home/me/.codex/sessions/2026/06/04/desktop-originator.jsonl",
        [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-06-04T10:00:00Z",
            payload: { id: "codex-desktop-originator", cwd: "/repo", originator: "Codex Desktop" },
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: "2026-06-04T10:01:00Z",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remote desktop originator" }] },
          }),
        ].join("\n"),
      ),
    ]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:codex-cli:codex-desktop-originator",
      source: "codex-cli",
    });
  });

  it("ignores malformed remote Codex index rows without skipping valid sessions", () => {
    let loaded: ReturnType<typeof loadRemoteSessionPayloads> = [];

    expect(() => {
      loaded = loadRemoteSessionPayloads(env, [
        payload(
          "codex-index",
          "/home/me/.codex/session_index.jsonl",
          [
            JSON.stringify(null),
            JSON.stringify([]),
            JSON.stringify("not an index row"),
            JSON.stringify({ id: "codex-indexed", thread_name: "Remote Indexed Title", updated_at: "2026-06-04T11:00:00Z" }),
          ].join("\n"),
        ),
        payload(
          "codex-session",
          "/home/me/.codex/sessions/2026/06/04/indexed.jsonl",
          [
            JSON.stringify({
              type: "session_meta",
              timestamp: "2026-06-04T10:00:00Z",
              payload: { id: "codex-indexed", cwd: "/repo" },
            }),
            JSON.stringify({
              type: "response_item",
              timestamp: "2026-06-04T10:01:00Z",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "remote indexed" }] },
            }),
          ].join("\n"),
        ),
      ]);
    }).not.toThrow();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:codex-cli:codex-indexed",
      originalTitle: "Remote Indexed Title",
    });
  });

  it("skips remote Codex sessions with malformed first rows without aborting other payloads", () => {
    let loaded: ReturnType<typeof loadRemoteSessionPayloads> = [];

    expect(() => {
      loaded = loadRemoteSessionPayloads(env, [
        payload(
          "codex-session",
          "/home/me/.codex/sessions/2026/06/04/malformed-first-row.jsonl",
          [
            JSON.stringify(null),
            JSON.stringify({
              type: "response_item",
              timestamp: "2026-06-04T10:01:00Z",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "missing meta" }] },
            }),
          ].join("\n"),
        ),
        payload(
          "codex-session",
          "/home/me/.codex/sessions/2026/06/04/valid-after-malformed.jsonl",
          [
            JSON.stringify({
              type: "session_meta",
              timestamp: "2026-06-04T11:00:00Z",
              payload: { id: "codex-valid-after-malformed", cwd: "/repo" },
            }),
            JSON.stringify({
              type: "response_item",
              timestamp: "2026-06-04T11:01:00Z",
              payload: { type: "message", role: "user", content: [{ type: "input_text", text: "still loads" }] },
            }),
          ].join("\n"),
        ),
      ]);
    }).not.toThrow();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:codex-cli:codex-valid-after-malformed",
      projectPath: "/repo",
    });
  });

  it("loads remote Claude Code sessions with environment-scoped keys", () => {
    const loaded = loadRemoteSessionPayloads(env, [
      payload(
        "claude-project",
        "/home/me/.claude/projects/-repo/claude-1.jsonl",
        JSON.stringify({
          type: "user",
          timestamp: "2026-06-04T10:00:00Z",
          cwd: "/repo",
          sessionId: "claude-1",
          message: { role: "user", content: "remote claude" },
        }),
      ),
    ]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:claude-cli:claude-1",
      rawId: "claude-1",
      source: "claude-cli",
      environmentId: "ssh-devbox",
      environmentKind: "ssh",
      environmentLabel: "devbox",
      projectPath: "/repo",
    });
  });

  it("ignores malformed remote Claude index fields without overriding embedded metadata", () => {
    let loaded: ReturnType<typeof loadRemoteSessionPayloads> = [];

    expect(() => {
      loaded = loadRemoteSessionPayloads(env, [
        payload(
          "claude-session-index",
          "/home/me/.claude/sessions/claude-1.json",
          JSON.stringify({ sessionId: "claude-1", cwd: {}, startedAt: "bad" }),
        ),
        payload(
          "claude-project",
          "/home/me/.claude/projects/-repo/claude-1.jsonl",
          JSON.stringify({
            type: "user",
            timestamp: "2026-06-04T10:00:00Z",
            cwd: "/repo",
            sessionId: "claude-1",
            message: { role: "user", content: "remote claude with malformed index" },
          }),
        ),
      ]);
    }).not.toThrow();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].session).toMatchObject({
      sessionKey: "ssh:ssh-devbox:claude-cli:claude-1",
      projectPath: "/repo",
    });
    expect(loaded[0].session.timestamp).toBe(100);
  });
});
