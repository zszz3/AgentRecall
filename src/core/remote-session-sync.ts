import { createHash } from "node:crypto";
import { migrationAgentForSource } from "./session-migration";
import type { SessionStore } from "./session-store";
import type { MigrationAgent, PortableSession, SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";

export const REMOTE_SESSION_TABLE = "agent_session_remote_sessions";
export const REMOTE_SESSION_BUCKET = "agent-session-remote";
const REMOTE_SESSION_COLUMNS =
  "id,source_session_key,source_agent,source_source,source_environment_id,source_environment_kind,source_environment_label,title,project_path,started_at,updated_at,content_hash,message_count,trace_event_count,ai_summary,tags,search_text,detail_object_key,portable_object_key,detail_sha256,portable_sha256,created_at,synced_at";
const REMOTE_SESSION_LEGACY_COLUMNS =
  "id,source_session_key,source_agent,source_source,title,project_path,started_at,updated_at,content_hash,message_count,trace_event_count,ai_summary,tags,search_text,detail_object_key,portable_object_key,detail_sha256,portable_sha256,created_at,synced_at";

export interface RemoteSessionDetailSnapshot {
  schemaVersion: 1;
  exportedAt: number;
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
}

export interface RemoteSessionListItem {
  id: string;
  sourceSessionKey: string;
  sourceAgent: MigrationAgent;
  sourceSource: string;
  sourceEnvironmentId: string;
  sourceEnvironmentKind: string;
  sourceEnvironmentLabel: string;
  title: string;
  projectPath: string;
  startedAt: string;
  updatedAt: number;
  contentHash: string;
  messageCount: number;
  traceEventCount: number;
  aiSummary: string | null;
  tags: string[];
  searchText: string;
  detailObjectKey: string;
  portableObjectKey: string;
  detailSha256: string;
  portableSha256: string;
  createdAt: number;
  syncedAt: number;
}

export type RemoteSessionStatus =
  | { kind: "unconfigured"; setupSql: string; message: string }
  | { kind: "ready"; setupSql: string }
  | { kind: "missing-table"; setupSql: string; message: string }
  | { kind: "error"; setupSql: string; message: string };

export type RemoteSessionUploadResult =
  | { status: "uploaded"; remoteSession: RemoteSessionListItem }
  | { status: "updated"; remoteSession: RemoteSessionListItem }
  | { status: "skipped"; remoteSession: RemoteSessionListItem };

export interface RemoteSessionClientOptions {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface RemoteSessionRow {
  id: string;
  source_session_key: string;
  source_agent: string;
  source_source: string;
  source_environment_id: string | null;
  source_environment_kind: string | null;
  source_environment_label: string | null;
  title: string;
  project_path: string;
  started_at: string;
  updated_at: number;
  content_hash: string;
  message_count: number;
  trace_event_count: number | null;
  ai_summary: string | null;
  tags: unknown;
  search_text: string | null;
  detail_object_key: string;
  portable_object_key: string;
  detail_sha256: string;
  portable_sha256: string;
  created_at: number;
  synced_at: number;
}

interface RemoteSessionUploadPayload {
  id: string;
  source_session_key: string;
  source_agent: MigrationAgent;
  source_source: string;
  source_environment_id: string;
  source_environment_kind: string;
  source_environment_label: string;
  title: string;
  project_path: string;
  started_at: string;
  updated_at: number;
  content_hash: string;
  message_count: number;
  trace_event_count: number;
  ai_summary: string | null;
  tags: string[];
  search_text: string;
  detail_object_key: string;
  portable_object_key: string;
  detail_sha256: string;
  portable_sha256: string;
  created_at: number;
  synced_at: number;
}

const DEFAULT_REMOTE_SESSION_TIMEOUT_MS = 20_000;

export function buildRemoteSessionSetupSql(tableName = REMOTE_SESSION_TABLE, bucketName = REMOTE_SESSION_BUCKET): string {
  return [
    `create table if not exists public.${tableName} (`,
    "  id text primary key,",
    "  source_session_key text not null,",
    "  source_agent text not null check (source_agent in ('claude', 'codex', 'codebuddy')),",
    "  source_source text not null,",
    "  source_environment_id text not null default 'local',",
    "  source_environment_kind text not null default 'local',",
    "  source_environment_label text not null default 'Local',",
    "  title text not null,",
    "  project_path text not null,",
    "  started_at text not null,",
    "  updated_at bigint not null,",
    "  content_hash text not null,",
    "  message_count integer not null,",
    "  trace_event_count integer not null default 0,",
    "  ai_summary text,",
    "  tags jsonb not null default '[]'::jsonb,",
    "  search_text text not null default '',",
    "  detail_object_key text not null,",
    "  portable_object_key text not null,",
    "  detail_sha256 text not null,",
    "  portable_sha256 text not null,",
    "  created_at bigint not null,",
    "  synced_at bigint not null",
    ");",
    "",
    `alter table public.${tableName} add column if not exists source_environment_id text not null default 'local';`,
    `alter table public.${tableName} add column if not exists source_environment_kind text not null default 'local';`,
    `alter table public.${tableName} add column if not exists source_environment_label text not null default 'Local';`,
    "",
    `create unique index if not exists ${tableName}_content_hash_idx`,
    `  on public.${tableName} (content_hash);`,
    `create index if not exists ${tableName}_updated_at_idx`,
    `  on public.${tableName} (updated_at desc);`,
    `create index if not exists ${tableName}_title_idx`,
    `  on public.${tableName} (title);`,
    "",
    `alter table public.${tableName} enable row level security;`,
    "",
    `drop policy if exists "${tableName}_personal_sync" on public.${tableName};`,
    `create policy "${tableName}_personal_sync"`,
    `  on public.${tableName}`,
    "  for all",
    "  to anon",
    "  using (true)",
    "  with check (true);",
    "",
    "-- Create the private Storage bucket used for remote detail snapshots.",
    "insert into storage.buckets (id, name, public)",
    `values ('${bucketName}', '${bucketName}', false)`,
    "on conflict (id) do nothing;",
    "",
    `drop policy if exists "${bucketName}_objects_personal_sync" on storage.objects;`,
    `create policy "${bucketName}_objects_personal_sync"`,
    "  on storage.objects",
    "  for all",
    "  to anon",
    `  using (bucket_id = '${bucketName}')`,
    `  with check (bucket_id = '${bucketName}');`,
  ].join("\n");
}

export function buildRemoteSessionSnapshot(
  session: SessionSearchResult,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
  now = Date.now(),
): RemoteSessionDetailSnapshot {
  return {
    schemaVersion: 1,
    exportedAt: now,
    session,
    messages,
    traceEvents,
  };
}

export function remoteSessionSearchText(
  session: SessionSearchResult,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
): string {
  const parts = [
    session.displayTitle,
    session.originalTitle,
    session.firstQuestion,
    session.projectPath,
    session.aiSummary ?? "",
    ...session.tags,
    ...messages.map((message) => message.content),
    ...traceEvents.map((event) => `${event.title}\n${event.detail}`),
  ];
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n").slice(0, 200_000);
}

export function remoteSessionContentHash(detail: RemoteSessionDetailSnapshot, portable: PortableSession): string {
  return sha256(stableJson({ detail, portable }));
}

export function remoteSessionId(sourceSessionKey: string): string {
  return sha256(sourceSessionKey).slice(0, 32);
}

export function buildRemoteSessionPayload(options: {
  session: SessionSearchResult;
  detail: RemoteSessionDetailSnapshot;
  portable: PortableSession;
  now?: number;
}): { payload: RemoteSessionUploadPayload; detailJson: string; portableJson: string } {
  const now = integerTimestamp(options.now ?? Date.now());
  const detailJson = stableJson(options.detail);
  const portableJson = stableJson(options.portable);
  const id = remoteSessionId(options.session.sessionKey);
  const detailObjectKey = `sessions/${id}/detail.json`;
  const portableObjectKey = `sessions/${id}/portable.json`;
  const contentHash = remoteSessionContentHash(options.detail, options.portable);
  return {
    detailJson,
    portableJson,
    payload: {
      id,
      source_session_key: options.session.sessionKey,
      source_agent: options.portable.sourceAgent,
      source_source: options.session.source,
      source_environment_id: options.session.environmentId,
      source_environment_kind: options.session.environmentKind,
      source_environment_label: options.session.environmentLabel,
      title: options.session.displayTitle,
      project_path: options.session.projectPath,
      started_at: options.portable.startedAt,
      updated_at: integerTimestamp(options.session.lastActivityAt || options.session.fileMtimeMs || options.session.timestamp),
      content_hash: contentHash,
      message_count: options.detail.messages.length,
      trace_event_count: options.detail.traceEvents.length,
      ai_summary: options.session.aiSummary,
      tags: options.session.tags,
      search_text: remoteSessionSearchText(options.session, options.detail.messages, options.detail.traceEvents),
      detail_object_key: detailObjectKey,
      portable_object_key: portableObjectKey,
      detail_sha256: sha256(detailJson),
      portable_sha256: sha256(portableJson),
      created_at: now,
      synced_at: now,
    },
  };
}

export function buildRemoteSessionUploadFromStore(
  store: Pick<SessionStore, "getSession" | "getAllMessages" | "getTraceEvents">,
  sessionKey: string,
  now = Date.now(),
): { session: SessionSearchResult; detail: RemoteSessionDetailSnapshot; portable: PortableSession; payload: RemoteSessionUploadPayload; detailJson: string; portableJson: string } {
  const session = store.getSession(sessionKey);
  if (!session) throw new Error("Session not found.");
  const messages = store.getAllMessages(sessionKey);
  const traceEvents = store.getTraceEvents(sessionKey);
  const portable = remotePortableSessionFrom(session, messages);
  const detail = buildRemoteSessionSnapshot(session, messages, traceEvents, now);
  const { payload, detailJson, portableJson } = buildRemoteSessionPayload({ session, detail, portable, now });
  return { session, detail, portable, payload, detailJson, portableJson };
}

export function remotePortableSessionFrom(session: SessionSearchResult, messages: SessionMessage[]): PortableSession {
  const sourceAgent = migrationAgentForSource(session.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${session.source} cannot be saved remotely.`);
  }
  if (!session.projectPath.trim()) {
    throw new Error("Session has no project path.");
  }

  const portableMessages = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message, index) => ({
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      index,
    }));

  return {
    sourceSessionKey: session.sessionKey,
    sourceAgent,
    title: session.displayTitle,
    projectPath: session.projectPath,
    startedAt: new Date(session.timestamp).toISOString(),
    messages: portableMessages,
  };
}

function legacyRemoteSessionPayload(payload: RemoteSessionUploadPayload): Omit<
  RemoteSessionUploadPayload,
  "source_environment_id" | "source_environment_kind" | "source_environment_label"
> {
  const {
    source_environment_id: _sourceEnvironmentId,
    source_environment_kind: _sourceEnvironmentKind,
    source_environment_label: _sourceEnvironmentLabel,
    ...legacy
  } = payload;
  return legacy;
}

export function filterRemoteSessions(sessions: RemoteSessionListItem[], query: string): RemoteSessionListItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return sessions;
  return sessions.filter((session) => {
    const haystack = [
      session.title,
      session.projectPath,
      session.aiSummary ?? "",
      session.tags.join(" "),
      session.searchText,
    ].join("\n").toLowerCase();
    return haystack.includes(normalized);
  });
}

export class SupabaseRemoteSessionClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RemoteSessionClientOptions) {
    this.baseUrl = normalizeSupabaseUrl(options.url);
    this.anonKey = options.anonKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_REMOTE_SESSION_TIMEOUT_MS;
    if (!this.baseUrl) throw new Error("Supabase URL is required.");
    if (!this.anonKey) throw new Error("Supabase anon key is required.");
  }

  async checkStatus(): Promise<RemoteSessionStatus> {
    const setupSql = buildRemoteSessionSetupSql();
    const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?select=${REMOTE_SESSION_COLUMNS}&limit=1`, { method: "GET" });
    if (response.ok) return { kind: "ready", setupSql };
    const body = await readResponseBody(response);
    if (isMissingTableError(response.status, body)) {
      return {
        kind: "missing-table",
        setupSql,
        message: `Supabase table ${REMOTE_SESSION_TABLE} was not found.`,
      };
    }
    if (isMissingSchemaColumnError(body)) {
      const legacyResponse = await this.restRequest(`/${REMOTE_SESSION_TABLE}?select=id&limit=1`, { method: "GET" });
      if (legacyResponse.ok) return { kind: "ready", setupSql };
      const legacyBody = await readResponseBody(legacyResponse);
      return { kind: "error", setupSql, message: supabaseErrorMessage(legacyResponse.status, legacyBody) };
    }
    return { kind: "error", setupSql, message: supabaseErrorMessage(response.status, body) };
  }

  async listRemoteSessions(query = ""): Promise<RemoteSessionListItem[]> {
    const { body } = await this.selectRemoteSessionRows(`order=updated_at.desc`);
    return filterRemoteSessions(parseRows(body), query);
  }

  async getRemoteSession(remoteId: string): Promise<RemoteSessionListItem> {
    const { body } = await this.selectRemoteSessionRows(`id=eq.${encodeURIComponent(remoteId)}&limit=1`);
    const [session] = parseRows(body);
    if (!session) throw new Error("Remote session was not found.");
    return session;
  }

  async uploadSession(payload: RemoteSessionUploadPayload, detailJson: string, portableJson: string): Promise<RemoteSessionUploadResult> {
    const existing = await this.getRemoteSessionOrNull(payload.id);
    if (existing?.contentHash === payload.content_hash) return { status: "skipped", remoteSession: existing };

    await this.uploadStorageObject(payload.detail_object_key, detailJson);
    await this.uploadStorageObject(payload.portable_object_key, portableJson);

    const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      if (isMissingSchemaColumnError(body)) {
        return this.uploadLegacySession(payload, existing);
      }
      throw new Error(supabaseErrorMessage(response.status, body));
    }
    const [remoteSession] = parseRows(body);
    if (!remoteSession) throw new Error("Supabase did not return the uploaded remote session.");
    return { status: existing ? "updated" : "uploaded", remoteSession };
  }

  async getDetailSnapshot(remoteIdOrSession: string | RemoteSessionListItem): Promise<RemoteSessionDetailSnapshot> {
    const remote = typeof remoteIdOrSession === "string" ? await this.getRemoteSession(remoteIdOrSession) : remoteIdOrSession;
    const text = await this.downloadStorageObject(remote.detailObjectKey);
    if (sha256(text) !== remote.detailSha256) throw new Error("Remote detail snapshot checksum mismatch.");
    return parseDetailSnapshot(JSON.parse(text));
  }

  async getPortableSession(remoteIdOrSession: string | RemoteSessionListItem): Promise<PortableSession> {
    const remote = typeof remoteIdOrSession === "string" ? await this.getRemoteSession(remoteIdOrSession) : remoteIdOrSession;
    const text = await this.downloadStorageObject(remote.portableObjectKey);
    if (sha256(text) !== remote.portableSha256) throw new Error("Remote portable session checksum mismatch.");
    return parsePortableSession(JSON.parse(text));
  }

  async deleteRemoteSession(remoteId: string): Promise<boolean> {
    const remote = await this.getRemoteSession(remoteId).catch(() => null);
    if (!remote) return false;
    await Promise.allSettled([
      this.deleteStorageObject(remote.detailObjectKey),
      this.deleteStorageObject(remote.portableObjectKey),
    ]);
    const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?id=eq.${encodeURIComponent(remoteId)}`, { method: "DELETE" });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    return true;
  }

  private async getRemoteSessionOrNull(remoteId: string): Promise<RemoteSessionListItem | null> {
    try {
      return await this.getRemoteSession(remoteId);
    } catch {
      return null;
    }
  }

  private async selectRemoteSessionRows(params: string): Promise<{ body: unknown }> {
    const response = await this.restRequest(
      `/${REMOTE_SESSION_TABLE}?select=${REMOTE_SESSION_COLUMNS}&${params}`,
      { method: "GET" },
    );
    const body = await readResponseBody(response);
    if (response.ok) return { body };
    if (!isMissingSchemaColumnError(body)) throw new Error(supabaseErrorMessage(response.status, body));

    const legacyResponse = await this.restRequest(
      `/${REMOTE_SESSION_TABLE}?select=${REMOTE_SESSION_LEGACY_COLUMNS}&${params}`,
      { method: "GET" },
    );
    const legacyBody = await readResponseBody(legacyResponse);
    if (!legacyResponse.ok) throw new Error(supabaseErrorMessage(legacyResponse.status, legacyBody));
    return { body: legacyBody };
  }

  private async uploadLegacySession(
    payload: RemoteSessionUploadPayload,
    existing: RemoteSessionListItem | null,
  ): Promise<RemoteSessionUploadResult> {
    const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(legacyRemoteSessionPayload(payload)),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [remoteSession] = parseRows(body);
    if (!remoteSession) throw new Error("Supabase did not return the uploaded remote session.");
    return { status: existing ? "updated" : "uploaded", remoteSession };
  }

  private async restRequest(path: string, init: RequestInit): Promise<Response> {
    return this.request(`${this.baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async storageRequest(path: string, init: RequestInit): Promise<Response> {
    return this.request(`${this.baseUrl}/storage/v1/object/${REMOTE_SESSION_BUCKET}/${path}`, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async uploadStorageObject(key: string, body: string): Promise<void> {
    const response = await this.storageRequest(key, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-upsert": "true",
      },
      body,
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, responseBody));
  }

  private async downloadStorageObject(key: string): Promise<string> {
    const response = await this.storageRequest(key, { method: "GET" });
    const text = await response.text();
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, text));
    return text;
  }

  private async deleteStorageObject(key: string): Promise<void> {
    const response = await this.storageRequest(key, { method: "DELETE" });
    if (response.status === 404) return;
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Supabase request timed out after ${Math.round(this.timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRows(body: unknown): RemoteSessionListItem[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isRow(row) ? [fromRow(row)] : []));
}

function isRow(value: unknown): value is RemoteSessionRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RemoteSessionRow>;
  return (
    typeof row.id === "string" &&
    typeof row.source_session_key === "string" &&
    typeof row.source_agent === "string" &&
    typeof row.source_source === "string" &&
    typeof row.title === "string" &&
    typeof row.project_path === "string" &&
    typeof row.started_at === "string" &&
    typeof row.updated_at === "number" &&
    typeof row.content_hash === "string" &&
    typeof row.message_count === "number" &&
    typeof row.detail_object_key === "string" &&
    typeof row.portable_object_key === "string" &&
    typeof row.detail_sha256 === "string" &&
    typeof row.portable_sha256 === "string" &&
    typeof row.created_at === "number" &&
    typeof row.synced_at === "number"
  );
}

function fromRow(row: RemoteSessionRow): RemoteSessionListItem {
  return {
    id: row.id,
    sourceSessionKey: row.source_session_key,
    sourceAgent: parseMigrationAgent(row.source_agent),
    sourceSource: row.source_source,
    sourceEnvironmentId: row.source_environment_id || "local",
    sourceEnvironmentKind: row.source_environment_kind || "local",
    sourceEnvironmentLabel: row.source_environment_label || "Local",
    title: row.title,
    projectPath: row.project_path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
    messageCount: row.message_count,
    traceEventCount: row.trace_event_count ?? 0,
    aiSummary: row.ai_summary,
    tags: parseTags(row.tags),
    searchText: row.search_text ?? "",
    detailObjectKey: row.detail_object_key,
    portableObjectKey: row.portable_object_key,
    detailSha256: row.detail_sha256,
    portableSha256: row.portable_sha256,
    createdAt: row.created_at,
    syncedAt: row.synced_at,
  };
}

export function parseDetailSnapshot(value: unknown): RemoteSessionDetailSnapshot {
  if (!value || typeof value !== "object") throw new Error("Remote detail snapshot was not an object.");
  const snapshot = value as Partial<RemoteSessionDetailSnapshot>;
  if (snapshot.schemaVersion !== 1) throw new Error("Remote detail snapshot schema version is unsupported.");
  if (!snapshot.session || typeof snapshot.session !== "object") throw new Error("Remote detail snapshot has no session.");
  if (!Array.isArray(snapshot.messages)) throw new Error("Remote detail snapshot has no messages.");
  if (!Array.isArray(snapshot.traceEvents)) throw new Error("Remote detail snapshot has no trace events.");
  return {
    schemaVersion: 1,
    exportedAt: typeof snapshot.exportedAt === "number" ? snapshot.exportedAt : 0,
    session: snapshot.session as SessionSearchResult,
    messages: snapshot.messages.filter(isSessionMessage),
    traceEvents: snapshot.traceEvents.filter(isTraceEvent),
  };
}

export function parsePortableSession(value: unknown): PortableSession {
  if (!value || typeof value !== "object") throw new Error("Remote portable session was not an object.");
  const session = value as Partial<PortableSession>;
  if (typeof session.sourceSessionKey !== "string") throw new Error("Remote portable session has no source key.");
  if (!isMigrationAgent(session.sourceAgent)) throw new Error("Remote portable session source agent is unsupported.");
  if (typeof session.title !== "string") throw new Error("Remote portable session has no title.");
  if (typeof session.projectPath !== "string") throw new Error("Remote portable session has no project path.");
  if (typeof session.startedAt !== "string") throw new Error("Remote portable session has no start time.");
  if (!Array.isArray(session.messages)) throw new Error("Remote portable session has no messages.");
  return {
    sourceSessionKey: session.sourceSessionKey,
    sourceAgent: session.sourceAgent,
    title: session.title,
    projectPath: session.projectPath,
    startedAt: session.startedAt,
    messages: session.messages.filter(isSessionMessage),
  };
}

function isSessionMessage(value: unknown): value is SessionMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SessionMessage>;
  return (
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    typeof message.timestamp === "string" &&
    typeof message.index === "number"
  );
}

function isTraceEvent(value: unknown): value is SessionTraceEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionTraceEvent>;
  return (
    typeof event.index === "number" &&
    (event.kind === "tool_call" || event.kind === "tool_result" || event.kind === "event") &&
    typeof event.source === "string" &&
    typeof event.title === "string" &&
    typeof event.detail === "string" &&
    typeof event.timestamp === "string"
  );
}

function parseMigrationAgent(value: string): MigrationAgent {
  if (isMigrationAgent(value)) return value;
  throw new Error(`Unsupported remote session agent: ${value}`);
}

function isMigrationAgent(value: unknown): value is MigrationAgent {
  return value === "claude" || value === "codex" || value === "codebuddy";
}

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    output[key] = sortJson(input[key]);
  }
  return output;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function integerTimestamp(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function supabaseErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof body === "string" && body.trim()) return body;
  return `Supabase request failed with status ${status}.`;
}

function isMissingTableError(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (!body || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  const message = (body as { message?: unknown }).message;
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (typeof message === "string" && /table|relation/i.test(message) && /not found|does not exist/i.test(message))
  );
}

function isMissingSchemaColumnError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  const message = (body as { message?: unknown }).message;
  return (
    code === "PGRST204" &&
    typeof message === "string" &&
    /source_environment_(id|kind|label)|schema cache|could not find/i.test(message)
  );
}

function latestRemoteSessionSetupSqlMessage(body: unknown): string {
  const message = supabaseErrorMessage(400, body);
  return [
    message,
    "",
    "Run the latest Supabase remote sessions setup SQL, then try again:",
    "",
    buildRemoteSessionSetupSql(),
  ].join("\n");
}

function normalizeSupabaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
