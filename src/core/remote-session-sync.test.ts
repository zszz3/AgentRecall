import { describe, expect, it } from "vitest";
import {
  buildRemoteSessionPayload,
  buildRemoteSessionSetupSql,
  buildRemoteSessionSnapshot,
  filterRemoteSessions,
  parseDetailSnapshot,
  parsePortableSession,
  remoteSessionContentHash,
  remoteSessionId,
} from "./remote-session-sync";
import type { PortableSession, SessionSearchResult } from "./types";

const SESSION: SessionSearchResult = {
  sessionKey: "codex:abc",
  rawId: "abc",
  source: "codex-cli",
  projectPath: "/repo",
  filePath: "/home/.codex/sessions/abc.jsonl",
  originalTitle: "Original title",
  firstQuestion: "Fix login bug",
  timestamp: 1_000,
  fileMtimeMs: 2_000,
  fileSize: 123,
  prUrl: null,
  prNumber: null,
  gitBranch: null,
  environmentId: "local",
  environmentKind: "local",
  environmentLabel: "Local",
  tokenUsage: {
    inputTokens: 1,
    outputTokens: 2,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 3,
  },
  customTitle: null,
  displayTitle: "Fix login bug",
  favorited: false,
  pinned: false,
  hidden: false,
  tags: ["auth", "react"],
  matchSnippet: null,
  lastOpenedAt: null,
  lastResumedAt: null,
  lastActivityAt: 3_000,
  messageCount: 2,
  aiSummary: "Fixed the login bug by updating auth state handling.",
  aiSummaryStale: false,
};

const MESSAGES = [
  { role: "user" as const, content: "Login is broken", timestamp: "2026-07-03T10:00:00.000Z", index: 0 },
  { role: "assistant" as const, content: "Update auth state handling", timestamp: "2026-07-03T10:01:00.000Z", index: 1 },
];

const PORTABLE: PortableSession = {
  sourceSessionKey: "codex:abc",
  sourceAgent: "codex",
  title: "Fix login bug",
  projectPath: "/repo",
  startedAt: "2026-07-03T10:00:00.000Z",
  messages: MESSAGES,
};

describe("remote session sync model", () => {
  it("builds setup SQL for the table and storage bucket", () => {
    const sql = buildRemoteSessionSetupSql();
    expect(sql).toContain("agent_session_remote_sessions");
    expect(sql).toContain("agent-session-remote");
    expect(sql).toContain("storage.buckets");
    expect(sql).toContain("to anon");
  });

  it("builds a stable remote upload payload with detail and portable object keys", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const first = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const second = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });

    expect(first.payload.id).toBe(remoteSessionId("codex:abc"));
    expect(first.payload.detail_object_key).toBe(`sessions/${first.payload.id}/detail.json`);
    expect(first.payload.portable_object_key).toBe(`sessions/${first.payload.id}/portable.json`);
    expect(first.payload.content_hash).toBe(second.payload.content_hash);
    expect(first.payload.search_text).toContain("Login is broken");
    expect(first.payload.search_text).toContain("Fixed the login bug");
  });

  it("rounds timestamp fields for Supabase bigint columns", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000.9);
    const { payload } = buildRemoteSessionPayload({
      session: { ...SESSION, lastActivityAt: 1_783_088_915_792.1865 },
      detail,
      portable: PORTABLE,
      now: 1_783_088_916_001.9,
    });

    expect(payload.updated_at).toBe(1_783_088_915_792);
    expect(payload.created_at).toBe(1_783_088_916_001);
    expect(payload.synced_at).toBe(1_783_088_916_001);
  });

  it("hashes remote content deterministically", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    expect(remoteSessionContentHash(detail, PORTABLE)).toBe(remoteSessionContentHash(detail, { ...PORTABLE, messages: [...PORTABLE.messages] }));
  });

  it("parses detail and portable snapshots defensively", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    expect(parseDetailSnapshot(detail).messages).toHaveLength(2);
    expect(parsePortableSession(PORTABLE).sourceAgent).toBe("codex");
    expect(() => parsePortableSession({ ...PORTABLE, sourceAgent: "hermes" })).toThrow("unsupported");
  });

  it("filters remote sessions by title, summary, tags, and search text", () => {
    const sessions = [
      {
        id: "1",
        sourceSessionKey: "codex:1",
        sourceAgent: "codex" as const,
        sourceSource: "codex-cli",
        title: "Auth fix",
        projectPath: "/repo",
        startedAt: "2026-07-03T10:00:00.000Z",
        updatedAt: 1,
        contentHash: "h",
        messageCount: 2,
        traceEventCount: 0,
        aiSummary: "login state",
        tags: ["react"],
        searchText: "oauth callback",
        detailObjectKey: "d",
        portableObjectKey: "p",
        detailSha256: "dh",
        portableSha256: "ph",
        createdAt: 1,
        syncedAt: 1,
      },
    ];
    expect(filterRemoteSessions(sessions, "oauth")).toHaveLength(1);
    expect(filterRemoteSessions(sessions, "missing")).toHaveLength(0);
  });
});
