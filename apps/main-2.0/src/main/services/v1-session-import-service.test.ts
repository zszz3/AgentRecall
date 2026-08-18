import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AppSettingsUpdate } from "../../core/platform";
import type { SessionSyncBinding } from "../../core/session-store";
import type {
  CodexIncrementalState,
  EnvironmentUpsertInput,
  IndexedSession,
  SessionMessage,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../../core/types";
import { V1SessionImportService } from "./v1-session-import-service";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V1SessionImportService", () => {
  it("imports missing cached sessions, session settings, environments, and sync bindings", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-v1-import-"));
    tempRoots.push(root);
    const v1UserData = path.join(root, "AgentRecall");
    mkdirSync(v1UserData, { recursive: true });
    writeFileSync(path.join(v1UserData, "config.json"), JSON.stringify({
      includeCursorAgent: true,
      remoteSyncEnabled: true,
      remoteSyncSupabaseUrl: "https://example.supabase.co",
      skillSyncEnabled: true,
    }));
    const attachmentPath = path.join(v1UserData, "cached.txt");
    writeFileSync(attachmentPath, "cached attachment");
    createV1Database(path.join(v1UserData, "session-search.sqlite"), attachmentPath);

    const store = new FakeImportStore();
    let importedSettings: AppSettingsUpdate = {};
    const result = await new V1SessionImportService({
      store,
      appDataPath: root,
      v2UserDataPath: path.join(root, "agent-recall-v2"),
      applySettings: async (update) => {
        importedSettings = update;
      },
    }).importData();

    expect(result).toMatchObject({
      sourcePath: v1UserData,
      importedSessions: 1,
      skippedSessions: 0,
      failedSessions: 0,
      importedEnvironments: 1,
      importedSyncBindings: 1,
      importedSettings: 3,
    });
    expect(importedSettings).toMatchObject({
      includeCursorAgent: true,
      remoteSyncEnabled: true,
      remoteSyncSupabaseUrl: "https://example.supabase.co",
    });
    expect(importedSettings).not.toHaveProperty("skillSyncEnabled");
    expect(store.sessions.get("cursor:repo:composer-1")).toMatchObject({
      session: { source: "cursor-agent", environmentId: "ssh-work", rawId: "composer-1" },
      sourceAvailable: false,
      customTitle: "V1 cached title",
      favorited: true,
      hidden: true,
      aiSummary: "Cached summary",
      tags: ["important"],
    });
    expect(store.sessions.get("cursor:repo:composer-1")?.messages[0].attachments?.[0]).toMatchObject({
      status: "available",
      source: { kind: "inline" },
    });
    expect(store.environments).toHaveLength(1);
    expect(store.bindings).toHaveLength(1);
  });

  it("keeps an existing V2 session instead of overwriting it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-v1-import-existing-"));
    tempRoots.push(root);
    const v1UserData = path.join(root, "AgentRecall");
    mkdirSync(v1UserData, { recursive: true });
    createV1Database(path.join(v1UserData, "session-search.sqlite"), null);
    const store = new FakeImportStore();
    store.sessions.set("cursor:repo:composer-1", {
      session: { sessionKey: "cursor:repo:composer-1" } as IndexedSession,
      messages: [],
      sourceAvailable: true,
      customTitle: "V2 title",
      favorited: false,
      hidden: false,
      aiSummary: null,
      tags: [],
    });

    const result = await new V1SessionImportService({
      store,
      appDataPath: root,
      v2UserDataPath: path.join(root, "agent-recall-v2"),
      applySettings: async () => undefined,
    }).importData();

    expect(result.importedSessions).toBe(0);
    expect(result.skippedSessions).toBe(1);
    expect(store.sessions.get("cursor:repo:composer-1")).toMatchObject({
      customTitle: "V2 title",
      favorited: true,
      hidden: true,
      aiSummary: "Cached summary",
      tags: ["important"],
    });
  });

  it("imports the WorkBuddy setting and source rows from V1", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-v1-import-workbuddy-"));
    tempRoots.push(root);
    const v1UserData = path.join(root, "AgentRecall");
    mkdirSync(v1UserData, { recursive: true });
    writeFileSync(path.join(v1UserData, "config.json"), JSON.stringify({ includeWorkBuddy: true }));
    const dbPath = path.join(v1UserData, "session-search.sqlite");
    createV1Database(dbPath, null);
    insertV1WorkBuddySession(dbPath);

    const store = new FakeImportStore();
    let importedSettings: AppSettingsUpdate = {};
    const result = await new V1SessionImportService({
      store,
      appDataPath: root,
      v2UserDataPath: path.join(root, "agent-recall-v2"),
      applySettings: async (update) => {
        importedSettings = update;
      },
    }).importData();

    expect(result).toMatchObject({ importedSessions: 2, failedSessions: 0, importedSettings: 1 });
    expect(importedSettings).toEqual({ includeWorkBuddy: true });
    expect(store.sessions.get("workbuddy:workbuddy-v1")?.session).toMatchObject({
      rawId: "workbuddy-v1",
      source: "workbuddy-cli",
      parentSessionId: null,
    });
  });

  it("imports the DeepSeek Harness setting and source rows from V1", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-recall-v1-import-dsh-"));
    tempRoots.push(root);
    const v1UserData = path.join(root, "AgentRecall");
    mkdirSync(v1UserData, { recursive: true });
    writeFileSync(path.join(v1UserData, "config.json"), JSON.stringify({ includeDeepSeekHarness: true }));
    const dbPath = path.join(v1UserData, "session-search.sqlite");
    createV1Database(dbPath, null);
    insertV1DeepSeekHarnessSession(dbPath);

    const store = new FakeImportStore();
    let importedSettings: AppSettingsUpdate = {};
    const result = await new V1SessionImportService({
      store,
      appDataPath: root,
      v2UserDataPath: path.join(root, "agent-recall-v2"),
      applySettings: async (update) => {
        importedSettings = update;
      },
    }).importData();

    expect(result).toMatchObject({ importedSessions: 2, failedSessions: 0, importedSettings: 1 });
    expect(importedSettings).toEqual({ includeDeepSeekHarness: true });
    expect(store.sessions.get("dsh:dsh-v1")?.session).toMatchObject({
      sessionKey: "dsh:dsh-v1",
      rawId: "dsh-v1",
      source: "deepseek-harness",
      parentSessionId: "parent-dsh",
      isSubagent: false,
    });
  });
});

interface ImportedSessionRecord {
  session: IndexedSession;
  messages: SessionMessage[];
  sourceAvailable: boolean;
  customTitle: string | null;
  favorited: boolean;
  hidden: boolean;
  aiSummary: string | null;
  tags: string[];
}

class FakeImportStore {
  readonly sessions = new Map<string, ImportedSessionRecord>();
  readonly environments: EnvironmentUpsertInput[] = [];
  readonly bindings: SessionSyncBinding[] = [];

  async getSession(sessionKey: string) {
    const record = this.sessions.get(sessionKey);
    if (!record) return null as never;
    return {
      ...record.session,
      customTitle: record.customTitle,
      favorited: record.favorited,
      hidden: record.hidden,
      aiSummary: record.aiSummary,
      tags: record.tags,
    } as never;
  }

  async upsertIndexedSession(
    session: IndexedSession,
    messages: SessionMessage[],
    _tokenEvents: TokenUsageEvent[] = [],
    _traceEvents: SessionTraceEvent[] = [],
    _codexIncrementalState?: CodexIncrementalState,
  ) {
    this.sessions.set(session.sessionKey, {
      session,
      messages,
      sourceAvailable: true,
      customTitle: null,
      favorited: false,
      hidden: false,
      aiSummary: null,
      tags: [],
    });
  }

  async setSessionSourceAvailable(sessionKey: string, available: boolean) {
    this.sessions.get(sessionKey)!.sourceAvailable = available;
  }

  async setCustomTitle(sessionKey: string, title: string | null) {
    this.sessions.get(sessionKey)!.customTitle = title;
  }

  async setFavorited(sessionKey: string, favorited: boolean) {
    this.sessions.get(sessionKey)!.favorited = favorited;
  }

  async setHidden(sessionKey: string, hidden: boolean) {
    this.sessions.get(sessionKey)!.hidden = hidden;
  }

  async setAiSummary(sessionKey: string, summary: string) {
    this.sessions.get(sessionKey)!.aiSummary = summary;
    return true;
  }

  async addTag(sessionKey: string, tagName: string) {
    this.sessions.get(sessionKey)!.tags.push(tagName);
  }

  async getEnvironment(id: string) {
    return (this.environments.find((environment) => environment.id === id) ?? null) as never;
  }

  async upsertEnvironment(input: EnvironmentUpsertInput) {
    this.environments.push(input);
    return input as never;
  }

  async getSessionSyncBindingForLocalKey(sessionKey: string) {
    return this.bindings.find((binding) => binding.localSessionKey === sessionKey) ?? null;
  }

  async getSessionSyncBindingForRemoteId(remoteSessionId: string) {
    return this.bindings.find((binding) => binding.remoteSessionId === remoteSessionId) ?? null;
  }

  async upsertSessionSyncBinding(binding: SessionSyncBinding) {
    this.bindings.push(binding);
  }
}

function createV1Database(dbPath: string, attachmentPath: string | null): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY, raw_id TEXT, source TEXT, environment_id TEXT,
        storage_environment_id TEXT, project_path TEXT, file_path TEXT, original_title TEXT,
        first_question TEXT, timestamp INTEGER, file_mtime_ms REAL, file_size INTEGER,
        pr_url TEXT, pr_number INTEGER, custom_title TEXT, favorited INTEGER, hidden INTEGER,
        source_available INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cached_input_tokens INTEGER, reasoning_output_tokens INTEGER, total_tokens INTEGER,
        ai_summary TEXT, ai_summary_model TEXT, is_subagent INTEGER, parent_session_id TEXT,
        codex_history_mode TEXT
      );
      CREATE TABLE messages (
        session_key TEXT, message_index INTEGER, role TEXT, content TEXT, timestamp TEXT,
        source_turn_id TEXT, phase TEXT, source_record_id TEXT
      );
      CREATE TABLE message_attachments (
        session_key TEXT, message_index INTEGER, attachment_id TEXT, attachment_index INTEGER,
        file_name TEXT, mime_type TEXT, size_bytes INTEGER, preview_kind TEXT, status TEXT, cache_path TEXT
      );
      CREATE TABLE token_events (
        session_key TEXT, dedupe_key TEXT, timestamp INTEGER, input_tokens INTEGER,
        output_tokens INTEGER, cached_input_tokens INTEGER, reasoning_output_tokens INTEGER,
        total_tokens INTEGER, source_turn_id TEXT
      );
      CREATE TABLE trace_events (
        session_key TEXT, trace_index INTEGER, kind TEXT, source TEXT, title TEXT, detail TEXT,
        timestamp TEXT, call_id TEXT, event_type TEXT, status TEXT, source_turn_id TEXT, attributes_json TEXT
      );
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE session_tags (session_key TEXT, tag_id INTEGER);
      CREATE TABLE environments (
        id TEXT, kind TEXT, label TEXT, wsl_distribution TEXT, host_alias TEXT, host TEXT,
        user TEXT, port INTEGER, auth_mode TEXT, identity_file TEXT, enabled INTEGER
      );
      CREATE TABLE session_sync_bindings (
        local_session_key TEXT, remote_session_id TEXT, last_local_revision TEXT,
        last_remote_revision TEXT, last_synced_at INTEGER, direction TEXT
      );
    `);
    db.prepare(`
      INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "cursor:repo:composer-1", "composer-1", "cursor-agent", "ssh-work", "local", "/repo", "/missing/state.vscdb",
      "Original", "Question", 1_000, 2_000, 300, null, null, "V1 cached title", 1, 1, 0,
      10, 20, 3, 4, 37, "Cached summary", "summary-model", 0, null, null,
    );
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("cursor:repo:composer-1", 0, "user", "Hello", "1970-01-01T00:00:01.000Z", null, null, "message-1");
    if (attachmentPath) {
      db.prepare("INSERT INTO message_attachments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("cursor:repo:composer-1", 0, "attachment-1", 0, "cached.txt", "text/plain", 17, "text", "available", attachmentPath);
    }
    db.prepare("INSERT INTO tags VALUES (1, 'important')").run();
    db.prepare("INSERT INTO session_tags VALUES ('cursor:repo:composer-1', 1)").run();
    db.prepare("INSERT INTO environments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("ssh-work", "ssh", "Work SSH", null, "work", "example.com", "me", 22, "identityFile", "/tmp/key", 1);
    db.prepare("INSERT INTO session_sync_bindings VALUES (?, ?, ?, ?, ?, ?)")
      .run("cursor:repo:composer-1", "remote-1", "revision-1", "revision-1", 3_000, "upload");
  } finally {
    db.close();
  }
}

function insertV1WorkBuddySession(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "workbuddy:workbuddy-v1", "workbuddy-v1", "workbuddy-cli", "local", "local",
      "/workspace/workbuddy", "/fixtures/workbuddy-v1.jsonl", "Imported WorkBuddy", "Question",
      4_000, 5_000, 200, null, null, null, 0, 0, 1,
      10, 20, 3, 4, 37, null, null, 0, null, null,
    );
  } finally {
    db.close();
  }
}

function insertV1DeepSeekHarnessSession(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "dsh:dsh-v1", "dsh-v1", "deepseek-harness", "local", "local",
      "/workspace/dsh", "/fixtures/session.jsonl.zstd", "Imported DeepSeek Harness", "Question",
      6_000, 7_000, 300, null, null, null, 0, 0, 1,
      10, 20, 3, 4, 37, null, null, 0, "parent-dsh", null,
    );
  } finally {
    db.close();
  }
}
