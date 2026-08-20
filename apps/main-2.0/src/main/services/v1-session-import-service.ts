import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { AppSettingsUpdate } from "../../core/platform";
import type { SessionStore, SessionSyncBinding } from "../../core/session-store";
import type {
  CodexIncrementalState,
  EnvironmentUpsertInput,
  IndexedSession,
  SessionAttachment,
  SessionMessage,
  SessionSource,
  SessionTraceEvent,
  TokenUsageEvent,
} from "../../core/types";
import type { V1ImportResult } from "../../core/v1-import";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

const V1_PRODUCT_NAMES = ["AgentRecall", "Agent-Session-Search", "agent-session-search"] as const;
const V1_SETTINGS_KEYS = [
  "defaultTerminal",
  "claudeBinary",
  "codexBinary",
  "codeBuddyBinary",
  "codeWizBinary",
  "cursorBinary",
  "tclaudeBinary",
  "tcodexBinary",
  "includeTclaude",
  "includeTcodex",
  "includeCodeBuddyCli",
  "includeWorkBuddy",
  "includeCodeWizCli",
  "includeOpenClaw",
  "includeHermes",
  "includeOpenCode",
  "includeZcode",
  "includeCursorAgent",
  "includeTrae",
  "includeQoder",
  "includePi",
  "includeKimiCli",
  "summaryAutoBackfill",
  "summaryMaxAgeDays",
  "compressionConcurrency",
  "summarySource",
  // The whole summary route, not just its source. Importing the source alone used to carry the
  // user across without the model, directory, or provider mode that make it resolve.
  "summaryApiConfigMode",
  "summaryCodexModel",
  "summaryClaudeModel",
  "summaryCodexConfigDir",
  "summaryClaudeConfigDir",
  "summaryReasoningEffort",
  "sessionSearchMcpEnabled",
  "remoteSyncEnabled",
  "syncSessionAttachments",
  "remoteSyncSupabaseUrl",
  "remoteSyncSupabaseAnonKey",
  "apiConfig",
  "claudeApiConfig",
  "summaryApiConfig",
] as const satisfies readonly (keyof AppSettingsUpdate)[];

const SESSION_SOURCES = new Set<SessionSource>([
  "claude-cli", "claude-app", "codex-cli", "codex-app", "tclaude-cli", "tcodex-cli",
  "codebuddy-cli", "workbuddy-cli", "codewiz-cli", "openclaw", "hermes", "opencode-cli", "zcode-cli",
  "cursor-agent", "trae", "qoder", "pi-cli", "kimi-cli", "deepseek-cli",
]);

interface V1SessionRow {
  session_key: string;
  raw_id: string;
  source: string;
  environment_id: string;
  storage_environment_id: string;
  project_path: string;
  file_path: string;
  original_title: string;
  first_question: string;
  timestamp: number;
  file_mtime_ms: number;
  file_size: number;
  pr_url: string | null;
  pr_number: number | null;
  custom_title: string | null;
  favorited: number;
  hidden: number;
  source_available: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  ai_summary: string | null;
  ai_summary_model: string | null;
  is_subagent: number;
  parent_session_id: string | null;
  codex_history_mode: string | null;
}

interface V1SessionBundle {
  session: IndexedSession;
  messages: SessionMessage[];
  tokenEvents: TokenUsageEvent[];
  traceEvents: SessionTraceEvent[];
  codexIncrementalState?: CodexIncrementalState;
  customTitle: string | null;
  favorited: boolean;
  hidden: boolean;
  sourceAvailable: boolean;
  aiSummary: string | null;
  aiSummaryModel: string;
  tags: string[];
}

interface V1SessionImportStore {
  getSession(sessionKey: string): ReturnType<SessionStore["getSession"]>;
  upsertIndexedSession(
    session: IndexedSession,
    messages: SessionMessage[],
    tokenEvents?: TokenUsageEvent[],
    traceEvents?: SessionTraceEvent[],
    codexIncrementalState?: CodexIncrementalState,
  ): ReturnType<SessionStore["upsertIndexedSession"]>;
  setSessionSourceAvailable(sessionKey: string, available: boolean): ReturnType<SessionStore["setSessionSourceAvailable"]>;
  setCustomTitle(sessionKey: string, title: string | null): ReturnType<SessionStore["setCustomTitle"]>;
  setFavorited(sessionKey: string, favorited: boolean): ReturnType<SessionStore["setFavorited"]>;
  setHidden(sessionKey: string, hidden: boolean): ReturnType<SessionStore["setHidden"]>;
  setAiSummary(sessionKey: string, summary: string, model: string): ReturnType<SessionStore["setAiSummary"]>;
  addTag(sessionKey: string, tagName: string): ReturnType<SessionStore["addTag"]>;
  getEnvironment(id: string): ReturnType<SessionStore["getEnvironment"]>;
  upsertEnvironment(input: EnvironmentUpsertInput): ReturnType<SessionStore["upsertEnvironment"]>;
  getSessionSyncBindingForLocalKey(sessionKey: string): ReturnType<SessionStore["getSessionSyncBindingForLocalKey"]>;
  getSessionSyncBindingForRemoteId(remoteSessionId: string): ReturnType<SessionStore["getSessionSyncBindingForRemoteId"]>;
  upsertSessionSyncBinding(binding: SessionSyncBinding): ReturnType<SessionStore["upsertSessionSyncBinding"]>;
}

interface V1SessionImportDependencies {
  store: V1SessionImportStore;
  appDataPath: string;
  v2UserDataPath: string;
  applySettings(update: AppSettingsUpdate): Promise<void>;
}

export class V1SessionImportService {
  constructor(private readonly dependencies: V1SessionImportDependencies) {}

  async importData(): Promise<V1ImportResult> {
    const sourcePath = findV1UserDataPath(this.dependencies.appDataPath, this.dependencies.v2UserDataPath);
    if (!sourcePath) throw new Error("AgentRecall V1 data was not found on this computer.");

    const settings = readV1Settings(path.join(sourcePath, "config.json"));
    if (Object.keys(settings).length > 0) await this.dependencies.applySettings(settings);

    const dbPath = path.join(sourcePath, "session-search.sqlite");
    if (!existsSync(dbPath)) {
      return emptyResult(sourcePath, Object.keys(settings).length);
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const importedEnvironments = await this.importEnvironments(db);
      const rows = readSessionRows(db);
      let importedSessions = 0;
      let skippedSessions = 0;
      let failedSessions = 0;
      for (const row of rows) {
        try {
          const existing = await this.dependencies.store.getSession(row.session_key);
          if (existing) {
            await this.mergeMissingUserState(db, row, existing);
            skippedSessions += 1;
          } else {
            await this.importSession(readSessionBundle(db, row));
            importedSessions += 1;
          }
        } catch (error) {
          failedSessions += 1;
          console.warn(`[v1-import] Could not import ${row.session_key}:`, error);
        }
      }
      const importedSyncBindings = await this.importSyncBindings(db);
      return {
        sourcePath,
        importedSessions,
        skippedSessions,
        failedSessions,
        importedEnvironments,
        importedSyncBindings,
        importedSettings: Object.keys(settings).length,
      };
    } finally {
      db.close();
    }
  }

  private async importEnvironments(db: DatabaseSyncType): Promise<number> {
    if (!tableExists(db, "environments")) return 0;
    const rows = db.prepare("SELECT * FROM environments WHERE id <> 'local'").all() as Array<Record<string, unknown>>;
    let imported = 0;
    for (const row of rows) {
      const id = textValue(row.id);
      const kind = textValue(row.kind);
      if (!id || (kind !== "ssh" && kind !== "wsl")) continue;
      if (await this.dependencies.store.getEnvironment(id)) continue;
      await this.dependencies.store.upsertEnvironment({
        id,
        kind,
        label: textValue(row.label) || id,
        wslDistribution: nullableText(row.wsl_distribution),
        hostAlias: nullableText(row.host_alias),
        host: nullableText(row.host),
        user: nullableText(row.user),
        port: nullableNumber(row.port),
        authMode: row.auth_mode === "identityFile" || row.auth_mode === "password" ? row.auth_mode : "none",
        identityFile: nullableText(row.identity_file),
        enabled: numberValue(row.enabled, 1) !== 0,
      });
      imported += 1;
    }
    return imported;
  }

  private async importSession(bundle: V1SessionBundle): Promise<void> {
    await this.dependencies.store.upsertIndexedSession(
      bundle.session,
      bundle.messages,
      bundle.tokenEvents,
      bundle.traceEvents,
      bundle.codexIncrementalState,
    );
    await this.dependencies.store.setSessionSourceAvailable(bundle.session.sessionKey, bundle.sourceAvailable);
    if (bundle.customTitle) await this.dependencies.store.setCustomTitle(bundle.session.sessionKey, bundle.customTitle);
    if (bundle.favorited) await this.dependencies.store.setFavorited(bundle.session.sessionKey, true);
    if (bundle.hidden) await this.dependencies.store.setHidden(bundle.session.sessionKey, true);
    if (bundle.aiSummary) {
      await this.dependencies.store.setAiSummary(bundle.session.sessionKey, bundle.aiSummary, bundle.aiSummaryModel);
    }
    for (const tag of bundle.tags) await this.dependencies.store.addTag(bundle.session.sessionKey, tag);
  }

  private async mergeMissingUserState(
    db: DatabaseSyncType,
    row: V1SessionRow,
    existing: Awaited<ReturnType<SessionStore["getSession"]>>,
  ): Promise<void> {
    if (!existing) return;
    if (!existing.customTitle && row.custom_title) {
      await this.dependencies.store.setCustomTitle(row.session_key, row.custom_title);
    }
    if (!existing.favorited && Boolean(row.favorited)) {
      await this.dependencies.store.setFavorited(row.session_key, true);
    }
    if (!existing.hidden && Boolean(row.hidden)) {
      await this.dependencies.store.setHidden(row.session_key, true);
    }
    if (!existing.aiSummary && row.ai_summary?.trim()) {
      await this.dependencies.store.setAiSummary(
        row.session_key,
        row.ai_summary.trim(),
        row.ai_summary_model?.trim() || "v1-import",
      );
    }
    const existingTags = new Set(existing.tags);
    for (const tag of readSessionTags(db, row.session_key)) {
      if (!existingTags.has(tag)) await this.dependencies.store.addTag(row.session_key, tag);
    }
  }

  private async importSyncBindings(db: DatabaseSyncType): Promise<number> {
    if (!tableExists(db, "session_sync_bindings")) return 0;
    const rows = db.prepare("SELECT * FROM session_sync_bindings").all() as Array<Record<string, unknown>>;
    let imported = 0;
    for (const row of rows) {
      const localSessionKey = textValue(row.local_session_key);
      const remoteSessionId = textValue(row.remote_session_id);
      if (!localSessionKey || !remoteSessionId) continue;
      if (!await this.dependencies.store.getSession(localSessionKey)) continue;
      if (await this.dependencies.store.getSessionSyncBindingForLocalKey(localSessionKey)) continue;
      if (await this.dependencies.store.getSessionSyncBindingForRemoteId(remoteSessionId)) continue;
      await this.dependencies.store.upsertSessionSyncBinding({
        localSessionKey,
        remoteSessionId,
        lastLocalRevision: textValue(row.last_local_revision),
        lastRemoteRevision: textValue(row.last_remote_revision),
        lastSyncedAt: numberValue(row.last_synced_at),
        direction: row.direction === "restore" ? "restore" : "upload",
      });
      imported += 1;
    }
    return imported;
  }
}

export function findV1UserDataPath(appDataPath: string, v2UserDataPath: string): string | null {
  for (const productName of V1_PRODUCT_NAMES) {
    const candidate = path.join(appDataPath, productName);
    if (path.resolve(candidate) === path.resolve(v2UserDataPath)) continue;
    if (existsSync(path.join(candidate, "config.json")) || existsSync(path.join(candidate, "session-search.sqlite"))) {
      return candidate;
    }
  }
  return null;
}

function readV1Settings(configPath: string): AppSettingsUpdate {
  if (!existsSync(configPath)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("The AgentRecall V1 settings file could not be read.");
  }
  const update: Record<string, unknown> = {};
  for (const key of V1_SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) update[key] = parsed[key];
  }
  return update as AppSettingsUpdate;
}

function readSessionRows(db: DatabaseSyncType): V1SessionRow[] {
  if (!tableExists(db, "sessions")) return [];
  return db.prepare("SELECT * FROM sessions ORDER BY timestamp, session_key").all() as unknown as V1SessionRow[];
}

function readSessionBundle(db: DatabaseSyncType, row: V1SessionRow): V1SessionBundle {
  if (!SESSION_SOURCES.has(row.source as SessionSource)) throw new Error(`Unsupported session source: ${row.source}`);
  const sessionKey = row.session_key;
  const attachmentsByMessage = readAttachments(db, sessionKey);
  const messageRows = tableExists(db, "messages")
    ? db.prepare("SELECT * FROM messages WHERE session_key = ? ORDER BY message_index").all(sessionKey) as Array<Record<string, unknown>>
    : [];
  const messages: SessionMessage[] = messageRows.map((message) => ({
    index: numberValue(message.message_index),
    role: message.role === "assistant" ? "assistant" : "user",
    content: textValue(message.content),
    timestamp: textValue(message.timestamp),
    ...(nullableText(message.source_turn_id) ? { sourceTurnId: nullableText(message.source_turn_id) } : {}),
    ...(message.phase === "commentary" || message.phase === "final_answer" ? { phase: message.phase } : {}),
    ...(attachmentsByMessage.get(numberValue(message.message_index))?.length
      ? { attachments: attachmentsByMessage.get(numberValue(message.message_index)) }
      : {}),
  }));
  const tokenEvents = tableExists(db, "token_events")
    ? (db.prepare("SELECT * FROM token_events WHERE session_key = ? ORDER BY timestamp, dedupe_key").all(sessionKey) as Array<Record<string, unknown>>)
      .map((event): TokenUsageEvent => ({
        dedupeKey: textValue(event.dedupe_key),
        timestamp: numberValue(event.timestamp),
        inputTokens: numberValue(event.input_tokens),
        outputTokens: numberValue(event.output_tokens),
        cachedInputTokens: numberValue(event.cached_input_tokens),
        ...(numberValue(event.cache_creation_input_tokens) > 0
          ? { cacheCreationInputTokens: numberValue(event.cache_creation_input_tokens) }
          : {}),
        reasoningOutputTokens: numberValue(event.reasoning_output_tokens),
        totalTokens: numberValue(event.total_tokens),
        ...(nullableText(event.source_turn_id) ? { sourceTurnId: nullableText(event.source_turn_id) } : {}),
      }))
    : [];
  const traceEvents = tableExists(db, "trace_events")
    ? (db.prepare("SELECT * FROM trace_events WHERE session_key = ? ORDER BY trace_index").all(sessionKey) as Array<Record<string, unknown>>)
      .map(readTraceEvent)
    : [];
  const tags = readSessionTags(db, sessionKey);
  const provenance = messageRows.map((message) => ({
    messageIndex: numberValue(message.message_index),
    sourceRecordId: nullableText(message.source_record_id),
  }));
  const activeTurnIds = new Set<string>();
  for (const event of traceEvents) {
    if (!event.sourceTurnId) continue;
    if (event.eventType === "codex.turn.started") activeTurnIds.add(event.sourceTurnId);
    if (event.eventType === "codex.turn.completed" || event.eventType === "codex.turn.aborted") activeTurnIds.delete(event.sourceTurnId);
  }
  const isCodex = row.source === "codex-cli" || row.source === "codex-app" || row.source === "tcodex-cli";
  return {
    session: {
      sessionKey,
      rawId: row.raw_id,
      source: row.source as SessionSource,
      projectPath: row.project_path || "",
      filePath: row.file_path || "",
      originalTitle: row.original_title || row.raw_id,
      firstQuestion: row.first_question || "",
      timestamp: numberValue(row.timestamp),
      fileMtimeMs: numberValue(row.file_mtime_ms),
      fileSize: numberValue(row.file_size),
      prUrl: row.pr_url ?? null,
      prNumber: row.pr_number ?? null,
      tokenUsage: {
        inputTokens: numberValue(row.input_tokens),
        outputTokens: numberValue(row.output_tokens),
        cachedInputTokens: numberValue(row.cached_input_tokens),
        ...(numberValue(row.cache_creation_input_tokens) > 0
          ? { cacheCreationInputTokens: numberValue(row.cache_creation_input_tokens) }
          : {}),
        reasoningOutputTokens: numberValue(row.reasoning_output_tokens),
        totalTokens: numberValue(row.total_tokens),
      },
      environmentId: row.environment_id || "local",
      storageEnvironmentId: row.storage_environment_id || row.environment_id || "local",
      isSubagent: Boolean(row.is_subagent),
      parentSessionId: row.parent_session_id ?? null,
    },
    messages,
    tokenEvents,
    traceEvents,
    ...(isCodex
      ? {
          codexIncrementalState: {
            historyMode: row.codex_history_mode === "paginated" ? "paginated" : "legacy",
            messageProvenance: provenance,
            activeTurnIds: [...activeTurnIds],
          },
        }
      : {}),
    customTitle: row.custom_title ?? null,
    favorited: Boolean(row.favorited),
    hidden: Boolean(row.hidden),
    sourceAvailable: numberValue(row.source_available, 1) !== 0,
    aiSummary: row.ai_summary?.trim() || null,
    aiSummaryModel: row.ai_summary_model?.trim() || "v1-import",
    tags,
  };
}

function readSessionTags(db: DatabaseSyncType, sessionKey: string): string[] {
  if (!tableExists(db, "session_tags") || !tableExists(db, "tags")) return [];
  return (db.prepare(`
    SELECT tags.name
    FROM tags INNER JOIN session_tags ON session_tags.tag_id = tags.id
    WHERE session_tags.session_key = ?
    ORDER BY tags.name
  `).all(sessionKey) as Array<{ name: string }>).map((tag) => tag.name);
}

function readAttachments(db: DatabaseSyncType, sessionKey: string): Map<number, SessionAttachment[]> {
  const byMessage = new Map<number, SessionAttachment[]>();
  if (!tableExists(db, "message_attachments")) return byMessage;
  const rows = db.prepare(`
    SELECT * FROM message_attachments
    WHERE session_key = ?
    ORDER BY message_index, attachment_index
  `).all(sessionKey) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const messageIndex = numberValue(row.message_index);
    const cachePath = nullableText(row.cache_path);
    let source: SessionAttachment["source"];
    if (cachePath && existsSync(cachePath)) {
      try {
        source = { kind: "inline", value: readFileSync(cachePath).toString("base64") };
      } catch {
        source = undefined;
      }
    }
    const status = row.status === "unsafe" || row.status === "too_large" || row.status === "missing"
      ? row.status
      : source ? "available" : "missing";
    const attachment: SessionAttachment = {
      id: textValue(row.attachment_id),
      fileName: textValue(row.file_name) || "attachment",
      mimeType: textValue(row.mime_type) || "application/octet-stream",
      previewKind: row.preview_kind === "image" || row.preview_kind === "pdf" || row.preview_kind === "text"
        ? row.preview_kind
        : "file",
      status,
      ...(nullableNumber(row.size_bytes) === null ? {} : { sizeBytes: nullableNumber(row.size_bytes)! }),
      ...(source ? { source } : {}),
    };
    const attachments = byMessage.get(messageIndex) ?? [];
    attachments.push(attachment);
    byMessage.set(messageIndex, attachments);
  }
  return byMessage;
}

function readTraceEvent(row: Record<string, unknown>): SessionTraceEvent {
  let attributes: Record<string, unknown> | undefined;
  try {
    const raw = nullableText(row.attributes_json);
    if (raw) attributes = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    attributes = undefined;
  }
  const status = row.status === "running" || row.status === "completed" || row.status === "failed"
    || row.status === "aborted" || row.status === "unknown" ? row.status : undefined;
  return {
    index: numberValue(row.trace_index),
    kind: row.kind === "tool_call" || row.kind === "tool_result" ? row.kind : "event",
    source: textValue(row.source) as SessionTraceEvent["source"],
    title: textValue(row.title),
    detail: textValue(row.detail),
    timestamp: textValue(row.timestamp),
    ...(nullableText(row.call_id) ? { callId: nullableText(row.call_id) } : {}),
    ...(nullableText(row.event_type) ? { eventType: nullableText(row.event_type) } : {}),
    ...(status ? { status } : {}),
    ...(nullableText(row.source_turn_id) ? { sourceTurnId: nullableText(row.source_turn_id) } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function tableExists(db: DatabaseSyncType, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  const text = textValue(value);
  return text ? text : null;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function emptyResult(sourcePath: string, importedSettings: number): V1ImportResult {
  return {
    sourcePath,
    importedSessions: 0,
    skippedSessions: 0,
    failedSessions: 0,
    importedEnvironments: 0,
    importedSyncBindings: 0,
    importedSettings,
  };
}
