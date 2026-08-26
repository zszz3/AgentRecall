import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { constants as zlibConstants, gzip, gunzip } from "node:zlib";
import { remoteSessionAgentForSource } from "./session-sources";
import type { SessionStore, SessionSyncBinding } from "./session-store";
import { TRACE_DETAIL_PREVIEW_MAX_CHARS } from "./trace-detail";
import { normalizeSessionTraceStatus, tracePresentation } from "./trace-presentation";
import type { PortableSession, RemoteSessionAgent, SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";

export const REMOTE_SESSION_TABLE = "agent_session_remote_sessions";
export const REMOTE_SESSION_BUCKET = "agent-session-remote";
const REMOTE_SESSION_AGENTS = ["claude", "codex", "codebuddy", "codewiz", "cursor", "hermes", "pi"] as const satisfies readonly RemoteSessionAgent[];
const REMOTE_SESSION_AGENT_CHECK_SQL = REMOTE_SESSION_AGENTS.map((agent) => `'${agent}'`).join(", ");
const REMOTE_SESSION_SOURCE_OBJECT_MAX_BYTES = 5 * 1024 * 1024;
const REMOTE_SESSION_SOURCE_COMPRESSION_MIN_BYTES = 64 * 1024;
const REMOTE_SESSION_STORAGE_UPLOAD_CONCURRENCY = 4;
const REMOTE_TRACE_ATTRIBUTES_MAX_CHARS = TRACE_DETAIL_PREVIEW_MAX_CHARS * 4;
const REMOTE_SESSION_COLUMNS =
  "id,source_session_key,source_agent,source_source,source_environment_id,source_environment_kind,source_environment_label,title,project_path,started_at,updated_at,content_hash,revision_version,message_count,trace_event_count,ai_summary,tags,search_text,detail_object_key,portable_object_key,detail_sha256,portable_sha256,created_at,synced_at";
const REMOTE_SESSION_LEGACY_COLUMNS =
  "id,source_session_key,source_agent,source_source,title,project_path,started_at,updated_at,content_hash,message_count,trace_event_count,ai_summary,tags,search_text,detail_object_key,portable_object_key,detail_sha256,portable_sha256,created_at,synced_at";
const REMOTE_SESSION_SYNC_COLUMNS = REMOTE_SESSION_COLUMNS.replace(",search_text", "");
const REMOTE_SESSION_LEGACY_SYNC_COLUMNS = REMOTE_SESSION_LEGACY_COLUMNS.replace(",search_text", "");

export interface RemoteSessionDetailSnapshot {
  schemaVersion: 1 | 2 | 3;
  exportedAt: number;
  session: SessionSearchResult;
  messages: SessionMessage[];
  traceEvents: SessionTraceEvent[];
  sourceArchive?: RemoteSessionSourceArchive;
}

export interface RemoteSessionSourceArchive {
  schemaVersion: 1;
  entries: RemoteSessionSourceArchiveEntry[];
}

export interface RemoteSessionSourceArchiveEntry {
  sessionKey: string;
  sourceSessionId: string;
  parentSessionId: string | null;
  artifactKind: "session-file" | "cursor-state" | "codewiz-state";
  fileName: string;
  objectKey?: string;
  chunks?: RemoteSessionSourceArchiveChunk[];
  sha256: string;
  sizeBytes: number;
  revisionSha256?: string;
  storageEncoding?: "gzip";
  storedSha256?: string;
  storedSizeBytes?: number;
}

export interface RemoteSessionSourceArchiveChunk {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

export interface RemoteSessionStorageObjectUpload {
  objectKey: string;
  bytes: Uint8Array;
  mimeType: string;
}

export interface RemoteSessionListItem {
  id: string;
  sourceSessionKey: string;
  sourceAgent: RemoteSessionAgent;
  sourceSource: string;
  sourceEnvironmentId: string;
  sourceEnvironmentKind: string;
  sourceEnvironmentLabel: string;
  title: string;
  projectPath: string;
  startedAt: string;
  updatedAt: number;
  contentHash: string;
  revisionVersion?: number;
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
  | { kind: "unconfigured"; setupSql: string; message: string; remediation: "settings" }
  | { kind: "ready"; setupSql: string }
  | { kind: "missing-table"; setupSql: string; message: string; remediation: "sql" }
  | { kind: "missing-storage"; setupSql: string; message: string; remediation: "sql" }
  | { kind: "error"; setupSql: string; message: string; remediation: "settings" | "sql" };

export type SessionSyncState = "local-only" | "local-newer" | "synced" | "remote-newer" | "remote-only" | "conflict";

export interface LocalSessionSyncCandidate {
  session: SessionSearchResult;
  revision: string | null;
}

export interface SessionSyncItem {
  id: string;
  state: SessionSyncState;
  local: SessionSearchResult | null;
  remote: RemoteSessionListItem | null;
  localRevision: string;
  remoteRevision: string;
  lastSyncedAt: number | null;
}

export interface RemoteSessionSyncSnapshot {
  status: RemoteSessionStatus;
  items: SessionSyncItem[];
}

export type RemoteSessionUploadResult =
  | { status: "uploaded"; remoteSession: RemoteSessionListItem }
  | { status: "updated"; remoteSession: RemoteSessionListItem }
  | { status: "skipped"; remoteSession: RemoteSessionListItem };

export interface RemoteSessionDeleteFailure {
  id: string;
  message: string;
}

export interface RemoteSessionDeleteResult {
  requested: number;
  deletedIds: string[];
  missingIds: string[];
  failures: RemoteSessionDeleteFailure[];
}

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
  revision_version?: number | null;
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
  source_agent: RemoteSessionAgent;
  source_source: string;
  source_environment_id: string;
  source_environment_kind: string;
  source_environment_label: string;
  title: string;
  project_path: string;
  started_at: string;
  updated_at: number;
  content_hash: string;
  revision_version: number;
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
    `  source_agent text not null check (source_agent in (${REMOTE_SESSION_AGENT_CHECK_SQL})),`,
    "  source_source text not null,",
    "  source_environment_id text not null default 'local',",
    "  source_environment_kind text not null default 'local',",
    "  source_environment_label text not null default 'Local',",
    "  title text not null,",
    "  project_path text not null,",
    "  started_at text not null,",
    "  updated_at bigint not null,",
    "  content_hash text not null,",
    "  revision_version integer not null default 1,",
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
    `alter table public.${tableName} add column if not exists revision_version integer not null default 1;`,
    "",
    `-- Refresh source_agent check for all supported session uploads on existing tables.`,
    `alter table public.${tableName} drop constraint if exists ${tableName}_source_agent_check;`,
    `alter table public.${tableName} add constraint ${tableName}_source_agent_check`,
    `  check (source_agent in (${REMOTE_SESSION_AGENT_CHECK_SQL}));`,
    "",
    `drop index if exists ${tableName}_content_hash_idx;`,
    `create index if not exists ${tableName}_content_hash_idx`,
    `  on public.${tableName} (content_hash);`,
    `create index if not exists ${tableName}_updated_at_idx`,
    `  on public.${tableName} (updated_at desc);`,
    `create index if not exists ${tableName}_title_idx`,
    `  on public.${tableName} (title);`,
    "",
    `alter table public.${tableName} enable row level security;`,
    `grant select, insert, update, delete on table public.${tableName} to anon;`,
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
    "",
    "grant select on table storage.buckets to anon;",
    "grant select, insert, update, delete on table storage.objects to anon;",
    `drop policy if exists "${bucketName}_bucket_metadata" on storage.buckets;`,
    `create policy "${bucketName}_bucket_metadata"`,
    "  on storage.buckets",
    "  for select",
    "  to anon",
    `  using (id = '${bucketName}');`,
  ].join("\n");
}

export function buildRemoteSessionSnapshot(
  session: SessionSearchResult,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[],
  now = Date.now(),
): RemoteSessionDetailSnapshot {
  const { sourceAvailable: _sourceAvailable, ...snapshotSession } = session;
  const visibleTraceEvents = traceEvents
    .filter((event) => tracePresentation(event).visibility !== "hidden")
    .map((event, index) => ({ ...event, index }));
  return {
    schemaVersion: 1,
    exportedAt: now,
    session: snapshotSession,
    messages,
    traceEvents: visibleTraceEvents,
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
  const session = detail.session;
  return sha256(stableJson({
    schemaVersion: detail.schemaVersion,
    session: {
      source: session.source,
      originalTitle: session.originalTitle,
      firstQuestion: session.firstQuestion,
      timestamp: session.timestamp,
      gitBranch: session.gitBranch ?? null,
      customTitle: session.customTitle,
      displayTitle: session.displayTitle,
      tags: session.tags,
      aiSummary: session.aiSummary,
      isSubagent: session.isSubagent === true,
      parentSessionId: session.parentSessionId ?? null,
    },
    messages: detail.messages,
    traceEvents: detail.traceEvents,
    sourceArchive: detail.sourceArchive
      ? {
          schemaVersion: detail.sourceArchive.schemaVersion,
          entries: detail.sourceArchive.entries.map(({
            objectKey: _objectKey,
            chunks: _chunks,
            sessionKey: _sessionKey,
            revisionSha256,
            sizeBytes,
            storageEncoding: _storageEncoding,
            storedSha256: _storedSha256,
            storedSizeBytes: _storedSizeBytes,
            ...entry
          }) => ({
            ...entry,
            sha256: revisionSha256 ?? entry.sha256,
            ...(revisionSha256 ? {} : { sizeBytes }),
          })),
        }
      : null,
    portable: {
      sourceSessionId: portable.sourceSessionId ?? null,
      sourceAgent: portable.sourceAgent,
      title: portable.title,
      startedAt: portable.startedAt,
      messages: portable.messages,
      isSubagent: portable.isSubagent === true,
      parentSessionId: portable.parentSessionId ?? null,
      subagents: portable.subagents ?? [],
    },
  }));
}

export function remoteSessionId(sourceSessionKey: string): string {
  return sha256(sourceSessionKey).slice(0, 32);
}

export function buildRemoteSessionPayload(options: {
  session: SessionSearchResult;
  detail: RemoteSessionDetailSnapshot;
  portable: PortableSession;
  now?: number;
  remoteId?: string;
  uploadId?: string;
}): { payload: RemoteSessionUploadPayload; detailJson: string; portableJson: string } {
  const now = integerTimestamp(options.now ?? Date.now());
  const detailJson = JSON.stringify(options.detail);
  const portableJson = JSON.stringify(options.portable);
  const id = options.remoteId || remoteSessionId(options.session.sessionKey);
  const uploadId = options.uploadId ?? randomUUID();
  const detailObjectKey = `sessions/${id}/${uploadId}.detail.json.gz`;
  const portableObjectKey = `sessions/${id}/${uploadId}.portable.json.gz`;
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
      revision_version: options.detail.schemaVersion >= 3 ? 4 : 2,
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

export async function buildRemoteSessionUploadFromStore(
  store: Pick<SessionStore, "getSession" | "getAllMessages" | "getTraceEvents">
    & Partial<Pick<SessionStore, "searchSessions">>
    & Partial<Pick<SessionStore, "getAttachmentFile" | "getSessionSourceArtifacts">>,
  sessionKey: string,
  now = Date.now(),
  remoteId?: string,
  includeAttachments = true,
  preservedSourceArchive?: RemoteSessionSourceArchive,
  prepareStorageObjects = true,
): Promise<{
  session: SessionSearchResult;
  detail: RemoteSessionDetailSnapshot;
  portable: PortableSession;
  payload: RemoteSessionUploadPayload;
  detailJson: string;
  portableJson: string;
  attachmentObjects: RemoteSessionStorageObjectUpload[];
  sourceObjects: RemoteSessionStorageObjectUpload[];
}> {
  const session = store.getSession(sessionKey);
  if (!session) throw new Error("Session not found.");
  const messages = store.getAllMessages(sessionKey);
  const traceEvents = store.getTraceEvents(sessionKey);
  const portable = remotePortableSessionFrom(session, messages);
  const relatedSessions = store.searchSessions?.({ limit: 100_000, excludeSubagents: false }) ?? [];
  const childrenByParentId = new Map<string, SessionSearchResult[]>();
  for (const candidate of relatedSessions) {
    if (
      candidate.isSubagent !== true
      || candidate.source !== session.source
      || candidate.environmentId !== session.environmentId
      || !candidate.parentSessionId
    ) continue;
    const children = childrenByParentId.get(candidate.parentSessionId) ?? [];
    children.push(candidate);
    childrenByParentId.set(candidate.parentSessionId, children);
  }
  const subagents: PortableSession[] = [];
  const pendingParentIds = [session.rawId];
  const visitedSessionKeys = new Set<string>();
  const descendantSessions: SessionSearchResult[] = [];
  while (pendingParentIds.length > 0) {
    const parentId = pendingParentIds.shift()!;
    const children = (childrenByParentId.get(parentId) ?? [])
      .sort((left, right) => left.timestamp - right.timestamp || left.sessionKey.localeCompare(right.sessionKey));
    for (const child of children) {
      if (visitedSessionKeys.has(child.sessionKey)) continue;
      visitedSessionKeys.add(child.sessionKey);
      descendantSessions.push(child);
      subagents.push(remotePortableSessionFrom(child, store.getAllMessages(child.sessionKey)));
      pendingParentIds.push(child.rawId);
    }
  }
  if (subagents.length > 0) portable.subagents = subagents;
  const resolvedRemoteId = remoteId || remoteSessionId(session.sessionKey);
  const uploadId = randomUUID();
  const attachmentObjects: RemoteSessionStorageObjectUpload[] = [];
  const sourceObjects: RemoteSessionStorageObjectUpload[] = [];
  const sourceArchiveEntries: RemoteSessionSourceArchiveEntry[] = [];
  for (const sourceSession of [session, ...descendantSessions]) {
    for (const artifact of store.getSessionSourceArtifacts?.(sourceSession.sessionKey) ?? []) {
      const digest = createHash("sha256").update(artifact.bytes).digest("hex");
      const revisionDigest = artifact.revisionBytes
        ? createHash("sha256").update(artifact.revisionBytes).digest("hex")
        : digest;
      const safeName = artifact.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-160) || "session";
      const sequence = String(sourceArchiveEntries.length).padStart(4, "0");
      const objectKeyPrefix = `sessions/${resolvedRemoteId}/${uploadId}/source/${sequence}-${digest}-${safeName}`;
      const reusableEntry = preservedSourceArchive?.entries.find((entry) =>
        entry.sourceSessionId === sourceSession.rawId
        && entry.artifactKind === artifact.kind
        && entry.fileName === artifact.fileName
        && (entry.revisionSha256 ?? entry.sha256) === revisionDigest);
      if (reusableEntry) {
        sourceArchiveEntries.push({
          ...reusableEntry,
          sessionKey: sourceSession.sessionKey,
          sourceSessionId: sourceSession.rawId,
          parentSessionId: sourceSession.parentSessionId ?? null,
        });
        continue;
      }
      if (!prepareStorageObjects) {
        sourceArchiveEntries.push({
          sessionKey: sourceSession.sessionKey,
          sourceSessionId: sourceSession.rawId,
          parentSessionId: sourceSession.parentSessionId ?? null,
          artifactKind: artifact.kind,
          fileName: artifact.fileName,
          objectKey: objectKeyPrefix,
          sha256: digest,
          sizeBytes: artifact.bytes.byteLength,
          ...(revisionDigest === digest ? {} : { revisionSha256: revisionDigest }),
        });
        continue;
      }
      const compressed = await compressSourceArtifact(artifact.bytes, artifact.mimeType);
      const storedBytes = compressed ?? artifact.bytes;
      const storedDigest = compressed
        ? createHash("sha256").update(storedBytes).digest("hex")
        : digest;
      const storedObjectKeyPrefix = compressed ? `${objectKeyPrefix}.gz` : objectKeyPrefix;
      const storedMimeType = compressed ? "application/gzip" : artifact.mimeType;
      let storageLocation: Pick<RemoteSessionSourceArchiveEntry, "objectKey" | "chunks">;
      if (storedBytes.byteLength <= REMOTE_SESSION_SOURCE_OBJECT_MAX_BYTES) {
        sourceObjects.push({ objectKey: storedObjectKeyPrefix, bytes: storedBytes, mimeType: storedMimeType });
        storageLocation = { objectKey: storedObjectKeyPrefix };
      } else {
        const chunkCount = Math.ceil(storedBytes.byteLength / REMOTE_SESSION_SOURCE_OBJECT_MAX_BYTES);
        const chunkDigits = String(chunkCount - 1).length;
        const chunks: RemoteSessionSourceArchiveChunk[] = [];
        for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
          const start = chunkIndex * REMOTE_SESSION_SOURCE_OBJECT_MAX_BYTES;
          const bytes = storedBytes.subarray(
            start,
            Math.min(start + REMOTE_SESSION_SOURCE_OBJECT_MAX_BYTES, storedBytes.byteLength),
          );
          const chunkKey = `${storedObjectKeyPrefix}.part-${String(chunkIndex).padStart(chunkDigits, "0")}`;
          const chunkDigest = createHash("sha256").update(bytes).digest("hex");
          sourceObjects.push({ objectKey: chunkKey, bytes, mimeType: storedMimeType });
          chunks.push({ objectKey: chunkKey, sha256: chunkDigest, sizeBytes: bytes.byteLength });
        }
        storageLocation = { chunks };
      }
      sourceArchiveEntries.push({
        sessionKey: sourceSession.sessionKey,
        sourceSessionId: sourceSession.rawId,
        parentSessionId: sourceSession.parentSessionId ?? null,
        artifactKind: artifact.kind,
        fileName: artifact.fileName,
        ...storageLocation,
        sha256: digest,
        sizeBytes: artifact.bytes.byteLength,
        ...(revisionDigest === digest ? {} : { revisionSha256: revisionDigest }),
        ...(compressed
          ? {
              storageEncoding: "gzip" as const,
              storedSha256: storedDigest,
              storedSizeBytes: storedBytes.byteLength,
            }
          : {}),
      });
    }
  }
  const remoteMessages = await Promise.all(messages.map(async (message) => ({
    ...message,
    attachments: message.attachments
      ? await Promise.all(message.attachments.map(async (attachment) => {
      const local = includeAttachments && attachment.status === "available"
        ? store.getAttachmentFile?.(sessionKey, attachment.id)
        : null;
      if (!local) {
        const { source: _source, remoteObjectKey: _remoteObjectKey, sha256: _sha256, ...metadata } = attachment;
        return { ...metadata, status: attachment.status === "available" ? "missing" as const : attachment.status };
      }
      const bytes = await readFile(local.cachePath);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const safeName = attachment.fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120) || "attachment";
      const objectKey = `sessions/${resolvedRemoteId}/attachments/${digest}-${safeName}`;
      if (prepareStorageObjects) {
        attachmentObjects.push({ objectKey, bytes, mimeType: attachment.mimeType });
      }
      const { source: _source, ...metadata } = attachment;
      return { ...metadata, remoteObjectKey: objectKey, sha256: digest };
      }))
      : undefined,
  })));
  const sourceArchive = sourceArchiveEntries.length > 0
    ? { schemaVersion: 1 as const, entries: sourceArchiveEntries }
    : preservedSourceArchive;
  const detail: RemoteSessionDetailSnapshot = {
    ...buildRemoteSessionSnapshot(session, remoteMessages, traceEvents, now),
    schemaVersion: sourceArchive ? 3 : 2,
    ...(sourceArchive ? { sourceArchive } : {}),
  };
  const { payload, detailJson, portableJson } = buildRemoteSessionPayload({
    session,
    detail,
    portable,
    now,
    remoteId: resolvedRemoteId,
    uploadId,
  });
  return { session, detail, portable, payload, detailJson, portableJson, attachmentObjects, sourceObjects };
}

export async function buildRemoteSessionRevisionFromStore(
  store: Pick<SessionStore, "getSession" | "getAllMessages" | "getTraceEvents">
    & Partial<Pick<SessionStore, "searchSessions">>
    & Partial<Pick<SessionStore, "getAttachmentFile" | "getSessionSourceArtifacts">>,
  sessionKey: string,
  remoteId?: string,
  includeAttachments = true,
  preservedSourceArchive?: RemoteSessionSourceArchive,
): ReturnType<typeof buildRemoteSessionUploadFromStore> {
  return await buildRemoteSessionUploadFromStore(
    store,
    sessionKey,
    0,
    remoteId,
    includeAttachments,
    preservedSourceArchive,
    false,
  );
}

export function buildSessionSyncItems(
  locals: LocalSessionSyncCandidate[],
  remotes: RemoteSessionListItem[],
  bindings: SessionSyncBinding[],
): SessionSyncItem[] {
  const localByKey = new Map(locals.map((candidate) => [candidate.session.sessionKey, candidate]));
  const remoteById = new Map(remotes.map((remote) => [remote.id, remote]));
  const remoteBySourceSessionKey = new Map(remotes.map((remote) => [remote.sourceSessionKey, remote]));
  const bindingByLocal = new Map(bindings.map((binding) => [binding.localSessionKey, binding]));
  const bindingByRemote = new Map(bindings.map((binding) => [binding.remoteSessionId, binding]));
  const usedLocalKeys = new Set<string>();
  const usedRemoteIds = new Set<string>();
  const items: SessionSyncItem[] = [];

  for (const local of locals) {
    const binding = bindingByLocal.get(local.session.sessionKey);
    if (!binding) continue;
    const remote = remoteById.get(binding.remoteSessionId) ?? null;
    if (!remote) continue;
    usedLocalKeys.add(local.session.sessionKey);
    usedRemoteIds.add(remote.id);
    items.push(sessionSyncPair(local, remote, binding));
  }

  for (const local of locals) {
    if (usedLocalKeys.has(local.session.sessionKey)) continue;
    const candidate = remoteBySourceSessionKey.get(local.session.sessionKey);
    const remote = candidate && !usedRemoteIds.has(candidate.id) ? candidate : null;
    if (!remote) continue;
    usedLocalKeys.add(local.session.sessionKey);
    usedRemoteIds.add(remote.id);
    items.push(sessionSyncPair(local, remote, bindingByRemote.get(remote.id) ?? null));
  }

  for (const local of locals) {
    if (usedLocalKeys.has(local.session.sessionKey)) continue;
    items.push({
      id: `local:${local.session.sessionKey}`,
      state: "local-only",
      local: local.session,
      remote: null,
      localRevision: local.revision ?? "",
      remoteRevision: "",
      lastSyncedAt: null,
    });
  }

  for (const remote of remotes) {
    if (usedRemoteIds.has(remote.id)) continue;
    const binding = bindingByRemote.get(remote.id);
    const local = binding ? localByKey.get(binding.localSessionKey) ?? null : null;
    if (local) {
      items.push(sessionSyncPair(local, remote, binding ?? null));
      usedLocalKeys.add(local.session.sessionKey);
      continue;
    }
    items.push({
      id: remote.id,
      state: "remote-only",
      local: null,
      remote,
      localRevision: "",
      remoteRevision: remote.contentHash,
      lastSyncedAt: binding?.lastSyncedAt ?? null,
    });
  }

  return items.sort((a, b) => sessionSyncSortTime(b) - sessionSyncSortTime(a) || sessionSyncTitle(a).localeCompare(sessionSyncTitle(b)));
}

export function findCursorSessionSyncBindingRepairs(
  locals: LocalSessionSyncCandidate[],
  remotes: RemoteSessionListItem[],
  bindings: SessionSyncBinding[],
): SessionSyncBinding[] {
  const localKeys = new Set(locals.map((candidate) => candidate.session.sessionKey));
  const remoteSourceKeys = new Set(remotes.map((remote) => remote.sourceSessionKey));
  const bindingByLocal = new Map(bindings.map((binding) => [binding.localSessionKey, binding]));
  const bindingByRemote = new Map(bindings.map((binding) => [binding.remoteSessionId, binding]));
  const localsByIdentity = new Map<string, LocalSessionSyncCandidate[]>();
  const remotesByIdentity = new Map<string, RemoteSessionListItem[]>();

  for (const local of locals) {
    const session = local.session;
    if (session.source !== "cursor-agent"
      || bindingByLocal.has(session.sessionKey)
      || remoteSourceKeys.has(session.sessionKey)) continue;
    const identity = `${session.storageEnvironmentId ?? session.environmentId ?? "local"}\u0000${session.rawId}`;
    const candidates = localsByIdentity.get(identity) ?? [];
    candidates.push(local);
    localsByIdentity.set(identity, candidates);
  }

  for (const remote of remotes) {
    if (remote.sourceAgent !== "cursor" || remote.sourceSource !== "cursor-agent") continue;
    if (localKeys.has(remote.sourceSessionKey)) continue;
    const existingBinding = bindingByRemote.get(remote.id);
    if (existingBinding && localKeys.has(existingBinding.localSessionKey)) continue;
    const separator = remote.sourceSessionKey.lastIndexOf(":");
    const rawId = separator >= 0 ? remote.sourceSessionKey.slice(separator + 1) : "";
    if (!rawId) continue;
    const identity = `${remote.sourceEnvironmentId || "local"}\u0000${rawId}`;
    const candidates = remotesByIdentity.get(identity) ?? [];
    candidates.push(remote);
    remotesByIdentity.set(identity, candidates);
  }

  const repairs: SessionSyncBinding[] = [];
  for (const [identity, localCandidates] of localsByIdentity) {
    const remoteCandidates = remotesByIdentity.get(identity) ?? [];
    if (localCandidates.length !== 1 || remoteCandidates.length !== 1) continue;
    const local = localCandidates[0];
    const remote = remoteCandidates[0];
    const existingBinding = bindingByRemote.get(remote.id);
    repairs.push(existingBinding
      ? { ...existingBinding, localSessionKey: local.session.sessionKey }
      : {
          localSessionKey: local.session.sessionKey,
          remoteSessionId: remote.id,
          lastLocalRevision: "",
          lastRemoteRevision: "",
          lastSyncedAt: remote.syncedAt,
          direction: "upload",
        });
  }
  return repairs;
}

function sessionSyncPair(
  local: LocalSessionSyncCandidate,
  remote: RemoteSessionListItem,
  binding: SessionSyncBinding | null,
): SessionSyncItem {
  let state: SessionSyncState;
  if (local.revision === null) {
    state = sessionSyncStateFromOverview(local.session, remote, binding);
  } else if ((remote.revisionVersion ?? 1) >= 2 && local.revision === remote.contentHash) {
    state = "synced";
  } else if (!binding) {
    state = (remote.revisionVersion ?? 1) < 2 ? "local-newer" : "conflict";
  } else {
    const localChanged = local.revision !== binding.lastLocalRevision;
    const remoteChanged = remote.contentHash !== binding.lastRemoteRevision;
    if (localChanged && remoteChanged) state = "conflict";
    else if (localChanged) state = "local-newer";
    else if (remoteChanged) state = "remote-newer";
    else state = "synced";
  }
  return {
    id: remote.id,
    state,
    local: local.session,
    remote,
    localRevision: local.revision ?? (state === "synced" ? remote.contentHash : binding?.lastLocalRevision ?? ""),
    remoteRevision: remote.contentHash,
    lastSyncedAt: binding?.lastSyncedAt ?? null,
  };
}

function sessionSyncStateFromOverview(
  local: SessionSearchResult,
  remote: RemoteSessionListItem,
  binding: SessionSyncBinding | null,
): SessionSyncState {
  const revisionVersion = remote.revisionVersion ?? 1;
  const overviewMatches = localSessionOverviewMatchesRemote(local, remote);
  if (revisionVersion >= 2 && overviewMatches && !localSourceChangedAfter(local, remote.syncedAt)) {
    return "synced";
  }
  if (!binding) {
    if (revisionVersion >= 2 && !localSourceChangedAfter(local, remote.syncedAt)) return "remote-newer";
    return revisionVersion < 2 ? "local-newer" : "conflict";
  }

  const remoteChanged = remote.contentHash !== binding.lastRemoteRevision;
  const localChanged = localSourceChangedAfter(local, binding.lastSyncedAt)
    || (!remoteChanged && !overviewMatches);
  if (localChanged && remoteChanged) return "conflict";
  if (localChanged) return "local-newer";
  if (remoteChanged) return "remote-newer";
  return "synced";
}

function localSessionOverviewMatchesRemote(local: SessionSearchResult, remote: RemoteSessionListItem): boolean {
  return remote.sourceSource === local.source
    && remote.title === local.displayTitle
    && remote.messageCount === local.messageCount
    && remote.aiSummary === local.aiSummary
    && sameTags(remote.tags, local.tags);
}

function localSourceChangedAfter(local: SessionSearchResult, syncedAt: number): boolean {
  const sourceModifiedAt = local.source === "cursor-agent"
    && /(?:^|[\\/])state\.vscdb$/i.test(local.filePath)
    ? local.lastActivityAt
    : local.fileMtimeMs;
  return sourceModifiedAt > syncedAt;
}

function sameTags(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightTags = new Set(right);
  return left.every((tag) => rightTags.has(tag));
}

function sessionSyncSortTime(item: SessionSyncItem): number {
  return Math.max(item.local?.lastActivityAt ?? 0, item.remote?.updatedAt ?? 0);
}

function sessionSyncTitle(item: SessionSyncItem): string {
  return item.local?.displayTitle || item.remote?.title || "";
}

export function remotePortableSessionFrom(session: SessionSearchResult, messages: SessionMessage[]): PortableSession {
  const sourceAgent = remoteSessionAgentForSource(session.source);
  if (!sourceAgent) {
    throw new Error(`Session source ${session.source} cannot be saved remotely.`);
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
    sourceSessionId: session.rawId,
    sourceAgent,
    title: session.displayTitle,
    projectPath: session.projectPath,
    startedAt: new Date(session.timestamp).toISOString(),
    messages: portableMessages,
    isSubagent: session.isSubagent === true,
    parentSessionId: session.parentSessionId ?? null,
  };
}

function legacyRemoteSessionPayload(payload: RemoteSessionUploadPayload): Omit<
  RemoteSessionUploadPayload,
  "source_environment_id" | "source_environment_kind" | "source_environment_label" | "revision_version"
> {
  const {
    source_environment_id: _sourceEnvironmentId,
    source_environment_kind: _sourceEnvironmentKind,
    source_environment_label: _sourceEnvironmentLabel,
    revision_version: _revisionVersion,
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
    try {
      const bucketResult = this.authenticatedRequest(`${this.baseUrl}/storage/v1/bucket/${REMOTE_SESSION_BUCKET}`, { method: "GET" })
        .then((response) => ({ response }), (error: unknown) => ({ error }));
      const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?select=${REMOTE_SESSION_COLUMNS}&limit=1`, { method: "GET" });
      if (response.ok) {
        const bucket = await bucketResult;
        if ("error" in bucket) throw bucket.error;
        const bucketResponse = bucket.response;
        if (bucketResponse.ok) return { kind: "ready", setupSql };
        const bucketBody = await readResponseBody(bucketResponse);
        return {
          kind: "missing-storage",
          setupSql,
          remediation: "sql",
          message: `${supabaseErrorMessage(bucketResponse.status, bucketBody)} Run the latest setup SQL, then try again.`,
        };
      }
      const body = await readResponseBody(response);
      if (isMissingTableError(response.status, body)) {
        return {
          kind: "missing-table",
          setupSql,
          remediation: "sql",
          message: `Supabase table ${REMOTE_SESSION_TABLE} was not found.`,
        };
      }
      if (isMissingSchemaColumnError(body)) {
        return { kind: "error", setupSql, remediation: "sql", message: "Remote session sync needs the latest setup SQL before it can compare local and cloud versions." };
      }
      return { kind: "error", setupSql, remediation: "settings", message: supabaseErrorMessage(response.status, body) };
    } catch (error) {
      return {
        kind: "error",
        setupSql,
        remediation: "settings",
        message: supabaseConnectionErrorMessage(error),
      };
    }
  }

  async listRemoteSessions(query = ""): Promise<RemoteSessionListItem[]> {
    const { body } = await this.selectRemoteSessionRows(`order=updated_at.desc`);
    return filterRemoteSessions(parseRows(body), query);
  }

  async listRemoteSessionsForSync(): Promise<RemoteSessionListItem[]> {
    const { body } = await this.selectRemoteSessionRows(
      `order=updated_at.desc`,
      REMOTE_SESSION_SYNC_COLUMNS,
      REMOTE_SESSION_LEGACY_SYNC_COLUMNS,
    );
    return parseRows(body);
  }

  async getRemoteSession(remoteId: string): Promise<RemoteSessionListItem> {
    const { body } = await this.selectRemoteSessionRows(`id=eq.${encodeURIComponent(remoteId)}&limit=1`);
    const [session] = parseRows(body);
    if (!session) throw new Error("Remote session was not found.");
    return session;
  }

  async uploadSession(
    payload: RemoteSessionUploadPayload,
    detailJson: string,
    portableJson: string,
    storageObjects: RemoteSessionStorageObjectUpload[] = [],
  ): Promise<RemoteSessionUploadResult> {
    const existing = await this.getRemoteSessionOrNull(payload.id);
    if (existing?.contentHash === payload.content_hash) return { status: "skipped", remoteSession: existing };
    const previousManagedObjectKeys = existing
      ? await this.getDetailSnapshot(existing).then((snapshot) => remoteManagedObjectKeys(snapshot, existing.id)).catch(() => [])
      : [];
    const nextManagedObjectKeys = new Set(
      remoteManagedObjectKeys(parseDetailSnapshot(JSON.parse(detailJson) as unknown), payload.id),
    );

    try {
      const [detailBytes, portableBytes] = await Promise.all([
        gzipBytes(Buffer.from(detailJson)),
        gzipBytes(Buffer.from(portableJson)),
      ]);
      await this.uploadStorageObjects([
        ...storageObjects,
        {
          objectKey: payload.detail_object_key,
          bytes: detailBytes,
          mimeType: "application/gzip",
        },
        {
          objectKey: payload.portable_object_key,
          bytes: portableBytes,
          mimeType: "application/gzip",
        },
      ]);

      const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?on_conflict=id`, {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(payload),
      });
      const body = await readResponseBody(response);
      let result: RemoteSessionUploadResult;
      if (!response.ok) {
        if (!isMissingSchemaColumnError(body)) throw new Error(remoteSessionUploadErrorMessage(response.status, body));
        result = await this.uploadLegacySession(payload, existing);
      } else {
        const [remoteSession] = parseRows(body);
        if (!remoteSession) throw new Error("Supabase did not return the uploaded remote session.");
        result = { status: existing ? "updated" : "uploaded", remoteSession };
      }
      if (existing) {
        await Promise.all([
          existing.detailObjectKey === payload.detail_object_key
            ? undefined
            : this.deleteStorageObject(existing.detailObjectKey).catch(() => undefined),
          existing.portableObjectKey === payload.portable_object_key
            ? undefined
            : this.deleteStorageObject(existing.portableObjectKey).catch(() => undefined),
          ...previousManagedObjectKeys
            .filter((key) => !nextManagedObjectKeys.has(key))
            .map((key) => this.deleteStorageObject(key).catch(() => undefined)),
        ]);
      }
      return result;
    } catch (error) {
      await Promise.all([
        this.deleteStorageObject(payload.detail_object_key).catch(() => undefined),
        this.deleteStorageObject(payload.portable_object_key).catch(() => undefined),
        ...storageObjects
          .filter((object) => object.objectKey.includes("/source/") && !previousManagedObjectKeys.includes(object.objectKey))
          .map((object) => this.deleteStorageObject(object.objectKey).catch(() => undefined)),
      ]);
      throw error;
    }
  }

  async downloadAttachment(objectKey: string): Promise<Uint8Array> {
    if (!/^sessions\/[a-f0-9]{32}\/[A-Za-z0-9._/-]+$/.test(objectKey)) {
      throw new Error("Remote attachment key is invalid.");
    }
    const response = await this.storageRequest(objectKey, { method: "GET" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, Buffer.from(bytes).toString("utf8")));
    return bytes;
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
    let remote: RemoteSessionListItem;
    try {
      remote = await this.getRemoteSession(remoteId);
    } catch (error) {
      if (error instanceof Error && error.message === "Remote session was not found.") return false;
      throw error;
    }
    const managedObjectKeys = await this.getDetailSnapshot(remote)
      .then((snapshot) => remoteManagedObjectKeys(snapshot, remote.id))
      .catch(() => []);
    await Promise.all([
      this.deleteStorageObject(remote.detailObjectKey),
      this.deleteStorageObject(remote.portableObjectKey),
      ...managedObjectKeys.map((key) => this.deleteStorageObject(key)),
    ]);
    const response = await this.restRequest(`/${REMOTE_SESSION_TABLE}?id=eq.${encodeURIComponent(remoteId)}`, { method: "DELETE" });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    return true;
  }

  async deleteRemoteSessions(remoteIds: string[]): Promise<RemoteSessionDeleteResult> {
    const ids = [...new Set(remoteIds.map((id) => id.trim()).filter(Boolean))];
    const outcomes: Array<
      | { kind: "deleted"; id: string }
      | { kind: "missing"; id: string }
      | { kind: "failed"; id: string; message: string }
    > = new Array(ids.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        const index = cursor++;
        const id = ids[index];
        try {
          const deleted = await this.deleteRemoteSession(id);
          outcomes[index] = deleted ? { kind: "deleted", id } : { kind: "missing", id };
        } catch (error) {
          outcomes[index] = {
            kind: "failed",
            id,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    });
    await Promise.all(workers);
    return {
      requested: ids.length,
      deletedIds: outcomes.flatMap((outcome) => (outcome.kind === "deleted" ? [outcome.id] : [])),
      missingIds: outcomes.flatMap((outcome) => (outcome.kind === "missing" ? [outcome.id] : [])),
      failures: outcomes.flatMap((outcome) => (outcome.kind === "failed" ? [{ id: outcome.id, message: outcome.message }] : [])),
    };
  }

  private async getRemoteSessionOrNull(remoteId: string): Promise<RemoteSessionListItem | null> {
    try {
      return await this.getRemoteSession(remoteId);
    } catch (error) {
      if (error instanceof Error && error.message === "Remote session was not found.") return null;
      throw error;
    }
  }

  private async selectRemoteSessionRows(
    params: string,
    columns = REMOTE_SESSION_COLUMNS,
    legacyColumns = REMOTE_SESSION_LEGACY_COLUMNS,
  ): Promise<{ body: unknown }> {
    const response = await this.restRequest(
      `/${REMOTE_SESSION_TABLE}?select=${columns}&${params}`,
      { method: "GET" },
    );
    const body = await readResponseBody(response);
    if (response.ok) return { body };
    if (!isMissingSchemaColumnError(body)) throw new Error(supabaseErrorMessage(response.status, body));

    const legacyResponse = await this.restRequest(
      `/${REMOTE_SESSION_TABLE}?select=${legacyColumns}&${params}`,
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
    if (!response.ok) throw new Error(remoteSessionUploadErrorMessage(response.status, body));
    const [remoteSession] = parseRows(body);
    if (!remoteSession) throw new Error("Supabase did not return the uploaded remote session.");
    return { status: existing ? "updated" : "uploaded", remoteSession };
  }

  private async restRequest(path: string, init: RequestInit): Promise<Response> {
    return this.authenticatedRequest(`${this.baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async storageRequest(path: string, init: RequestInit): Promise<Response> {
    return this.authenticatedRequest(`${this.baseUrl}/storage/v1/object/${REMOTE_SESSION_BUCKET}/${path}`, {
      ...init,
    });
  }

  private async authenticatedRequest(url: string, init: RequestInit): Promise<Response> {
    return this.request(url, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async uploadStorageObject(
    key: string,
    body: string | Uint8Array,
    contentType = "application/json",
  ): Promise<void> {
    const response = await this.storageRequest(key, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "x-upsert": "true",
      },
      body: body as BodyInit,
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, responseBody));
  }

  private async uploadStorageObjects(objects: RemoteSessionStorageObjectUpload[]): Promise<void> {
    let cursor = 0;
    let failed = false;
    let firstError: unknown;
    const workers = Array.from(
      { length: Math.min(REMOTE_SESSION_STORAGE_UPLOAD_CONCURRENCY, objects.length) },
      async () => {
        while (cursor < objects.length && !failed) {
          const object = objects[cursor++];
          try {
            await this.uploadStorageObject(object.objectKey, object.bytes, object.mimeType);
          } catch (error) {
            if (!failed) firstError = error;
            failed = true;
          }
        }
      },
    );
    await Promise.all(workers);
    if (failed) throw firstError;
  }

  private async downloadStorageObject(key: string): Promise<string> {
    const response = await this.storageRequest(key, { method: "GET" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      throw new Error(supabaseErrorMessage(response.status, bytes.toString("utf8")));
    }
    const decoded = key.endsWith(".gz") ? await gunzipBytes(bytes) : bytes;
    return decoded.toString("utf8");
  }

  private async deleteStorageObject(key: string): Promise<void> {
    const response = await this.storageRequest(key, { method: "DELETE" });
    const body = await readResponseBody(response);
    if (isMissingStorageObjectError(response.status, body)) return;
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

function remoteManagedObjectKeys(snapshot: RemoteSessionDetailSnapshot, remoteId: string): string[] {
  const prefix = `sessions/${remoteId}/`;
  return [...new Set([
    ...snapshot.messages.flatMap((message) =>
      (message.attachments ?? []).flatMap((attachment) =>
        attachment.remoteObjectKey ? [attachment.remoteObjectKey] : [])),
    ...(snapshot.sourceArchive?.entries.flatMap((entry) => [
      ...(entry.objectKey ? [entry.objectKey] : []),
      ...(entry.chunks?.map((chunk) => chunk.objectKey) ?? []),
    ]) ?? []),
  ])].filter((key) => key.startsWith(prefix));
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
    sourceAgent: parseRemoteSessionAgent(row.source_agent),
    sourceSource: row.source_source,
    sourceEnvironmentId: row.source_environment_id || "local",
    sourceEnvironmentKind: row.source_environment_kind || "local",
    sourceEnvironmentLabel: row.source_environment_label || "Local",
    title: row.title,
    projectPath: row.project_path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    contentHash: row.content_hash,
    revisionVersion: row.revision_version ?? 1,
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
  if (snapshot.schemaVersion !== 1 && snapshot.schemaVersion !== 2 && snapshot.schemaVersion !== 3) {
    throw new Error("Remote detail snapshot schema version is unsupported.");
  }
  if (!snapshot.session || typeof snapshot.session !== "object") throw new Error("Remote detail snapshot has no session.");
  if (!Array.isArray(snapshot.messages)) throw new Error("Remote detail snapshot has no messages.");
  if (!Array.isArray(snapshot.traceEvents)) throw new Error("Remote detail snapshot has no trace events.");
  return {
    schemaVersion: snapshot.schemaVersion,
    exportedAt: typeof snapshot.exportedAt === "number" ? snapshot.exportedAt : 0,
    session: snapshot.session as SessionSearchResult,
    messages: snapshot.messages.flatMap((value) => {
      const message = parseSessionMessage(value);
      return message ? [message] : [];
    }),
    traceEvents: snapshot.traceEvents.flatMap((value) => {
      const event = parseTraceEvent(value);
      return event ? [event] : [];
    }),
    ...(snapshot.schemaVersion === 3
      ? { sourceArchive: parseRemoteSessionSourceArchive(snapshot.sourceArchive) }
      : {}),
  };
}

function parseRemoteSessionSourceArchive(value: unknown): RemoteSessionSourceArchive {
  if (!value || typeof value !== "object") throw new Error("Remote detail snapshot has no source archive.");
  const archive = value as Partial<RemoteSessionSourceArchive>;
  if (archive.schemaVersion !== 1 || !Array.isArray(archive.entries)) {
    throw new Error("Remote source archive is unsupported.");
  }
  const entries = archive.entries.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Remote source archive entry was invalid.");
    const entry = value as Partial<RemoteSessionSourceArchiveEntry>;
    const chunks = Array.isArray(entry.chunks)
      ? entry.chunks.map((value) => {
          if (!value || typeof value !== "object") throw new Error("Remote source archive chunk was invalid.");
          const chunk = value as Partial<RemoteSessionSourceArchiveChunk>;
          if (
            typeof chunk.objectKey !== "string"
            || typeof chunk.sha256 !== "string"
            || typeof chunk.sizeBytes !== "number"
          ) {
            throw new Error("Remote source archive chunk was invalid.");
          }
          return chunk as RemoteSessionSourceArchiveChunk;
        })
      : null;
    const hasObjectKey = typeof entry.objectKey === "string";
    const hasChunks = chunks !== null && chunks.length > 0;
    const storageEncoding = entry.storageEncoding === undefined
      ? undefined
      : entry.storageEncoding === "gzip"
        ? "gzip"
        : null;
    const hasStoredMetadata =
      typeof entry.storedSha256 === "string"
      && typeof entry.storedSizeBytes === "number";
    const storedSizeBytes = hasStoredMetadata ? entry.storedSizeBytes! : entry.sizeBytes;
    if (
      typeof entry.sessionKey !== "string"
      || typeof entry.sourceSessionId !== "string"
      || (entry.parentSessionId !== null && typeof entry.parentSessionId !== "string")
      || (entry.artifactKind !== "session-file" && entry.artifactKind !== "cursor-state" && entry.artifactKind !== "codewiz-state")
      || typeof entry.fileName !== "string"
      || hasObjectKey === hasChunks
      || typeof entry.sha256 !== "string"
      || typeof entry.sizeBytes !== "number"
      || (entry.revisionSha256 !== undefined && typeof entry.revisionSha256 !== "string")
      || storageEncoding === null
      || Boolean(storageEncoding) !== hasStoredMetadata
      || (chunks !== null && chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0) !== storedSizeBytes)
    ) {
      throw new Error("Remote source archive entry was invalid.");
    }
    return {
      sessionKey: entry.sessionKey,
      sourceSessionId: entry.sourceSessionId,
      parentSessionId: entry.parentSessionId,
      artifactKind: entry.artifactKind,
      fileName: entry.fileName,
      ...(hasObjectKey ? { objectKey: entry.objectKey } : { chunks: chunks! }),
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
      ...(entry.revisionSha256 ? { revisionSha256: entry.revisionSha256 } : {}),
      ...(storageEncoding
        ? {
            storageEncoding,
            storedSha256: entry.storedSha256!,
            storedSizeBytes: entry.storedSizeBytes!,
          }
        : {}),
    } as RemoteSessionSourceArchiveEntry;
  });
  return { schemaVersion: 1, entries };
}

export function parsePortableSession(value: unknown): PortableSession {
  return parsePortableSessionValue(value, 0, { count: 0 });
}

function parsePortableSessionValue(value: unknown, depth: number, state: { count: number }): PortableSession {
  if (depth > 12 || state.count >= 100_001) throw new Error("Remote portable session has too many nested subagents.");
  state.count += 1;
  if (!value || typeof value !== "object") throw new Error("Remote portable session was not an object.");
  const session = value as Partial<PortableSession>;
  if (typeof session.sourceSessionKey !== "string") throw new Error("Remote portable session has no source key.");
  if (!isRemoteSessionAgent(session.sourceAgent)) throw new Error("Remote portable session source agent is unsupported.");
  if (typeof session.title !== "string") throw new Error("Remote portable session has no title.");
  if (typeof session.projectPath !== "string") throw new Error("Remote portable session has no project path.");
  if (typeof session.startedAt !== "string") throw new Error("Remote portable session has no start time.");
  if (!Array.isArray(session.messages)) throw new Error("Remote portable session has no messages.");
  return {
    sourceSessionKey: session.sourceSessionKey,
    sourceSessionId: typeof session.sourceSessionId === "string" ? session.sourceSessionId : undefined,
    sourceAgent: session.sourceAgent,
    title: session.title,
    projectPath: session.projectPath,
    startedAt: session.startedAt,
    messages: session.messages.flatMap((value) => {
      const message = parseSessionMessage(value);
      return message ? [message] : [];
    }),
    isSubagent: session.isSubagent === true,
    parentSessionId: typeof session.parentSessionId === "string" ? session.parentSessionId : null,
    subagents: Array.isArray(session.subagents)
      ? session.subagents.map((subagent) => parsePortableSessionValue(subagent, depth + 1, state))
      : [],
  };
}

function parseSessionMessage(value: unknown): SessionMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<SessionMessage>;
  if (
    (message.role !== "user" && message.role !== "assistant")
    || typeof message.content !== "string"
    || typeof message.timestamp !== "string"
    || typeof message.index !== "number"
  ) return null;
  if (
    "sourceTurnId" in message
    && typeof message.sourceTurnId !== "string"
    && message.sourceTurnId !== null
  ) return null;
  if (
    "phase" in message
    && message.phase !== "commentary"
    && message.phase !== "final_answer"
    && message.phase !== null
  ) return null;
  return {
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    index: message.index,
    ...("sourceTurnId" in message ? { sourceTurnId: message.sourceTurnId } : {}),
    ...("phase" in message ? { phase: message.phase } : {}),
    ...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}),
  };
}

function isBoundedTraceAttributes(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value).length <= REMOTE_TRACE_ATTRIBUTES_MAX_CHARS;
  } catch {
    return false;
  }
}

function parseTraceEvent(value: unknown): SessionTraceEvent | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Partial<SessionTraceEvent>;
  if (
    typeof event.index !== "number"
    || (event.kind !== "tool_call" && event.kind !== "tool_result" && event.kind !== "event")
    || typeof event.source !== "string"
    || typeof event.title !== "string"
    || typeof event.detail !== "string"
    || typeof event.timestamp !== "string"
  ) return null;
  if (
    "sourceTurnId" in event
    && typeof event.sourceTurnId !== "string"
    && event.sourceTurnId !== null
  ) return null;
  if ("attributes" in event && !isBoundedTraceAttributes(event.attributes)) return null;
  const status = normalizeSessionTraceStatus(event.status);
  return {
    index: event.index,
    kind: event.kind,
    source: event.source,
    title: event.title,
    detail: event.detail,
    timestamp: event.timestamp,
    ...(typeof event.callId === "string" || event.callId === null ? { callId: event.callId } : {}),
    ...(typeof event.eventType === "string" || event.eventType === null ? { eventType: event.eventType } : {}),
    ...(status ? { status } : {}),
    ...(typeof event.sourceTurnId === "string" || event.sourceTurnId === null
      ? { sourceTurnId: event.sourceTurnId }
      : {}),
    ...("attributes" in event ? { attributes: event.attributes as Record<string, unknown> } : {}),
  };
}

function parseRemoteSessionAgent(value: string): RemoteSessionAgent {
  if (isRemoteSessionAgent(value)) return value;
  throw new Error(`Unsupported remote session agent: ${value}`);
}

function isRemoteSessionAgent(value: unknown): value is RemoteSessionAgent {
  return typeof value === "string" && (REMOTE_SESSION_AGENTS as readonly string[]).includes(value);
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

async function compressSourceArtifact(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null> {
  if (
    bytes.byteLength < REMOTE_SESSION_SOURCE_COMPRESSION_MIN_BYTES
    || (!mimeType.startsWith("text/") && !mimeType.includes("json"))
  ) {
    return null;
  }
  const compressed = await gzipBytes(bytes);
  return compressed.byteLength < bytes.byteLength ? compressed : null;
}

function gzipBytes(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(bytes, { level: zlibConstants.Z_BEST_SPEED }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function gunzipBytes(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(bytes, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
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

export function supabaseConnectionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (message && message !== "fetch failed") return message;
  return "Could not reach Supabase. Check the Remote sync URL and your network connection, then try again.";
}

function remoteSessionUploadErrorMessage(status: number, body: unknown): string {
  if (isOutdatedSourceAgentConstraintError(body)) {
    return "Supabase remote session setup does not support this session source yet. Copy and run the latest setup SQL, then try again.";
  }
  return supabaseErrorMessage(status, body);
}

function isOutdatedSourceAgentConstraintError(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  const message = (body as { message?: unknown }).message;
  return (
    code === "23514"
    && typeof message === "string"
    && message.includes(`${REMOTE_SESSION_TABLE}_source_agent_check`)
  );
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

function isMissingStorageObjectError(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (!body || typeof body !== "object") return false;
  const error = body as { statusCode?: unknown; error?: unknown; message?: unknown };
  const responseStatus = typeof error.statusCode === "string"
    ? Number.parseInt(error.statusCode, 10)
    : error.statusCode;
  return responseStatus === 404
    || (typeof error.error === "string" && error.error.toLowerCase() === "not_found")
    || (typeof error.message === "string" && /^object not found\.?$/i.test(error.message.trim()));
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
