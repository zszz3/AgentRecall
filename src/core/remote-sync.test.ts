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
  it("indexes remote sessions returned by the ssh runner and updates sync status", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const output = encodeRemotePayloadForTest([validCodexPayload()]);

    const status = await syncRemoteEnvironment(store, environment, {
      runSsh: async () => output,
    });

    expect(status.indexed).toBe(1);
    expect(store.searchSessions({ environmentId: "ssh-devbox" }).map((session) => session.sessionKey)).toEqual([
      "ssh:ssh-devbox:codex:remote-codex",
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

    const session = store.getSession("ssh:ssh-devbox:codex:remote-codex-summary");
    expect(status.indexed).toBe(1);
    expect(session).toMatchObject({
      originalTitle: "Remote Summary",
      displayTitle: "Remote Summary",
      firstQuestion: "summary first question",
      messageCount: 12,
      projectPath: "/repo",
      fileSize: 2048,
    });
    expect(store.getMessages("ssh:ssh-devbox:codex:remote-codex-summary")).toEqual([]);
  });

  it("fetches a remote session message page without transferring the full session payload", async () => {
    const store = createInMemoryStore();
    const environment = upsertSshEnvironment(store);
    const session = {
      sessionKey: "ssh:ssh-devbox:codex:remote-codex-summary",
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
      "ssh:ssh-devbox:codex:seeded-codex",
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
