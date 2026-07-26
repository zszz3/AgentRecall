import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRemoteSessionPayload,
  buildRemoteSessionSetupSql,
  buildRemoteSessionSnapshot,
  buildRemoteSessionUploadFromStore,
  buildSessionSyncItems,
  filterRemoteSessions,
  parseDetailSnapshot,
  parsePortableSession,
  remotePortableSessionFrom,
  remoteSessionContentHash,
  remoteSessionId,
  REMOTE_SESSION_TABLE,
  SupabaseRemoteSessionClient,
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
    expect(sql).toContain("'cursor'");
    expect(sql).toContain(`${REMOTE_SESSION_TABLE}_source_agent_check`);
    expect(sql).toContain(`grant select, insert, update, delete on table public.${REMOTE_SESSION_TABLE} to anon`);
    expect(sql).toContain("grant select on table storage.buckets to anon");
  });

  it("authenticates the storage bucket health check", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), headers: new Headers(init?.headers) });
        if (String(url).includes("/rest/v1/")) return new Response("[]", { status: 200 });
        return new Response(JSON.stringify({ id: "agent-session-remote" }), { status: 200 });
      },
    });

    await expect(client.checkStatus()).resolves.toMatchObject({ kind: "ready" });
    const bucketRequest = requests.find((request) => request.url.includes("/storage/v1/bucket/"));
    expect(bucketRequest?.headers.get("apikey")).toBe("anon-key");
    expect(bucketRequest?.headers.get("authorization")).toBe("Bearer anon-key");
  });

  it("marks database setup failures as SQL-remediable", async () => {
    const missingTableClient = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async () => new Response(JSON.stringify({ code: "PGRST205", message: "Could not find the table" }), { status: 404 }),
    });
    const missingColumnClient = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async () => new Response(JSON.stringify({ code: "PGRST204", message: "Could not find source_environment_id in the schema cache" }), { status: 400 }),
    });
    let requestCount = 0;
    const missingBucketClient = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify({ message: "Bucket not found" }), { status: 404 });
      },
    });

    await expect(missingTableClient.checkStatus()).resolves.toMatchObject({ kind: "missing-table", remediation: "sql" });
    await expect(missingColumnClient.checkStatus()).resolves.toMatchObject({ kind: "error", remediation: "sql" });
    await expect(missingBucketClient.checkStatus()).resolves.toMatchObject({ kind: "missing-storage", remediation: "sql" });
  });

  it("marks authentication failures as settings-remediable", async () => {
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "invalid-key",
      fetchImpl: async () => new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
    });

    await expect(client.checkStatus()).resolves.toMatchObject({ kind: "error", remediation: "settings" });
  });

  it("builds a stable remote upload payload with detail and portable object keys", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const first = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const second = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });

    expect(first.payload.id).toBe(remoteSessionId("codex:abc"));
    expect(first.payload.detail_object_key).toMatch(new RegExp(`^sessions/${first.payload.id}/[0-9a-f-]+\\.detail\\.json$`));
    expect(first.payload.portable_object_key).toMatch(new RegExp(`^sessions/${first.payload.id}/[0-9a-f-]+\\.portable\\.json$`));
    expect(first.payload.detail_object_key).not.toBe(second.payload.detail_object_key);
    expect(first.payload.content_hash).toBe(second.payload.content_hash);
    expect(first.payload.search_text).toContain("Login is broken");
    expect(first.payload.search_text).toContain("Fixed the login bug");
  });

  it("builds upload payloads for indexed SSH remote sessions", () => {
    const remoteSession: SessionSearchResult = {
      ...SESSION,
      sessionKey: "codex:ssh:abc",
      rawId: "ssh-abc",
      filePath: "/home/dev/.codex/sessions/abc.jsonl",
      projectPath: "/srv/repo",
      environmentId: "ssh-dev",
      environmentKind: "ssh",
      environmentLabel: "SSH dev",
    };
    const store = {
      getSession: () => remoteSession,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
    };

    const { payload, portable } = buildRemoteSessionUploadFromStore(store, remoteSession.sessionKey, 12_000);

    expect(portable).toMatchObject({
      sourceSessionKey: "codex:ssh:abc",
      sourceAgent: "codex",
      projectPath: "/srv/repo",
    });
    expect(payload.source_environment_id).toBe("ssh-dev");
    expect(payload.source_environment_kind).toBe("ssh");
    expect(payload.source_environment_label).toBe("SSH dev");
  });

  it("adds managed attachments to schema 2 snapshots without exposing local paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "agent-recall-remote-attachment-"));
    try {
      const cachePath = path.join(directory, "shot.png");
      writeFileSync(cachePath, "image", "utf8");
      const store = {
        getSession: () => SESSION,
        getAllMessages: () => [{
          ...MESSAGES[0],
          attachments: [{
            id: "0-0-image",
            fileName: "shot.png",
            mimeType: "image/png",
            previewKind: "image" as const,
            status: "available" as const,
          }],
        }],
        getTraceEvents: () => [],
        getAttachmentFile: () => ({
          cachePath,
          fileName: "shot.png",
          mimeType: "image/png",
          previewKind: "image" as const,
        }),
      };

      const built = buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);

      expect(built.detail.schemaVersion).toBe(2);
      expect(built.attachmentObjects).toHaveLength(1);
      expect(built.attachmentObjects[0].objectKey).toMatch(/^sessions\/[a-f0-9]{32}\/attachments\/[a-f0-9]{64}-shot\.png$/);
      expect(built.detail.messages[0].attachments?.[0]).toMatchObject({
        remoteObjectKey: built.attachmentObjects[0].objectKey,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(built.detail)).not.toContain(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("keeps the revision stable when only export time, device labels, or paths change", () => {
    const first = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const second = buildRemoteSessionSnapshot({
      ...SESSION,
      filePath: "/another/device/session.jsonl",
      projectPath: "D:\\repo",
      environmentId: "device-b",
      environmentLabel: "Windows laptop",
    }, MESSAGES, [], 99_000);
    expect(remoteSessionContentHash(second, { ...PORTABLE, projectPath: "D:\\repo" })).toBe(remoteSessionContentHash(first, PORTABLE));
  });

  it("classifies all six session sync states without using modified timestamps", () => {
    const local = (key: string, revision: string) => ({ session: { ...SESSION, sessionKey: key, rawId: key, lastActivityAt: 999_999 }, revision });
    const remote = (id: string, key: string, revision: string) => ({
      id, sourceSessionKey: key, sourceAgent: "codex" as const, sourceSource: "codex-cli", sourceEnvironmentId: "local",
      sourceEnvironmentKind: "local", sourceEnvironmentLabel: "Local", title: key, projectPath: "/repo", startedAt: "x",
      updatedAt: 1, contentHash: revision, revisionVersion: 2, messageCount: 1, traceEventCount: 0, aiSummary: null, tags: [],
      searchText: "", detailObjectKey: `${id}/detail`, portableObjectKey: `${id}/portable`, detailSha256: "d", portableSha256: "p",
      createdAt: 1, syncedAt: 1,
    });
    const locals = [local("local-only", "l"), local("synced", "same"), local("local-newer", "l2"), local("remote-newer", "base"), local("conflict", "l2")];
    const remotes = [remote("r-synced", "synced", "same"), remote("r-local", "local-newer", "base"), remote("r-remote", "remote-newer", "r2"), remote("r-conflict", "conflict", "r2"), remote("r-only", "remote-only", "r")];
    const bindings = [
      { localSessionKey: "local-newer", remoteSessionId: "r-local", lastLocalRevision: "base", lastRemoteRevision: "base", lastSyncedAt: 1, direction: "upload" as const },
      { localSessionKey: "remote-newer", remoteSessionId: "r-remote", lastLocalRevision: "base", lastRemoteRevision: "base", lastSyncedAt: 1, direction: "upload" as const },
      { localSessionKey: "conflict", remoteSessionId: "r-conflict", lastLocalRevision: "base", lastRemoteRevision: "base", lastSyncedAt: 1, direction: "upload" as const },
    ];
    expect(Object.fromEntries(buildSessionSyncItems(locals, remotes, bindings).map((item) => [item.local?.sessionKey ?? item.remote?.sourceSessionKey, item.state]))).toEqual({
      "local-only": "local-only", synced: "synced", "local-newer": "local-newer", "remote-newer": "remote-newer", conflict: "conflict", "remote-only": "remote-only",
    });
  });

  it("uses an explicit restore binding without duplicating the same remote session", () => {
    const local = { session: { ...SESSION, sessionKey: "restored:local", rawId: "restored" }, revision: "same" };
    const remote = {
      id: "remote-original", sourceSessionKey: "codex:abc", sourceAgent: "codex" as const, sourceSource: "codex-cli",
      sourceEnvironmentId: "local", sourceEnvironmentKind: "local" as const, sourceEnvironmentLabel: "Local",
      title: "Fix login bug", projectPath: "/repo", startedAt: "x", updatedAt: 1, contentHash: "same", revisionVersion: 2,
      messageCount: 2, traceEventCount: 0, aiSummary: null, tags: [], searchText: "", detailObjectKey: "d",
      portableObjectKey: "p", detailSha256: "dh", portableSha256: "ph", createdAt: 1, syncedAt: 1,
    };
    const binding = {
      localSessionKey: "restored:local", remoteSessionId: "remote-original", lastLocalRevision: "same",
      lastRemoteRevision: "same", lastSyncedAt: 1, direction: "restore" as const,
    };

    const items = buildSessionSyncItems([local], [remote], [binding]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "synced", local: { sessionKey: "restored:local" }, remote: { id: "remote-original" } });
  });

  it("parses detail and portable snapshots defensively", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    expect(parseDetailSnapshot(detail).messages).toHaveLength(2);
    expect(parsePortableSession(PORTABLE).sourceAgent).toBe("codex");
    expect(() => parsePortableSession({ ...PORTABLE, sourceAgent: "hermes" })).toThrow("unsupported");
  });

  it("preserves subagent relationships in portable sessions and defaults older payloads", () => {
    const portable = remotePortableSessionFrom(
      { ...SESSION, isSubagent: true, parentSessionId: "parent-1" },
      PORTABLE.messages,
    );
    expect(parsePortableSession(portable)).toMatchObject({ isSubagent: true, parentSessionId: "parent-1" });
    expect(parsePortableSession(PORTABLE)).toMatchObject({ isSubagent: false, parentSessionId: null });
  });

  it("filters remote sessions by title, summary, tags, and search text", () => {
    const sessions = [
      {
        id: "1",
        sourceSessionKey: "codex:1",
        sourceAgent: "codex" as const,
        sourceSource: "codex-cli",
        sourceEnvironmentId: "local",
        sourceEnvironmentKind: "local" as const,
        sourceEnvironmentLabel: "Local",
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

  it("deletes storage objects before removing the remote database row", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const calls: string[] = [];
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/storage/v1/object/")) {
          calls.push(`storage-${method}`);
          return new Response(method === "GET" ? JSON.stringify(detail) : "{}", { status: 200 });
        }
        if (method === "DELETE") {
          calls.push("row-DELETE");
          return new Response(JSON.stringify([]), { status: 200 });
        }
        calls.push("row-GET");
        return new Response(JSON.stringify([payload]), { status: 200 });
      },
    });

    await expect(client.deleteRemoteSessions([payload.id, payload.id])).resolves.toEqual({
      requested: 1,
      deletedIds: [payload.id],
      missingIds: [],
      failures: [],
    });
    expect(calls[0]).toBe("row-GET");
    expect(calls[1]).toBe("storage-GET");
    expect(calls.slice(2, 4).sort()).toEqual(["storage-DELETE", "storage-DELETE"]);
    expect(calls[4]).toBe("row-DELETE");
  });

  it("keeps a selected session as failed when its delete preflight cannot reach Supabase", async () => {
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async () => new Response(JSON.stringify({ message: "network unavailable" }), { status: 503 }),
    });

    await expect(client.deleteRemoteSessions(["remote-1"])).resolves.toEqual({
      requested: 1,
      deletedIds: [],
      missingIds: [],
      failures: [{ id: "remote-1", message: "network unavailable" }],
    });
  });

  it("does not treat a failed remote lookup as a missing row during upload", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    let storageWrites = 0;
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url) => {
        if (String(url).includes("/storage/v1/object/")) storageWrites += 1;
        return new Response(JSON.stringify({ message: "temporary gateway failure" }), { status: 503 });
      },
    });

    await expect(client.uploadSession(payload, detailJson, portableJson)).rejects.toThrow("temporary gateway failure");
    expect(storageWrites).toBe(0);
  });

  it("does not delete an existing attachment when a remote update fails", async () => {
    const attachmentKey = `sessions/${remoteSessionId(SESSION.sessionKey)}/attachments/abc-shot.png`;
    const previousDetail = {
      ...buildRemoteSessionSnapshot(SESSION, [{
        ...MESSAGES[0],
        attachments: [{
          id: "0-0-image",
          fileName: "shot.png",
          mimeType: "image/png",
          previewKind: "image" as const,
          status: "available" as const,
          remoteObjectKey: attachmentKey,
          sha256: "abc",
        }],
      }], [], 10_000),
      schemaVersion: 2 as const,
    };
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({
      session: SESSION,
      detail: previousDetail,
      portable: PORTABLE,
      now: 11_000,
    });
    const existing = {
      ...payload,
      content_hash: "previous-revision",
      detail_object_key: `sessions/${payload.id}/previous.detail.json`,
      detail_sha256: "unused-by-fixture",
    };
    const deletedKeys: string[] = [];
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        const method = init?.method ?? "GET";
        if (requestUrl.includes("/rest/v1/")) {
          if (method === "POST") {
            return new Response(JSON.stringify({ message: "database unavailable" }), { status: 503 });
          }
          return new Response(JSON.stringify([existing]), { status: 200 });
        }
        const objectKey = decodeURIComponent(requestUrl.split("/agent-session-remote/")[1] ?? "");
        if (method === "GET") return new Response(JSON.stringify(previousDetail), { status: 200 });
        if (method === "DELETE") deletedKeys.push(objectKey);
        return new Response("{}", { status: 200 });
      },
    });

    await expect(client.uploadSession(payload, detailJson, portableJson, [{
      objectKey: attachmentKey,
      bytes: Buffer.from("image"),
      mimeType: "image/png",
    }])).rejects.toThrow("database unavailable");

    expect(deletedKeys).not.toContain(attachmentKey);
    expect(deletedKeys).toContain(payload.detail_object_key);
    expect(deletedKeys).toContain(payload.portable_object_key);
  });

  it("falls back to legacy remote session rows when source environment columns are missing", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    const missingColumn = {
      code: "PGRST204",
      message: "Could not find the 'source_environment_id' column of 'agent_session_remote_sessions' in the schema cache",
    };
    const legacyRow = {
      id: payload.id,
      source_session_key: payload.source_session_key,
      source_agent: payload.source_agent,
      source_source: payload.source_source,
      title: payload.title,
      project_path: payload.project_path,
      started_at: payload.started_at,
      updated_at: payload.updated_at,
      content_hash: payload.content_hash,
      message_count: payload.message_count,
      trace_event_count: payload.trace_event_count,
      ai_summary: payload.ai_summary,
      tags: payload.tags,
      search_text: payload.search_text,
      detail_object_key: payload.detail_object_key,
      portable_object_key: payload.portable_object_key,
      detail_sha256: payload.detail_sha256,
      portable_sha256: payload.portable_sha256,
      created_at: payload.created_at,
      synced_at: payload.synced_at,
    };
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(url).includes("/storage/v1/object/")) return new Response("{}", { status: 200 });
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if ("source_environment_id" in body) return new Response(JSON.stringify(missingColumn), { status: 400 });
          return new Response(JSON.stringify([legacyRow]), { status: 201 });
        }
        if (String(url).includes("source_environment_id")) return new Response(JSON.stringify(missingColumn), { status: 400 });
        if (String(url).includes("select=id")) return new Response(JSON.stringify([]), { status: 200 });
        return new Response(JSON.stringify(missingColumn), { status: 400 });
      },
    });

    const result = await client.uploadSession(payload, detailJson, portableJson);

    expect(result.status).toBe("uploaded");
    expect(result.remoteSession.sourceEnvironmentKind).toBe("local");
    const postBodies = calls.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/")).map((call) => call.body);
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toHaveProperty("source_environment_id", "local");
    expect(postBodies[1]).not.toHaveProperty("source_environment_id");
  });
});
