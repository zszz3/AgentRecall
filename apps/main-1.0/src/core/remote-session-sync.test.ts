import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildRemoteSessionPayload,
  buildRemoteSessionRevisionFromStore,
  buildRemoteSessionSetupSql,
  buildRemoteSessionSnapshot,
  buildRemoteSessionUploadFromStore,
  buildSessionSyncItems,
  filterRemoteSessions,
  findCursorSessionSyncBindingRepairs,
  parseDetailSnapshot,
  parsePortableSession,
  remotePortableSessionFrom,
  remoteSessionContentHash,
  remoteSessionId,
  remoteSessionSearchText,
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
    expect(sql).toContain("'codewiz'");
    expect(sql).toContain("'cursor'");
    expect(sql).toContain("'hermes'");
    expect(sql).toContain("'pi'");
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

  it("omits large search text when listing sessions for sync comparison", async () => {
    let requestUrl = "";
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async (url) => {
        requestUrl = String(url);
        return new Response("[]", { status: 200 });
      },
    });

    await expect(client.listRemoteSessionsForSync()).resolves.toEqual([]);
    expect(requestUrl).toContain("select=id,source_session_key");
    expect(requestUrl).not.toContain("search_text");
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
      fetchImpl: async (url) => {
        requestCount += 1;
        return String(url).includes("/storage/v1/bucket/")
          ? new Response(JSON.stringify({ message: "Bucket not found" }), { status: 404 })
          : new Response("[]", { status: 200 });
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

  it("reports network failures as a status instead of rejecting", async () => {
    const client = new SupabaseRemoteSessionClient({
      url: "https://unavailable.supabase.co",
      anonKey: "anon-key",
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(client.checkStatus()).resolves.toMatchObject({
      kind: "error",
      remediation: "settings",
      message: "Could not reach Supabase. Check the Remote sync URL and your network connection, then try again.",
    });
  });

  it("builds a stable remote upload payload with detail and portable object keys", () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const first = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const second = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });

    expect(first.payload.id).toBe(remoteSessionId("codex:abc"));
    expect(first.payload.detail_object_key).toMatch(new RegExp(`^sessions/${first.payload.id}/[0-9a-f-]+\\.detail\\.json\\.gz$`));
    expect(first.payload.portable_object_key).toMatch(new RegExp(`^sessions/${first.payload.id}/[0-9a-f-]+\\.portable\\.json\\.gz$`));
    expect(first.payload.detail_object_key).not.toBe(second.payload.detail_object_key);
    expect(first.payload.content_hash).toBe(second.payload.content_hash);
    expect(first.payload.search_text).toContain("Login is broken");
    expect(first.payload.search_text).toContain("Fixed the login bug");
  });

  it("keeps terminal Turn summaries but excludes hidden lifecycle starts from snapshots", () => {
    const detail = buildRemoteSessionSnapshot(
      SESSION,
      [{ ...MESSAGES[1], phase: "final_answer", sourceTurnId: "turn-1" }],
      [
        {
          index: 4,
          kind: "event",
          source: "codex",
          title: "Turn started",
          detail: "",
          timestamp: "2026-07-03T10:00:00.000Z",
          eventType: "codex.turn.started",
          status: "running",
          sourceTurnId: "turn-1",
        },
        {
          index: 5,
          kind: "event",
          source: "codex",
          title: "Turn completed",
          detail: "",
          timestamp: "2026-07-03T10:01:00.000Z",
          eventType: "codex.turn.completed",
          status: "completed",
          sourceTurnId: "turn-1",
          attributes: { durationMs: 60_000 },
        },
      ],
      10_000,
    );

    expect(detail.messages[0]).toMatchObject({ phase: "final_answer", sourceTurnId: "turn-1" });
    expect(detail.traceEvents).toEqual([
      expect.objectContaining({
        index: 0,
        eventType: "codex.turn.completed",
        sourceTurnId: "turn-1",
        attributes: { durationMs: 60_000 },
      }),
    ]);
    expect(remoteSessionSearchText(SESSION, detail.messages, detail.traceEvents)).not.toContain("Turn started");
  });

  it("builds remote upload payloads for Hermes sessions without enabling migration", () => {
    const hermesSession: SessionSearchResult = {
      ...SESSION,
      sessionKey: "hermes:abc",
      rawId: "abc",
      source: "hermes",
      filePath: "/home/.hermes/state.db",
      displayTitle: "Hermes review",
    };
    const portable = remotePortableSessionFrom(hermesSession, MESSAGES);
    const detail = buildRemoteSessionSnapshot(hermesSession, MESSAGES, [], 10_000);
    const { payload } = buildRemoteSessionPayload({ session: hermesSession, detail, portable, now: 11_000 });

    expect(portable.sourceAgent).toBe("hermes");
    expect(payload).toMatchObject({
      source_agent: "hermes",
      source_source: "hermes",
    });
    expect(parsePortableSession(portable).sourceAgent).toBe("hermes");
  });

  it("builds remote upload payloads for Pi sessions without enabling migration or resume", () => {
    const piSession: SessionSearchResult = {
      ...SESSION,
      sessionKey: "pi:abc",
      rawId: "abc",
      source: "pi-cli",
      filePath: "/home/.pi/agent/sessions/abc.jsonl",
      projectPath: "/work/pi-project",
      displayTitle: "Pi review",
    };
    const portable = remotePortableSessionFrom(piSession, MESSAGES);
    const detail = buildRemoteSessionSnapshot(piSession, MESSAGES, [], 10_000);
    const { payload } = buildRemoteSessionPayload({ session: piSession, detail, portable, now: 11_000 });

    expect(portable.sourceAgent).toBe("pi");
    expect(portable.projectPath).toBe("/work/pi-project");
    expect(payload).toMatchObject({
      source_agent: "pi",
      source_source: "pi-cli",
      project_path: "/work/pi-project",
    });
    expect(parsePortableSession(portable).sourceAgent).toBe("pi");
  });

  it("builds and parses remote upload payloads for CodeWiz sessions", () => {
    const codeWizSession: SessionSearchResult = {
      ...SESSION,
      sessionKey: "codewiz:abc",
      rawId: "abc",
      source: "codewiz-cli",
      filePath: "/home/.codewiz/sessions.db#abc",
      displayTitle: "CodeWiz review",
    };
    const portable = remotePortableSessionFrom(codeWizSession, MESSAGES);
    const detail = buildRemoteSessionSnapshot(codeWizSession, MESSAGES, [], 10_000);
    const { payload } = buildRemoteSessionPayload({ session: codeWizSession, detail, portable, now: 11_000 });

    expect(portable.sourceAgent).toBe("codewiz");
    expect(payload.source_agent).toBe("codewiz");
    expect(parsePortableSession(portable).sourceAgent).toBe("codewiz");
  });

  it("builds upload payloads for indexed SSH remote sessions", async () => {
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

    const { payload, portable } = await buildRemoteSessionUploadFromStore(store, remoteSession.sessionKey, 12_000);

    expect(portable).toMatchObject({
      sourceSessionKey: "codex:ssh:abc",
      sourceAgent: "codex",
      projectPath: "/srv/repo",
    });
    expect(payload.source_environment_id).toBe("ssh-dev");
    expect(payload.source_environment_kind).toBe("ssh");
    expect(payload.source_environment_label).toBe("SSH dev");
  });

  it("builds upload payloads for sessions without a project path", async () => {
    const session = { ...SESSION, projectPath: "" };
    const store = {
      getSession: () => session,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
    };

    const { payload, portable } = await buildRemoteSessionUploadFromStore(store, session.sessionKey, 12_000);

    expect(portable.projectPath).toBe("");
    expect(payload.project_path).toBe("");
  });

  it("adds managed attachments to schema 2 snapshots without exposing local paths", async () => {
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

      const built = await buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);

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

  it("uploads complete source artifacts separately while keeping the visible snapshot filtered", async () => {
    const discardedBranch = "discarded branch that is not visible in the indexed conversation";
    const rawTranscript = Buffer.from([
      JSON.stringify({ role: "user", content: "Login is broken" }),
      JSON.stringify({ role: "assistant", content: "Update auth state handling" }),
      JSON.stringify({ role: "user", content: discardedBranch }),
    ].join("\n"));
    const store = {
      getSession: () => SESSION,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "session-file" as const,
        fileName: "abc.jsonl",
        bytes: rawTranscript,
        mimeType: "application/x-ndjson",
      }],
    };

    const built = await buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);

    expect(built.detail.schemaVersion).toBe(3);
    expect(built.detail.messages.map((message) => message.content)).not.toContain(discardedBranch);
    expect(built.payload.search_text).not.toContain(discardedBranch);
    expect(built.sourceObjects).toHaveLength(1);
    expect(Buffer.from(built.sourceObjects[0].bytes).toString("utf8")).toContain(discardedBranch);
    expect(built.detail.sourceArchive?.entries).toEqual([
      expect.objectContaining({
        sessionKey: SESSION.sessionKey,
        sourceSessionId: SESSION.rawId,
        artifactKind: "session-file",
        fileName: "abc.jsonl",
        sizeBytes: rawTranscript.byteLength,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        objectKey: expect.stringMatching(/^sessions\/[a-f0-9]{32}\/[0-9a-f-]+\/source\/0000-[a-f0-9]{64}-abc\.jsonl$/),
      }),
    ]);
    expect(built.payload.revision_version).toBe(4);
    expect(parseDetailSnapshot(JSON.parse(built.detailJson)).sourceArchive?.entries).toHaveLength(1);
  });

  it("compresses large source artifacts before upload without changing their content revision", async () => {
    const rawTranscript = Buffer.alloc(5 * 1024 * 1024 + 137, "complete-source-archive");
    const built = await buildRemoteSessionUploadFromStore({
      getSession: () => SESSION,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "session-file" as const,
        fileName: "large.jsonl",
        bytes: rawTranscript,
        mimeType: "application/x-ndjson",
      }],
    }, SESSION.sessionKey, 12_000);

    expect(built.sourceObjects).toHaveLength(1);
    expect(built.sourceObjects[0].mimeType).toBe("application/gzip");
    const storedBytes = Buffer.concat(built.sourceObjects.map((object) => Buffer.from(object.bytes)));
    expect(storedBytes.byteLength).toBeLessThan(rawTranscript.byteLength / 10);
    expect(Buffer.compare(
      gunzipSync(storedBytes),
      rawTranscript,
    )).toBe(0);
    const [entry] = built.detail.sourceArchive?.entries ?? [];
    expect(entry).toMatchObject({
      objectKey: built.sourceObjects[0].objectKey,
      storageEncoding: "gzip",
      storedSha256: createHash("sha256").update(storedBytes).digest("hex"),
      storedSizeBytes: storedBytes.byteLength,
      sizeBytes: rawTranscript.byteLength,
    });
    expect(entry.chunks).toBeUndefined();
    expect(parseDetailSnapshot(JSON.parse(built.detailJson)).sourceArchive?.entries[0]).toEqual(entry);

    const relocatedDetail = {
      ...built.detail,
      sourceArchive: {
        schemaVersion: 1 as const,
        entries: [{
          ...entry,
          objectKey: `sessions/${built.payload.id}/relocated/source/large.jsonl.gz`,
        }],
      },
    };
    expect(remoteSessionContentHash(relocatedDetail, built.portable)).toBe(built.payload.content_hash);
  });

  it("builds refresh revisions without preparing storage upload objects", async () => {
    const store = {
      getSession: () => SESSION,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "session-file" as const,
        fileName: "large.jsonl",
        bytes: Buffer.alloc(128 * 1024, "session-content"),
        mimeType: "application/x-ndjson",
      }],
    };
    const upload = await buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);
    const revision = await buildRemoteSessionRevisionFromStore(store, SESSION.sessionKey);

    expect(revision.payload.content_hash).toBe(upload.payload.content_hash);
    expect(revision.sourceObjects).toEqual([]);
    expect(revision.attachmentObjects).toEqual([]);
  });

  it("still splits binary source artifacts into independently verified objects", async () => {
    const rawTranscript = Buffer.alloc(5 * 1024 * 1024 + 137, 0xab);
    const built = await buildRemoteSessionUploadFromStore({
      getSession: () => SESSION,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "session-file" as const,
        fileName: "large.bin",
        bytes: rawTranscript,
        mimeType: "application/octet-stream",
      }],
    }, SESSION.sessionKey, 12_000);

    expect(built.sourceObjects).toHaveLength(2);
    expect(built.sourceObjects.every((object) => object.bytes.byteLength <= 5 * 1024 * 1024)).toBe(true);
    expect(Buffer.compare(
      Buffer.concat(built.sourceObjects.map((object) => Buffer.from(object.bytes))),
      rawTranscript,
    )).toBe(0);
    const [entry] = built.detail.sourceArchive?.entries ?? [];
    expect(entry.storageEncoding).toBeUndefined();
    expect(entry.chunks).toEqual(built.sourceObjects.map((object) => ({
      objectKey: object.objectKey,
      sha256: createHash("sha256").update(object.bytes).digest("hex"),
      sizeBytes: object.bytes.byteLength,
    })));
  });

  it("changes the remote revision when only hidden raw source data changes", async () => {
    const build = (raw: string) => buildRemoteSessionUploadFromStore({
      getSession: () => SESSION,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "session-file" as const,
        fileName: "abc.jsonl",
        bytes: Buffer.from(raw),
        mimeType: "application/x-ndjson",
      }],
    }, SESSION.sessionKey, 12_000);

    const first = await build("visible\nhidden-a");
    const second = await build("visible\nhidden-b");
    expect(first.payload.content_hash).not.toBe(second.payload.content_hash);
  });

  it("ignores volatile Cursor layout data and reuses the previously uploaded archive", async () => {
    const store = (layout: string) => ({
      getSession: () => ({ ...SESSION, source: "cursor-agent" as const }),
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [{
        kind: "cursor-state" as const,
        fileName: "abc.cursor-state.json",
        bytes: Buffer.from(`semantic-session-data|layout:${layout}`),
        revisionBytes: Buffer.from("semantic-session-data"),
        mimeType: "application/json",
      }],
    });
    const first = await buildRemoteSessionUploadFromStore(store("100,200"), SESSION.sessionKey, 12_000);
    const second = await buildRemoteSessionUploadFromStore(store("110,210,310"), SESSION.sessionKey, 13_000);

    expect(first.detail.sourceArchive?.entries[0].sha256)
      .not.toBe(second.detail.sourceArchive?.entries[0].sha256);
    expect(first.detail.sourceArchive?.entries[0].revisionSha256)
      .toBe(second.detail.sourceArchive?.entries[0].revisionSha256);
    expect(first.payload.content_hash).toBe(second.payload.content_hash);

    const reused = await buildRemoteSessionUploadFromStore(
      store("110,210,310"),
      SESSION.sessionKey,
      13_000,
      undefined,
      true,
      first.detail.sourceArchive,
    );
    expect(reused.sourceObjects).toEqual([]);
    expect(reused.detail.sourceArchive).toEqual(first.detail.sourceArchive);
    expect(reused.payload.content_hash).toBe(first.payload.content_hash);
  });

  it("uploads cached messages without new source objects and keeps a previous source archive", async () => {
    const sourceArchive = {
      schemaVersion: 1 as const,
      entries: [{
        sessionKey: SESSION.sessionKey,
        sourceSessionId: SESSION.rawId,
        parentSessionId: null,
        artifactKind: "session-file" as const,
        fileName: "abc.jsonl",
        objectKey: `sessions/${remoteSessionId(SESSION.sessionKey)}/previous/source/abc.jsonl`,
        sha256: "a".repeat(64),
        sizeBytes: 123,
      }],
    };
    const store = {
      getSession: () => ({ ...SESSION, source: "cursor-agent" as const, sourceAvailable: false }),
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: () => [],
    };

    const built = await buildRemoteSessionUploadFromStore(
      store,
      SESSION.sessionKey,
      12_000,
      undefined,
      true,
      sourceArchive,
    );

    expect(built.sourceObjects).toEqual([]);
    expect(built.detail.schemaVersion).toBe(3);
    expect(built.detail.sourceArchive).toEqual(sourceArchive);
    expect(built.detail.messages).toEqual(MESSAGES);
    expect(built.detail.session.sourceAvailable).toBeUndefined();
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

  it("classifies lightweight sync overviews without rebuilding full revisions", () => {
    const remote = {
      id: "remote-overview", sourceSessionKey: SESSION.sessionKey, sourceAgent: "codex" as const,
      sourceSource: SESSION.source, sourceEnvironmentId: "local", sourceEnvironmentKind: "local",
      sourceEnvironmentLabel: "Local", title: SESSION.displayTitle, projectPath: SESSION.projectPath,
      startedAt: "x", updatedAt: SESSION.lastActivityAt, contentHash: "base", revisionVersion: 2,
      messageCount: SESSION.messageCount, traceEventCount: 0, aiSummary: SESSION.aiSummary, tags: SESSION.tags,
      searchText: "", detailObjectKey: "d", portableObjectKey: "p", detailSha256: "dh",
      portableSha256: "ph", createdAt: 1, syncedAt: 4_000,
    };
    const binding = {
      localSessionKey: SESSION.sessionKey, remoteSessionId: remote.id, lastLocalRevision: "base",
      lastRemoteRevision: "base", lastSyncedAt: 4_000, direction: "upload" as const,
    };
    const stateFor = (
      session: SessionSearchResult,
      remoteOverrides: Partial<typeof remote> = {},
      bindings = [binding],
    ) => buildSessionSyncItems([{ session, revision: null }], [{ ...remote, ...remoteOverrides }], bindings)[0].state;

    expect(stateFor(SESSION)).toBe("synced");
    expect(stateFor(SESSION, { updatedAt: SESSION.lastActivityAt + 319 })).toBe("synced");
    expect(stateFor({ ...SESSION, displayTitle: "Renamed locally" })).toBe("local-newer");
    expect(stateFor({ ...SESSION, environmentKind: "ssh", fileMtimeMs: 5_000 })).toBe("local-newer");
    expect(stateFor(SESSION, { contentHash: "cloud-change" })).toBe("synced");
    expect(stateFor({ ...SESSION, fileMtimeMs: 5_000 }, { contentHash: "cloud-change" })).toBe("conflict");
    expect(stateFor(
      { ...SESSION, fileMtimeMs: 5_000 },
      { contentHash: "cloud-change", syncedAt: 6_000 },
    )).toBe("synced");
    expect(stateFor({
      ...SESSION,
      source: "cursor-agent",
      filePath: "C:\\Users\\me\\Cursor\\User\\globalStorage\\state.vscdb",
      fileMtimeMs: 5_000,
    }, {
      sourceSource: "cursor-agent",
      contentHash: "cloud-change",
    })).toBe("synced");
    expect(stateFor(SESSION, {}, [])).toBe("synced");
    expect(stateFor({ ...SESSION, displayTitle: "Renamed by another app" }, {}, [])).toBe("remote-newer");
    expect(stateFor({ ...SESSION, displayTitle: "Changed locally", fileMtimeMs: 5_000 }, {}, [])).toBe("conflict");
  });

  it("repairs only an unambiguous Cursor session identity", () => {
    const local = {
      session: {
        ...SESSION,
        sessionKey: "cursor:empty-window:same-composer",
        rawId: "same-composer",
        source: "cursor-agent" as const,
      },
      revision: null,
    };
    const remote = {
      id: "cursor-remote",
      sourceSessionKey: "cursor:repo-old:same-composer",
      sourceAgent: "cursor" as const,
      sourceSource: "cursor-agent",
      sourceEnvironmentId: "local",
      sourceEnvironmentKind: "local",
      sourceEnvironmentLabel: "Local",
      title: "Cursor session",
      projectPath: "/repo",
      startedAt: "x",
      updatedAt: 1,
      contentHash: "remote",
      revisionVersion: 2,
      messageCount: 1,
      traceEventCount: 0,
      aiSummary: null,
      tags: [],
      searchText: "",
      detailObjectKey: "d",
      portableObjectKey: "p",
      detailSha256: "dh",
      portableSha256: "ph",
      createdAt: 1,
      syncedAt: 2,
    };

    expect(findCursorSessionSyncBindingRepairs([local], [remote], [])).toEqual([{
      localSessionKey: local.session.sessionKey,
      remoteSessionId: remote.id,
      lastLocalRevision: "",
      lastRemoteRevision: "",
      lastSyncedAt: remote.syncedAt,
      direction: "upload",
    }]);
    expect(findCursorSessionSyncBindingRepairs(
      [local],
      [remote, { ...remote, id: "cursor-duplicate" }],
      [],
    )).toEqual([]);
    expect(findCursorSessionSyncBindingRepairs(
      [local],
      [{ ...remote, sourceEnvironmentId: "ssh-other" }],
      [],
    )).toEqual([]);
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
    expect(parsePortableSession({ ...PORTABLE, sourceAgent: "hermes" }).sourceAgent).toBe("hermes");
    expect(parsePortableSession({ ...PORTABLE, sourceAgent: "pi" }).sourceAgent).toBe("pi");
    expect(() => parsePortableSession({ ...PORTABLE, sourceAgent: "unknown" as never })).toThrow("unsupported");
  });

  it("normalizes legacy trace statuses in old detail snapshots", () => {
    const detail = {
      ...buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000),
      traceEvents: [{
        index: 0,
        kind: "event",
        source: "codex",
        title: "legacy result",
        detail: "done",
        timestamp: "2026-07-20T08:00:00.000Z",
        status: "success",
      }],
    };

    expect(parseDetailSnapshot(detail).traceEvents[0]?.status).toBe("completed");
  });

  it("validates optional Turn metadata and bounded trace attributes in detail snapshots", () => {
    const base = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const trace = {
      index: 0,
      kind: "event",
      source: "codex",
      title: "Plan",
      detail: "Inspect the parser",
      timestamp: "2026-07-20T08:00:00.000Z",
      eventType: "codex.plan",
      sourceTurnId: "turn-1",
      attributes: { plan: { step: "Inspect the parser" } },
    };
    const parsed = parseDetailSnapshot({
      ...base,
      messages: [{
        ...MESSAGES[0],
        phase: "commentary",
        sourceTurnId: "turn-1",
      }],
      traceEvents: [trace],
    });

    expect(parsed.messages[0]).toMatchObject({ phase: "commentary", sourceTurnId: "turn-1" });
    expect(parsed.traceEvents[0]).toMatchObject({
      sourceTurnId: "turn-1",
      attributes: { plan: { step: "Inspect the parser" } },
    });

    const rejected = parseDetailSnapshot({
      ...base,
      messages: [
        { ...MESSAGES[0], phase: "draft" },
        { ...MESSAGES[0], sourceTurnId: 42 },
      ],
      traceEvents: [
        { ...trace, sourceTurnId: 42 },
        { ...trace, attributes: "not-an-object" },
        { ...trace, attributes: { text: "x".repeat(50_000) } },
      ],
    });
    expect(rejected.messages).toEqual([]);
    expect(rejected.traceEvents).toEqual([]);
  });

  it.each([1, 2, 3] as const)("reads schema %s snapshots without newer optional fields", (schemaVersion) => {
    const parsed = parseDetailSnapshot({
      ...buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000),
      schemaVersion,
      ...(schemaVersion === 3
        ? { sourceArchive: { schemaVersion: 1, entries: [] } }
        : {}),
    });

    expect(parsed.messages).toEqual(MESSAGES);
    expect(parsed.traceEvents).toEqual([]);
  });

  it("preserves subagent relationships in portable sessions and defaults older payloads", () => {
    const portable = remotePortableSessionFrom(
      { ...SESSION, isSubagent: true, parentSessionId: "parent-1" },
      PORTABLE.messages,
    );
    expect(parsePortableSession(portable)).toMatchObject({ isSubagent: true, parentSessionId: "parent-1" });
    expect(parsePortableSession(PORTABLE)).toMatchObject({ isSubagent: false, parentSessionId: null });
  });

  it("bundles indexed descendant agents into a parent remote upload", async () => {
    const child: SessionSearchResult = {
      ...SESSION,
      sessionKey: "codex:child",
      rawId: "child",
      displayTitle: "Child agent",
      isSubagent: true,
      parentSessionId: "abc",
      timestamp: 2_000,
    };
    const grandchild: SessionSearchResult = {
      ...child,
      sessionKey: "codex:grandchild",
      rawId: "grandchild",
      displayTitle: "Grandchild agent",
      parentSessionId: "child",
      timestamp: 3_000,
    };
    const sessions = new Map([
      [SESSION.sessionKey, SESSION],
      [child.sessionKey, child],
      [grandchild.sessionKey, grandchild],
    ]);
    const store = {
      getSession: (sessionKey: string) => sessions.get(sessionKey) ?? null,
      getAllMessages: (sessionKey: string) => sessionKey === SESSION.sessionKey
        ? MESSAGES
        : [{ role: "assistant" as const, content: sessionKey, timestamp: "2026-07-03T10:02:00.000Z", index: 0 }],
      getTraceEvents: () => [],
      getSessionSourceArtifacts: (sessionKey: string) => [{
        kind: "session-file" as const,
        fileName: `${sessionKey.replace(":", "-")}.jsonl`,
        bytes: Buffer.from(`raw:${sessionKey}`),
        mimeType: "application/x-ndjson",
      }],
      searchSessions: () => [...sessions.values()],
    };

    const { portable, detail, sourceObjects } = await buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);

    expect(portable.sourceSessionId).toBe("abc");
    expect(portable.subagents).toHaveLength(2);
    expect(portable.subagents).toEqual([
      expect.objectContaining({ sourceSessionId: "child", parentSessionId: "abc", isSubagent: true }),
      expect.objectContaining({ sourceSessionId: "grandchild", parentSessionId: "child", isSubagent: true }),
    ]);
    expect(parsePortableSession(JSON.parse(JSON.stringify(portable))).subagents).toHaveLength(2);
    expect(sourceObjects.map((object) => Buffer.from(object.bytes).toString("utf8"))).toEqual([
      `raw:${SESSION.sessionKey}`,
      "raw:codex:child",
      "raw:codex:grandchild",
    ]);
    expect(detail.sourceArchive?.entries.map((entry) => entry.sourceSessionId)).toEqual(["abc", "child", "grandchild"]);
  });

  it("does not silently truncate source data after 200 descendant agents", async () => {
    const children = Array.from({ length: 205 }, (_, index): SessionSearchResult => ({
      ...SESSION,
      sessionKey: `codex:child-${index}`,
      rawId: `child-${index}`,
      displayTitle: `Child ${index}`,
      isSubagent: true,
      parentSessionId: SESSION.rawId,
      timestamp: SESSION.timestamp + index + 1,
    }));
    const sessions = [SESSION, ...children];
    const store = {
      getSession: (sessionKey: string) => sessions.find((item) => item.sessionKey === sessionKey) ?? null,
      getAllMessages: () => MESSAGES,
      getTraceEvents: () => [],
      getSessionSourceArtifacts: (sessionKey: string) => [{
        kind: "session-file" as const,
        fileName: `${sessionKey}.jsonl`,
        bytes: Buffer.from(sessionKey),
        mimeType: "application/x-ndjson",
      }],
      searchSessions: () => sessions,
    };

    const built = await buildRemoteSessionUploadFromStore(store, SESSION.sessionKey, 12_000);

    expect(built.portable.subagents).toHaveLength(205);
    expect(built.sourceObjects).toHaveLength(206);
    expect(parsePortableSession(JSON.parse(built.portableJson)).subagents).toHaveLength(205);
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
    const sourceKeys = [
      `sessions/${remoteSessionId(SESSION.sessionKey)}/archive/source.jsonl.part-0`,
      `sessions/${remoteSessionId(SESSION.sessionKey)}/archive/source.jsonl.part-1`,
    ];
    const detail = {
      ...buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000),
      schemaVersion: 3 as const,
      sourceArchive: {
        schemaVersion: 1 as const,
        entries: [{
          sessionKey: SESSION.sessionKey,
          sourceSessionId: SESSION.rawId,
          parentSessionId: null,
          artifactKind: "session-file" as const,
          fileName: "abc.jsonl",
          chunks: sourceKeys.map((objectKey) => ({
            objectKey,
            sha256: "b".repeat(64),
            sizeBytes: 6,
          })),
          sha256: "a".repeat(64),
          sizeBytes: 12,
        }],
      },
    };
    const { payload, detailJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const calls: string[] = [];
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/storage/v1/object/")) {
          calls.push(`storage-${method}`);
          return new Response(method === "GET" ? gzipSync(detailJson) : "{}", { status: 200 });
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
    expect(calls.slice(2, 6).sort()).toEqual([
      "storage-DELETE",
      "storage-DELETE",
      "storage-DELETE",
      "storage-DELETE",
    ]);
    expect(calls[6]).toBe("row-DELETE");
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

  it("deletes the remote row when Supabase reports an already missing storage object", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    let storageDeletes = 0;
    let rowDeletes = 0;
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/storage/v1/object/")) {
          if (method === "GET") return new Response(gzipSync(detailJson), { status: 200 });
          storageDeletes += 1;
          return storageDeletes === 1
            ? new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 })
            : new Response("{}", { status: 200 });
        }
        if (method === "DELETE") {
          rowDeletes += 1;
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify([payload]), { status: 200 });
      },
    });

    await expect(client.deleteRemoteSessions([payload.id])).resolves.toEqual({
      requested: 1,
      deletedIds: [payload.id],
      missingIds: [],
      failures: [],
    });
    expect(storageDeletes).toBe(2);
    expect(rowDeletes).toBe(1);
  });

  it("keeps the remote row when storage deletion fails for another reason", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    let rowDeletes = 0;
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const method = init?.method ?? "GET";
        if (String(url).includes("/storage/v1/object/")) {
          if (method === "GET") return new Response(gzipSync(detailJson), { status: 200 });
          return new Response(JSON.stringify({ message: "permission denied" }), { status: 403 });
        }
        if (method === "DELETE") {
          rowDeletes += 1;
          return new Response(JSON.stringify([]), { status: 200 });
        }
        return new Response(JSON.stringify([payload]), { status: 200 });
      },
    });

    await expect(client.deleteRemoteSessions([payload.id])).resolves.toEqual({
      requested: 1,
      deletedIds: [],
      missingIds: [],
      failures: [{ id: payload.id, message: "permission denied" }],
    });
    expect(rowDeletes).toBe(0);
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

  it("explains how to repair an outdated source agent constraint", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({ session: SESSION, detail, portable: PORTABLE, now: 11_000 });
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/storage/v1/object/")) return new Response("{}", { status: 200 });
        if (init?.method !== "POST") return new Response("[]", { status: 200 });
        return new Response(JSON.stringify({
          code: "23514",
          message: `new row for relation "${REMOTE_SESSION_TABLE}" violates check constraint "${REMOTE_SESSION_TABLE}_source_agent_check"`,
        }), { status: 400 });
      },
    });

    await expect(client.uploadSession(payload, detailJson, portableJson)).rejects.toThrow(
      "Copy and run the latest setup SQL, then try again.",
    );
  });

  it("uploads source chunks with bounded concurrency", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({
      session: SESSION,
      detail,
      portable: PORTABLE,
      now: 11_000,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    let storageWrites = 0;
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        if (String(url).includes("/rest/v1/")) {
          return init?.method === "POST"
            ? new Response(JSON.stringify([payload]), { status: 200 })
            : new Response("[]", { status: 200 });
        }
        storageWrites += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response("{}", { status: 200 });
      },
    });
    const sourceObjects = Array.from({ length: 8 }, (_, index) => ({
      objectKey: `sessions/${payload.id}/upload/source/chunk-${index}`,
      bytes: Buffer.from(`chunk-${index}`),
      mimeType: "application/octet-stream",
    }));

    await expect(client.uploadSession(payload, detailJson, portableJson, sourceObjects)).resolves.toMatchObject({
      status: "uploaded",
    });
    expect(storageWrites).toBe(10);
    expect(maxInFlight).toBe(4);
  });

  it("stores detail and portable snapshots as gzip objects and reads them back", async () => {
    const detail = buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000);
    const { payload, detailJson, portableJson } = buildRemoteSessionPayload({
      session: SESSION,
      detail,
      portable: PORTABLE,
      now: 11_000,
    });
    const objects = new Map<string, Buffer>();
    let uploaded = false;
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        const method = init?.method ?? "GET";
        if (requestUrl.includes("/rest/v1/")) {
          if (method === "POST") uploaded = true;
          return new Response(JSON.stringify(uploaded ? [payload] : []), { status: 200 });
        }
        const objectKey = decodeURIComponent(requestUrl.split("/agent-session-remote/")[1] ?? "");
        if (method === "POST") {
          objects.set(objectKey, Buffer.from(init?.body as Uint8Array));
          return new Response("{}", { status: 200 });
        }
        const object = objects.get(objectKey);
        const body = object
          ? object.buffer.slice(object.byteOffset, object.byteOffset + object.byteLength) as ArrayBuffer
          : null;
        return new Response(body, { status: object ? 200 : 404 });
      },
    });

    await client.uploadSession(payload, detailJson, portableJson);

    expect(gunzipSync(objects.get(payload.detail_object_key)!)).toEqual(Buffer.from(detailJson));
    expect(gunzipSync(objects.get(payload.portable_object_key)!)).toEqual(Buffer.from(portableJson));
    await expect(client.getDetailSnapshot(payload.id)).resolves.toEqual(detail);
    await expect(client.getPortableSession(payload.id)).resolves.toMatchObject(PORTABLE);
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

  it("keeps an existing source archive when a cached update references it without re-uploading it", async () => {
    const sourceKey = `sessions/${remoteSessionId(SESSION.sessionKey)}/previous/source/abc.jsonl`;
    const sourceArchive = {
      schemaVersion: 1 as const,
      entries: [{
        sessionKey: SESSION.sessionKey,
        sourceSessionId: SESSION.rawId,
        parentSessionId: null,
        artifactKind: "session-file" as const,
        fileName: "abc.jsonl",
        objectKey: sourceKey,
        sha256: "a".repeat(64),
        sizeBytes: 123,
      }],
    };
    const previousDetail = {
      ...buildRemoteSessionSnapshot(SESSION, MESSAGES, [], 10_000),
      schemaVersion: 3 as const,
      sourceArchive,
    };
    const previous = buildRemoteSessionPayload({
      session: SESSION,
      detail: previousDetail,
      portable: PORTABLE,
      now: 11_000,
      uploadId: "previous",
    });
    const nextDetail = {
      ...buildRemoteSessionSnapshot(SESSION, [...MESSAGES, {
        role: "assistant" as const,
        content: "Cached follow-up",
        timestamp: "2026-07-03T10:02:00.000Z",
        index: 2,
      }], [], 12_000),
      schemaVersion: 3 as const,
      sourceArchive,
    };
    const next = buildRemoteSessionPayload({
      session: SESSION,
      detail: nextDetail,
      portable: {
        ...PORTABLE,
        messages: nextDetail.messages,
      },
      now: 13_000,
      uploadId: "next",
    });
    const deletedKeys: string[] = [];
    const client = new SupabaseRemoteSessionClient({
      url: "https://example.supabase.co",
      anonKey: "anon",
      fetchImpl: async (url, init) => {
        const requestUrl = String(url);
        const method = init?.method ?? "GET";
        if (requestUrl.includes("/rest/v1/")) {
          return new Response(
            JSON.stringify(method === "POST" ? [next.payload] : [previous.payload]),
            { status: 200 },
          );
        }
        const objectKey = decodeURIComponent(requestUrl.split("/agent-session-remote/")[1] ?? "");
        if (method === "GET") return new Response(gzipSync(previous.detailJson), { status: 200 });
        if (method === "DELETE") deletedKeys.push(objectKey);
        return new Response("{}", { status: 200 });
      },
    });

    await expect(
      client.uploadSession(next.payload, next.detailJson, next.portableJson),
    ).resolves.toMatchObject({ status: "updated" });

    expect(deletedKeys).not.toContain(sourceKey);
    expect(deletedKeys).toContain(previous.payload.detail_object_key);
    expect(deletedKeys).toContain(previous.payload.portable_object_key);
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
        const requestUrl = String(url);
        calls.push({
          url: requestUrl,
          method: init?.method ?? "GET",
          body: requestUrl.includes("/rest/v1/") && init?.body
            ? JSON.parse(String(init.body))
            : undefined,
        });
        if (requestUrl.includes("/storage/v1/object/")) return new Response("{}", { status: 200 });
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          if ("source_environment_id" in body) return new Response(JSON.stringify(missingColumn), { status: 400 });
          return new Response(JSON.stringify([legacyRow]), { status: 201 });
        }
        if (requestUrl.includes("source_environment_id")) return new Response(JSON.stringify(missingColumn), { status: 400 });
        if (requestUrl.includes("select=id")) return new Response(JSON.stringify([]), { status: 200 });
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
