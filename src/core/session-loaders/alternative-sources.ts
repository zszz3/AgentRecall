import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

import { cleanTitle, cursorTimestampFromRow, isMeaningfulUserMessage } from "../format-adapters";
import type {
  LoadedSession,
  SessionFormat,
  SessionMessage,
  SessionSource,
  SessionTraceEvent,
  SessionTraceKind,
  TokenUsage,
  TokenUsageEvent,
} from "../types";
import {
  createIndexedSession,
  createTokenUsage,
  dedupeTraceEvents,
  extractMessages,
  firstQuestion,
  firstStringField,
  isRecord,
  joinNonEmpty,
  numberField,
  objectField,
  parseMaybeJson,
  putTokenEvent,
  readJsonl,
  safeStat,
  shouldSkipFile,
  stringifyDetail,
  stringField,
  titleWithSummary,
  tokenEvent,
  tokenUsageFromEvents,
  unknownField,
  walkJsonlFiles,
  type SessionLoadOptions,
  type TraceEventDraft,
  type VirtualSessionFileStat,
} from "./common";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => import("node:sqlite").DatabaseSync;
};

export const CODEWIZ_SHARE_DIR = path.join(".local", "share", "codewiz");
export const QODER_DIR = ".qoder";
export const TRAE_DIR_NAMES = [".trae", ".trae-cn"] as const;

function readOnlyDatabase(dbPath: string): import("node:sqlite").DatabaseSync | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}
function sqliteTableExists(db: import("node:sqlite").DatabaseSync, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function sqliteColumns(db: import("node:sqlite").DatabaseSync, tableName: string): Set<string> {
  try {
    return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((row) => row.name));
  } catch {
    return new Set();
  }
}

function sqliteHasColumns(db: import("node:sqlite").DatabaseSync, tableName: string, columns: string[]): boolean {
  const available = sqliteColumns(db, tableName);
  return columns.every((column) => available.has(column));
}

function parseJsonText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function timestampString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageFromParts(role: "user" | "assistant", content: string, timestamp: string, index: number): SessionMessage {
  return { role, content, timestamp, index };
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  const direct = firstStringField(value, ["text", "content", "message", "summary", "input", "output"]);
  if (direct) return direct;
  const nested = unknownField(value, "content") ?? unknownField(value, "text");
  if (nested !== value) return extractText(nested);
  return "";
}

function roleFromValue(value: unknown): "user" | "assistant" | null {
  if (!isRecord(value)) return null;
  const message = objectField(value, "message");
  const role = unknownField(value, "role") ?? unknownField(value, "type") ?? unknownField(message, "role");
  return role === "user" || role === "assistant" ? role : null;
}

function sourceMessages(rows: unknown[], format: SessionFormat): SessionMessage[] {
  return extractMessages(rows, format);
}

function normalizeTraceTitle(name: string, summary: string): string {
  return titleWithSummary(name || "event", summary);
}

function traceEventsFromRows(rows: unknown[], format: SessionFormat): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const rowType = stringField(row, "type");
    if (!rowType || rowType === "session" || rowType === "message" || rowType === "user" || rowType === "assistant") continue;

    const data = unknownField(row, "data") ?? unknownField(row, "arguments") ?? unknownField(row, "input") ?? row;
    const parsedData = parseJsonText(data);
    const eventName = stringField(row, "customType") || stringField(row, "name") || stringField(row, "tool_name") || rowType;
    const summary =
      firstStringField(parsedData, ["command", "cmd", "path", "file_path", "query", "url"]) ||
      firstStringField(row, ["command", "cmd", "path", "file_path", "query", "url"]);
    const kind: SessionTraceKind = rowType === "tool_call" || eventName.includes("tool_call") ? "tool_call" : rowType === "tool_result" ? "tool_result" : "event";
    events.push({
      kind,
      source: format,
      title: normalizeTraceTitle(eventName, summary),
      detail: stringifyDetail(parsedData),
      timestamp: timestampString(unknownField(row, "timestamp") ?? unknownField(row, "time")),
      callId: stringField(row, "call_id") || stringField(row, "id") || null,
      eventType: rowType,
      status: "unknown",
    });
  }
  return dedupeTraceEvents(events);
}

function loadOpenClawSessionFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const fallbackRawId = path.basename(filePath, ".jsonl");
  const meta = rows.find((row): row is Record<string, unknown> => isRecord(row) && stringField(row, "type") === "session");
  const rawId = stringField(meta, "id") || fallbackRawId;
  const projectPath = stringField(meta, "cwd") || rows.map((row) => (isRecord(row) ? stringField(row, "cwd") : "")).find(Boolean) || "";
  const messages = sourceMessages(rows, "openclaw");
  const traceEvents = traceEventsFromRows(rows, "openclaw");
  const question = firstQuestion(messages);

  return {
    session: createIndexedSession({
      keyPrefix: "openclaw",
      rawId,
      source: "openclaw",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(meta && unknownField(meta, "timestamp")) || stat.mtimeMs,
      stat,
    }),
    messages,
    traceEvents,
  };
}

export function loadOpenClawSessions(openClawDir = path.join(os.homedir(), ".openclaw")): LoadedSession[] {
  return [...loadOpenClawSessionsIterator(openClawDir)];
}

export function* loadOpenClawSessionsIterator(
  openClawDir = path.join(os.homedir(), ".openclaw"),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const agentsDir = path.join(openClawDir, "agents");
  if (!fs.existsSync(agentsDir)) return;
  for (const filePath of walkJsonlFiles(agentsDir)) {
    if (filePath.endsWith(".trajectory.jsonl")) continue;
    if (!filePath.includes(`${path.sep}sessions${path.sep}`)) continue;
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadOpenClawSessionFile(filePath, stat);
    if (loaded) yield loaded;
  }
}

function decodeTraeProjectDir(value: string): string {
  if (!value) return "";
  if (!value.startsWith("-")) return value;

  const decoded = value.replace(/-/g, "/");
  if (fs.existsSync(decoded)) return decoded;

  // Trae's legacy directory encoding is lossy: "/" and "_" both become "-".
  // Prefer a candidate that exists on disk when the session has no raw cwd.
  const slashIndexes: number[] = [];
  for (let index = 1; index < decoded.length; index += 1) {
    if (decoded[index] === "/") slashIndexes.push(index);
  }

  const maxCandidates = 4096;
  let attempts = 0;
  const chars = decoded.split("");
  const findExistingCandidate = (index: number): string | null => {
    if (attempts >= maxCandidates) return null;
    if (index >= slashIndexes.length) {
      attempts += 1;
      const candidate = chars.join("");
      return fs.existsSync(candidate) ? candidate : null;
    }

    const slashIndex = slashIndexes[index];
    const slashCandidate = findExistingCandidate(index + 1);
    if (slashCandidate) return slashCandidate;

    chars[slashIndex] = "_";
    const underscoreCandidate = findExistingCandidate(index + 1);
    chars[slashIndex] = "/";
    return underscoreCandidate;
  };

  const existingCandidate = findExistingCandidate(0);
  if (existingCandidate) {
    return existingCandidate;
  }

  return decoded;
}

function traeAssistantSummary(row: Record<string, unknown>): string {
  const parts = [
    stringField(row, "outcome"),
    Array.isArray(row.actions) && row.actions.length > 0 ? `Actions:\n${row.actions.map((item) => `- ${String(item)}`).join("\n")}` : "",
    Array.isArray(row.learned) && row.learned.length > 0 ? `Learned:\n${row.learned.map((item) => `- ${String(item)}`).join("\n")}` : "",
  ];
  return joinNonEmpty(parts);
}

function loadTraeMemoryFile(filePath: string, traeDir: string, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath).filter(isRecord);
  if (rows.length === 0) return null;
  const rawId = path.basename(filePath, ".jsonl");
  const projectMarker = `${path.sep}memory${path.sep}projects${path.sep}`;
  const projectSegment = filePath.includes(projectMarker) ? filePath.split(projectMarker)[1]?.split(path.sep)[0] || "" : "";
  const projectPath = firstStringField(rows[0], ["projectPath", "project_path", "cwd"]) || decodeTraeProjectDir(projectSegment);
  const messages: SessionMessage[] = [];
  for (const row of rows) {
    const ts = timestampString(stringField(row, "message_summary_time") || stringField(row, "timestamp"));
    const intent = stringField(row, "intent");
    if (intent && isMeaningfulUserMessage(intent)) messages.push(messageFromParts("user", intent, ts, messages.length));
    const assistant = traeAssistantSummary(row);
    if (assistant) messages.push(messageFromParts("assistant", assistant, ts, messages.length));
  }
  const question = firstQuestion(messages);
  return {
    session: createIndexedSession({
      keyPrefix: "trae",
      rawId,
      source: "trae",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(stringField(rows[0], "message_summary_time") || stringField(rows[0], "timestamp")) || stat.mtimeMs,
      stat,
    }),
    messages,
  };
}

export function loadTraeSessions(traeDir = path.join(os.homedir(), ".trae")): LoadedSession[] {
  return [...loadTraeSessionsIterator(traeDir)];
}

export function* loadTraeSessionsIterator(traeDir = path.join(os.homedir(), ".trae"), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const memoryDir = path.join(traeDir, "memory", "projects");
  if (!fs.existsSync(memoryDir)) return;
  for (const filePath of walkJsonlFiles(memoryDir)) {
    if (!path.basename(filePath).startsWith("session_memory_")) continue;
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadTraeMemoryFile(filePath, traeDir, stat);
    if (loaded) yield loaded;
  }
}

export function loadQoderSessions(qoderDir = path.join(os.homedir(), QODER_DIR)): LoadedSession[] {
  return [...loadQoderSessionsIterator(qoderDir)];
}

export function* loadQoderSessionsIterator(qoderDir = path.join(os.homedir(), QODER_DIR), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const projectsDir = path.join(qoderDir, "cache", "projects");
  if (!fs.existsSync(projectsDir)) return;
  for (const projectEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const slug = projectEntry.name;
    const conversationDir = path.join(projectsDir, slug, "conversation-history");
    if (!fs.existsSync(conversationDir)) continue;
    for (const filePath of walkJsonlFiles(conversationDir)) {
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat)) continue;
      const loaded = loadQoderConversationFile(filePath, slug, stat);
      if (loaded) yield loaded;
    }
  }
}

function stripQoderSlugHash(slug: string): string {
  return slug.replace(/-[0-9a-f]{8}$/, "") || slug;
}

function qoderContentFromRow(row: Record<string, unknown>): string {
  const message = row.message;
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is Record<string, unknown> => isRecord(item) && stringField(item, "type") === "text")
    .map((item) => stringField(item, "text"))
    .filter(Boolean)
    .join("\n");
}

function loadQoderConversationFile(filePath: string, slug: string, stat: VirtualSessionFileStat): LoadedSession | null {
  return loadQoderSessionRows(filePath, readJsonl(filePath), { stat, slug });
}

function extractQoderSlugFromPath(filePath: string): string {
  const match = filePath.match(/projects\/([^/]+)\/conversation-history\//);
  return match?.[1] ?? path.basename(filePath);
}

export function loadQoderSessionRows(filePath: string, rows: unknown[], options: { stat: VirtualSessionFileStat; slug?: string }): LoadedSession | null {
  const filteredRows = rows.filter(isRecord);
  if (filteredRows.length === 0) return null;
  const slug = options.slug ?? extractQoderSlugFromPath(filePath);
  const taskId = path.basename(filePath, ".jsonl");
  const rawId = `${slug}/${taskId}`;
  const projectPath = stripQoderSlugHash(slug);
  const messages: SessionMessage[] = [];
  for (const row of filteredRows) {
    const role = stringField(row, "role");
    if (role !== "user" && role !== "assistant") continue;
    const content = qoderContentFromRow(row);
    if (!content) continue;
    messages.push(messageFromParts(role, content, "", messages.length));
  }
  if (messages.length === 0) return null;
  const question = firstQuestion(messages);
  return {
    session: createIndexedSession({
      keyPrefix: "qoder",
      rawId,
      source: "qoder",
      projectPath,
      filePath,
      originalTitle: cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: options.stat.mtimeMs,
      stat: options.stat,
    }),
    messages,
  };
}

function extractProjectPathFromJson(value: unknown): string {
  const parsed = parseJsonText(value);
  if (!isRecord(parsed)) return "";
  return firstStringField(parsed, ["cwd", "directory", "projectPath", "project_path", "workdir", "workspacePath", "workspace_path"]);
}

function createSourceTokenUsage(inputTokens: number, outputTokens: number, cachedInputTokens: number, reasoningOutputTokens: number): TokenUsage {
  return createTokenUsage(
    Math.max(0, inputTokens),
    Math.max(0, outputTokens),
    Math.max(0, cachedInputTokens),
    Math.max(0, reasoningOutputTokens),
  );
}

export function loadHermesSessions(hermesDir = path.join(os.homedir(), ".hermes")): LoadedSession[] {
  const dbPath = path.join(hermesDir, "state.db");
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteTableExists(db, "sessions") || !sqliteTableExists(db, "messages")) return [];
    if (!sqliteHasColumns(db, "sessions", ["id", "started_at"]) || !sqliteHasColumns(db, "messages", ["id", "session_id", "timestamp"])) {
      return [];
    }
    const sessions = db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all() as Array<Record<string, unknown>>;
    return sessions.map((session) => loadHermesSessionRow(db, dbPath, session)).filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function loadHermesSessionRow(db: import("node:sqlite").DatabaseSync, dbPath: string, session: Record<string, unknown>): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp, id").all(rawId) as Array<Record<string, unknown>>;
  const messages: SessionMessage[] = [];
  const traceDrafts: TraceEventDraft[] = [];
  for (const row of rows) {
    const role = roleFromValue(row);
    const content = stringField(row, "content");
    const ts = timestampString(unknownField(row, "timestamp"));
    if (role && content && isMeaningfulUserMessage(content)) messages.push(messageFromParts(role, content, ts, messages.length));
    const toolName = stringField(row, "tool_name");
    const toolCalls = stringField(row, "tool_calls");
    if (toolName || toolCalls) {
      traceDrafts.push({
        kind: "tool_call",
        source: "hermes",
        title: toolName || "tool_call",
        detail: stringifyDetail(parseJsonText(toolCalls || toolName)),
        timestamp: ts,
        callId: stringField(row, "tool_call_id") || null,
        eventType: null,
        status: "unknown",
      });
    }
  }
  const usage = createSourceTokenUsage(
    numberField(session, "input_tokens"),
    numberField(session, "output_tokens"),
    numberField(session, "cache_read_tokens") + numberField(session, "cached_input_tokens"),
    numberField(session, "reasoning_tokens") + numberField(session, "reasoning_output_tokens"),
  );
  const question = firstQuestion(messages);
  const stat = safeStat(dbPath);
  const title = stringField(session, "title");
  return {
    session: createIndexedSession({
      keyPrefix: "hermes",
      rawId,
      source: "hermes",
      projectPath: extractProjectPathFromJson(unknownField(session, "model_config")),
      filePath: dbPath,
      originalTitle: title || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "started_at")) || stat.mtimeMs,
      tokenUsage: usage,
      stat,
    }),
    messages,
    traceEvents: dedupeTraceEvents(traceDrafts),
  };
}

function resolveOpenCodeDbPath(root: string, shareDir = "opencode"): string {
  const direct = path.join(root, "opencode.db");
  if (fs.existsSync(direct)) return direct;
  return path.join(root, ".local", "share", shareDir, "opencode.db");
}

export function loadOpenCodeSessions(opencodeRoot = path.join(os.homedir(), ".local", "share", "opencode")): LoadedSession[] {
  return loadOpenCodeLikeSessions(opencodeRoot, {
    keyPrefix: "opencode",
    source: "opencode-cli",
    traceSource: "opencode",
  });
}

export function loadCodeWizSessions(codeWizRoot = path.join(os.homedir(), CODEWIZ_SHARE_DIR)): LoadedSession[] {
  return loadOpenCodeLikeSessions(codeWizRoot, {
    keyPrefix: "codewiz",
    source: "codewiz-cli",
    traceSource: "codewiz",
  });
}

function loadOpenCodeLikeSessions(
  opencodeRoot: string,
  sourceOptions: { keyPrefix: "opencode" | "codewiz"; source: "opencode-cli" | "codewiz-cli"; traceSource: "opencode" | "codewiz" },
): LoadedSession[] {
  const dbPath = resolveOpenCodeDbPath(opencodeRoot, sourceOptions.keyPrefix);
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteTableExists(db, "session")) return [];
    if (!sqliteHasColumns(db, "session", ["id", "time_created"])) return [];
    if (sqliteTableExists(db, "message") && !sqliteHasColumns(db, "message", ["id", "session_id", "data"])) return [];
    const sessions = db.prepare("SELECT * FROM session ORDER BY time_created DESC").all() as Array<Record<string, unknown>>;
    return sessions.map((session) => loadOpenCodeSessionRow(db, dbPath, session, sourceOptions)).filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function opencodeMessagesFromParts(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
  traceSource: "opencode" | "codewiz" = "opencode",
): { messages: SessionMessage[]; traceEvents: SessionTraceEvent[]; tokenEvents: TokenUsageEvent[] } {
  if (!sqliteTableExists(db, "message")) return { messages: [], traceEvents: [], tokenEvents: [] };
  const messageColumns = sqliteColumns(db, "message");
  const partColumns = sqliteColumns(db, "part");
  const hasPart = sqliteTableExists(db, "part") && partColumns.has("data");
  const messageTypeSelect = messageColumns.has("type") ? "message.type" : "'' AS type";
  const rows = hasPart
    ? (db
        .prepare(
          `
          SELECT message.id, ${messageTypeSelect}, message.time_created, message.data AS message_data,
            part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
          FROM message
          LEFT JOIN part ON part.message_id = message.id
          WHERE message.session_id = ?
          ORDER BY message.time_created, part.time_created, part.id
        `,
        )
        .all(rawId) as Array<Record<string, unknown>>)
    : (db
        .prepare(
          `
          SELECT id, type, ${messageColumns.has("time_created") ? "time_created" : "0 AS time_created"}, data AS message_data
          FROM message
          WHERE session_id = ?
          ORDER BY time_created, id
        `,
        )
        .all(rawId) as Array<Record<string, unknown>>);

  const messages: SessionMessage[] = [];
  const traceDrafts: TraceEventDraft[] = [];
  const tokenEntries = new Map<string, TokenUsageEvent>();
  for (const row of rows) {
    const messageData = parseJsonText(unknownField(row, "message_data"));
    const partData = parseJsonText(unknownField(row, "part_data"));
    const ts = timestampString(unknownField(row, "part_time_created") || unknownField(row, "time_created"));
    const tokenSource = tokenDataFromOpenCodeRecord(partData) || tokenDataFromOpenCodeRecord(messageData);
    if (tokenSource) {
      const rawKey = stringField(row, "id") || stringField(row, "part_id") || `${rawId}:${tokenEntries.size}`;
      const key = `${traceSource}:${rawKey}`;
      putTokenEvent(tokenEntries, tokenEvent(timestampMs(unknownField(row, "part_time_created") || unknownField(row, "time_created")), key, tokenSource.input, tokenSource.output, tokenSource.cached, tokenSource.reasoning));
    }
    const role = (isRecord(messageData) && roleFromValue(messageData)) || roleFromValue(row);
    const content = extractText(partData) || (isRecord(messageData) ? extractText(messageData) : "");
    if (role && content && isMeaningfulUserMessage(content)) {
      messages.push(messageFromParts(role, content, ts, messages.length));
      continue;
    }
    if (content || isRecord(partData)) {
      const name = isRecord(partData) ? firstStringField(partData, ["tool", "toolName", "name", "type"]) : stringField(row, "type");
      traceDrafts.push({
        kind: "event",
        source: traceSource,
        title: normalizeTraceTitle(name || "part", firstStringField(partData, ["command", "path", "file_path", "query"])),
        detail: stringifyDetail(partData || messageData),
        timestamp: ts,
        callId: stringField(row, "part_id") || stringField(row, "id") || null,
        eventType: stringField(row, "type") || null,
        status: "unknown",
      });
    }
  }
  return { messages, traceEvents: dedupeTraceEvents(traceDrafts), tokenEvents: Array.from(tokenEntries.values()) };
}

function tokenDataFromOpenCodeRecord(value: unknown): { input: number; output: number; cached: number; reasoning: number } | null {
  if (!isRecord(value)) return null;
  const tokens = unknownField(value, "tokens");
  if (!isRecord(tokens)) return null;
  const cache = unknownField(tokens, "cache");
  const cached = isRecord(cache) ? numberField(cache, "read") + numberField(cache, "write") : numberField(tokens, "cached") + numberField(tokens, "cache_read") + numberField(tokens, "cache_write");
  const input = numberField(tokens, "input");
  const output = numberField(tokens, "output");
  const reasoning = numberField(tokens, "reasoning");
  if (input <= 0 && output <= 0 && cached <= 0 && reasoning <= 0) return null;
  return { input, output, cached, reasoning };
}

function loadOpenCodeSessionRow(
  db: import("node:sqlite").DatabaseSync,
  dbPath: string,
  session: Record<string, unknown>,
  sourceOptions: { keyPrefix: "opencode" | "codewiz"; source: "opencode-cli" | "codewiz-cli"; traceSource: "opencode" | "codewiz" } = {
    keyPrefix: "opencode",
    source: "opencode-cli",
    traceSource: "opencode",
  },
): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const { messages, traceEvents, tokenEvents } = opencodeMessagesFromParts(db, rawId, sourceOptions.traceSource);
  const question = firstQuestion(messages);
  const stat = safeStat(dbPath);
  const usage = tokenEvents.length
    ? tokenUsageFromEvents(tokenEvents)
    : createSourceTokenUsage(
        numberField(session, "tokens_input"),
        numberField(session, "tokens_output"),
        numberField(session, "tokens_cache_read") + numberField(session, "tokens_cache_write"),
        numberField(session, "tokens_reasoning"),
      );
  return {
    session: createIndexedSession({
      keyPrefix: sourceOptions.keyPrefix,
      rawId,
      source: sourceOptions.source,
      projectPath: stringField(session, "directory") || stringField(session, "path"),
      filePath: dbPath,
      originalTitle: stringField(session, "title") || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "time_updated")) || timestampMs(unknownField(session, "time_created")) || stat.mtimeMs,
      tokenUsage: usage,
      stat,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

function zcodeDatabaseStat(dbPath: string): VirtualSessionFileStat {
  const database = safeStat(dbPath);
  const wal = safeStat(`${dbPath}-wal`);
  return {
    mtimeMs: Math.max(database.mtimeMs, wal.mtimeMs),
    size: database.size + wal.size,
  };
}

function zcodeToolStatus(value: string): "success" | "failure" | "unknown" {
  if (value === "completed") return "success";
  if (value === "error") return "failure";
  return "unknown";
}

function zcodeMessagesFromParts(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
): { messages: SessionMessage[]; traceEvents: SessionTraceEvent[]; assistantMessageIds: Set<string> } {
  const rows = db
    .prepare(
      `
        SELECT message.id AS message_id, message.time_created AS message_time_created, message.data AS message_data,
          part.id AS part_id, part.time_created AS part_time_created, part.data AS part_data
        FROM message
        LEFT JOIN part ON part.message_id = message.id
        WHERE message.session_id = ?
        ORDER BY message.time_created, message.id, part.time_created, part.id
      `,
    )
    .all(rawId) as Array<Record<string, unknown>>;

  const drafts = new Map<string, { role: "user" | "assistant"; timestamp: string; text: string[] }>();
  const assistantMessageIds = new Set<string>();
  const traceDrafts: TraceEventDraft[] = [];
  for (const row of rows) {
    const messageId = stringField(row, "message_id");
    const messageData = parseJsonText(unknownField(row, "message_data"));
    const role = roleFromValue(messageData);
    if (!messageId || !role) continue;
    if (role === "assistant") assistantMessageIds.add(messageId);

    let draft = drafts.get(messageId);
    if (!draft) {
      draft = {
        role,
        timestamp: timestampString(unknownField(row, "message_time_created")),
        text: [],
      };
      drafts.set(messageId, draft);
    }

    const partData = parseJsonText(unknownField(row, "part_data"));
    if (!isRecord(partData)) continue;
    const partType = stringField(partData, "type");
    if (partType === "text") {
      const text = stringField(partData, "text").trim();
      if (text) draft.text.push(text);
      continue;
    }
    if (partType !== "tool") continue;

    const state = objectField(partData, "state");
    const input = state ? unknownField(state, "input") : undefined;
    const output = state ? unknownField(state, "output") : undefined;
    const time = state ? objectField(state, "time") : null;
    const toolName = stringField(partData, "tool") || "tool";
    const summary = firstStringField(input, ["command", "path", "file_path", "query", "url", "description"]);
    traceDrafts.push({
      kind: "tool_call",
      source: "zcode",
      title: normalizeTraceTitle(toolName, summary),
      detail: stringifyDetail({ input, output }),
      timestamp: timestampString(unknownField(time, "start") || unknownField(row, "part_time_created")),
      callId: stringField(partData, "callID") || null,
      eventType: "tool",
      status: zcodeToolStatus(stringField(state, "status")),
    });
  }

  const messages: SessionMessage[] = [];
  for (const draft of drafts.values()) {
    const content = draft.text.join("\n");
    if (!content || (draft.role === "user" && !isMeaningfulUserMessage(content))) continue;
    messages.push(messageFromParts(draft.role, content, draft.timestamp, messages.length));
  }
  return { messages, traceEvents: dedupeTraceEvents(traceDrafts), assistantMessageIds };
}

function zcodeTokenEventsFromModelUsage(
  db: import("node:sqlite").DatabaseSync,
  rawId: string,
  assistantMessageIds: ReadonlySet<string>,
): TokenUsageEvent[] {
  if (!sqliteTableExists(db, "model_usage")) return [];
  if (
    !sqliteHasColumns(db, "model_usage", [
      "id",
      "session_id",
      "assistant_message_id",
      "query_source",
      "status",
      "started_at",
      "completed_at",
      "input_tokens",
      "output_tokens",
      "reasoning_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ])
  ) {
    return [];
  }

  try {
    const rows = db
      .prepare(
        `
          SELECT id, assistant_message_id, started_at, completed_at, input_tokens, output_tokens,
            reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens
          FROM model_usage
          WHERE session_id = ? AND status = 'completed' AND query_source <> 'session_title'
          ORDER BY COALESCE(completed_at, started_at), started_at, id
        `,
      )
      .all(rawId) as Array<Record<string, unknown>>;
    const events: TokenUsageEvent[] = [];
    for (const row of rows) {
      const id = stringField(row, "id");
      const assistantMessageId = stringField(row, "assistant_message_id");
      if (!id || !assistantMessageIds.has(assistantMessageId)) continue;
      const cached = Math.max(0, numberField(row, "cache_read_input_tokens")) + Math.max(0, numberField(row, "cache_creation_input_tokens"));
      const freshInput = Math.max(0, numberField(row, "input_tokens") - cached);
      events.push(
        tokenEvent(
          timestampMs(unknownField(row, "completed_at")) || timestampMs(unknownField(row, "started_at")),
          id,
          freshInput,
          Math.max(0, numberField(row, "output_tokens")),
          cached,
          Math.max(0, numberField(row, "reasoning_tokens")),
        ),
      );
    }
    return events;
  } catch {
    return [];
  }
}

function loadZcodeSessionRow(
  db: import("node:sqlite").DatabaseSync,
  dbPath: string,
  stat: VirtualSessionFileStat,
  session: Record<string, unknown>,
): LoadedSession | null {
  const rawId = stringField(session, "id");
  if (!rawId) return null;
  const { messages, traceEvents, assistantMessageIds } = zcodeMessagesFromParts(db, rawId);
  const tokenEvents = zcodeTokenEventsFromModelUsage(db, rawId, assistantMessageIds);
  const question = firstQuestion(messages);
  const parentSessionId = stringField(session, "parent_id") || null;
  return {
    session: createIndexedSession({
      keyPrefix: "zcode",
      rawId,
      source: "zcode-cli",
      projectPath: stringField(session, "directory"),
      filePath: dbPath,
      originalTitle: stringField(session, "title") || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "time_updated")) || timestampMs(unknownField(session, "time_created")) || stat.mtimeMs,
      tokenUsage: tokenUsageFromEvents(tokenEvents),
      stat,
      isSubagent: parentSessionId !== null,
      parentSessionId,
    }),
    messages,
    tokenEvents,
    traceEvents,
  };
}

export function loadZcodeSessions(zcodeDir = path.join(os.homedir(), ".zcode")): LoadedSession[] {
  const dbPath = path.join(zcodeDir, "cli", "db", "db.sqlite");
  const db = readOnlyDatabase(dbPath);
  if (!db) return [];
  try {
    if (!sqliteHasColumns(db, "session", ["id", "title", "directory", "time_created", "time_updated", "parent_id"])) return [];
    if (!sqliteHasColumns(db, "message", ["id", "session_id", "time_created", "data"])) return [];
    if (!sqliteHasColumns(db, "part", ["id", "message_id", "session_id", "time_created", "data"])) return [];
    const stat = zcodeDatabaseStat(dbPath);
    const sessions = db.prepare("SELECT * FROM session ORDER BY time_updated DESC, time_created DESC, id").all() as Array<Record<string, unknown>>;
    return sessions
      .map((session) => {
        try {
          return loadZcodeSessionRow(db, dbPath, stat, session);
        } catch {
          return null;
        }
      })
      .filter((item): item is LoadedSession => Boolean(item));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function traceEventsFromCursorRows(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];
  for (const row of rows) {
    if (!isRecord(row) || stringField(row, "role") !== "assistant") continue;
    const message = objectField(row, "message");
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const timestamp = cursorTimestampFromRow(row);
    for (const block of content) {
      if (!isRecord(block) || stringField(block, "type") !== "tool_use") continue;
      const name = stringField(block, "name") || "tool";
      const input = unknownField(block, "input");
      const parsedInput = parseMaybeJson(input);
      const summary =
        firstStringField(parsedInput, ["path", "command", "query", "url", "pattern", "glob_pattern", "description", "search_term"]) ||
        firstStringField(block, ["path", "command", "query", "url"]);
      events.push({
        kind: "tool_call",
        source: "cursor",
        title: normalizeTraceTitle(name, summary),
        detail: stringifyDetail(parsedInput),
        timestamp,
        callId: stringField(block, "id") || null,
        eventType: "tool_use",
        status: "unknown",
      });
    }
  }
  return dedupeTraceEvents(events);
}

function cursorWorkspaceStateDbPath(cursorDir: string, override?: string): string {
  if (override) return override;
  const homeDir = path.basename(cursorDir) === ".cursor" ? path.dirname(cursorDir) : cursorDir;
  if (process.platform === "win32") {
    return path.join(homeDir, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(homeDir, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorDatabaseStat(stateDbPath: string): VirtualSessionFileStat {
  const databaseStat = safeStat(stateDbPath);
  const walStat = safeStat(`${stateDbPath}-wal`);
  return {
    mtimeMs: Math.max(databaseStat.mtimeMs, walStat.mtimeMs),
    size: databaseStat.size + walStat.size,
  };
}

function folderPathFromWorkspaceMetadataEntry(entry: Record<string, unknown>): string {
  const folderUri = stringField(entry, "folderUri");
  if (folderUri.startsWith("file://")) return decodeURIComponent(folderUri.replace(/^file:\/\//, ""));

  const paths = entry.paths;
  if (Array.isArray(paths) && isRecord(paths[0])) {
    const uri = objectField(paths[0], "uri");
    const fsPath = uri ? stringField(uri, "fsPath") : "";
    if (fsPath) return fsPath;
  }

  return "";
}

export function loadCursorWorkspacePathMap(
  cursorDir = path.join(os.homedir(), ".cursor"),
  stateDbPath = cursorWorkspaceStateDbPath(cursorDir),
): Map<string, string> {
  const map = new Map<string, string>();

  try {
    if (fs.existsSync(stateDbPath)) {
      const db = new DatabaseSync(stateDbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("workspaceMetadata.entries") as { value?: string } | undefined;
        if (row?.value) {
          const parsed = JSON.parse(row.value) as { entries?: unknown[] };
          for (const entry of parsed.entries ?? []) {
            if (!isRecord(entry)) continue;
            const folderPath = folderPathFromWorkspaceMetadataEntry(entry);
            if (folderPath) map.set(encodeCursorWorkspaceSlug(folderPath), folderPath);
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // Ignore metadata lookup failures and fall back to slug heuristics.
  }

  const projectsDir = path.join(cursorDir, "projects");
  if (fs.existsSync(projectsDir)) {
    for (const slug of fs.readdirSync(projectsDir)) {
      if (!slug || slug === "empty-window" || map.has(slug)) continue;
      const decoded = decodeCursorWorkspaceSlugHeuristic(slug);
      if (decoded && fs.existsSync(decoded)) map.set(slug, decoded);
    }
  }

  return map;
}

function decodeCursorWorkspaceSlugHeuristic(slug: string): string {
  if (!slug || slug === "empty-window") return "";
  const parts = slug.split("-");
  if (parts[0] === "Users" && parts.length >= 2) {
    return `/${parts.join("/")}`;
  }
  if (parts[0] === "C" && parts[1] === "Users" && parts.length >= 3) {
    return `${parts[0]}:/${parts.slice(1).join("/")}`;
  }
  return slug;
}

export function decodeCursorWorkspaceSlug(slug: string, pathMap?: ReadonlyMap<string, string>): string {
  if (!slug || slug === "empty-window") return "";
  return pathMap?.get(slug) || decodeCursorWorkspaceSlugHeuristic(slug);
}

export function encodeCursorWorkspaceSlug(projectPath: string): string {
  const trimmed = projectPath.trim();
  if (!trimmed) return "empty-window";
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const slashEncoded = /^[A-Za-z]:\//.test(normalized)
    ? normalized.replace(/^[A-Za-z]:\//, (match) => `${match[0]}-`).replace(/\//g, "-")
    : normalized.replace(/^\/+/, "").replace(/\//g, "-");
  const sanitized = slashEncoded.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized || "empty-window";
}

function cursorTranscriptSessionIdFromPath(filePath: string): string {
  const baseName = path.basename(filePath);
  const match = baseName.match(/^(.+?)\.jsonl(?:\.tmp-.+)?$/i);
  return match ? match[1] : baseName.replace(/\.jsonl$/i, "");
}

export function parseCursorTranscriptPath(filePath: string): {
  workspaceSlug: string;
  sessionId: string;
  isSubagent: boolean;
  parentSessionId: string | null;
} {
  const projectsMarker = `${path.sep}projects${path.sep}`;
  const afterProjects = filePath.includes(projectsMarker) ? filePath.split(projectsMarker)[1] || "" : "";
  const workspaceSlug = afterProjects.split(path.sep)[0] || "";
  const sessionId = cursorTranscriptSessionIdFromPath(filePath);
  const parts = filePath.split(path.sep);
  const transcriptsIndex = parts.lastIndexOf("agent-transcripts");
  const subagentsIndex = parts.lastIndexOf("subagents");
  const isSubagent = subagentsIndex >= 0 && transcriptsIndex >= 0 && subagentsIndex > transcriptsIndex;
  const parentSessionId = isSubagent && subagentsIndex > 0 ? parts[subagentsIndex - 1] || null : null;
  return { workspaceSlug, sessionId, isSubagent, parentSessionId };
}

function cursorTimestampMsFromRows(rows: unknown[]): number {
  for (const row of rows) {
    const timestamp = cursorTimestampFromRow(row);
    const parsed = timestampMs(timestamp);
    if (parsed) return parsed;
  }
  return 0;
}

interface CursorComposerMetadata {
  composerId: string;
  title: string;
  projectPath: string;
  createdAt: number;
  isDraft: boolean;
  isSubagent: boolean;
  parentSessionId: string | null;
  messages: SessionMessage[];
}

function loadCursorComposerMetadata(stateDbPath: string): Map<string, CursorComposerMetadata> {
  const metadata = new Map<string, CursorComposerMetadata>();
  const db = readOnlyDatabase(stateDbPath);
  if (!db) return metadata;

  try {
    if (!sqliteHasColumns(db, "composerHeaders", ["composerId", "createdAt", "isSubagent", "value"])) return metadata;

    const messageDrafts = new Map<
      string,
      Array<{ key: string; role: "user" | "assistant"; content: string; timestamp: string }>
    >();
    if (sqliteHasColumns(db, "cursorDiskKV", ["key", "value"])) {
      const bubbleRows = db
        .prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'")
        .all() as Array<{ key?: string; value?: string }>;
      for (const row of bubbleRows) {
        const key = row.key || "";
        const separator = key.indexOf(":", "bubbleId:".length);
        if (separator < 0) continue;
        const composerId = key.slice("bubbleId:".length, separator);
        const bubble = parseJsonText(row.value);
        if (!composerId || !isRecord(bubble)) continue;
        const type = numberField(bubble, "type");
        const role = type === 1 ? "user" : type === 2 ? "assistant" : null;
        if (!role) continue;
        const plainText = stringField(bubble, "text").trim();
        const content = plainText || extractText(parseJsonText(stringField(bubble, "richText"))).trim();
        if (!content || (role === "user" && !isMeaningfulUserMessage(content))) continue;
        const drafts = messageDrafts.get(composerId) ?? [];
        drafts.push({
          key,
          role,
          content,
          timestamp: timestampString(unknownField(bubble, "createdAt")),
        });
        messageDrafts.set(composerId, drafts);
      }
    }

    const headerRows = db.prepare("SELECT composerId, createdAt, isSubagent, value FROM composerHeaders").all() as Array<
      Record<string, unknown>
    >;
    for (const row of headerRows) {
      const composerId = stringField(row, "composerId");
      const header = parseJsonText(unknownField(row, "value"));
      if (!composerId || !isRecord(header)) continue;

      const workspaceIdentifier = objectField(header, "workspaceIdentifier");
      const workspaceUri = objectField(workspaceIdentifier, "uri");
      const agentLocation = objectField(header, "agentLocation");
      const agentEnvironment = objectField(agentLocation, "environment");
      const agentUri = objectField(agentEnvironment, "uri");
      const draftTarget = objectField(header, "draftTarget");
      const draftEnvironment = objectField(draftTarget, "environment");
      const draftUri = objectField(draftEnvironment, "uri");
      const subagentInfo = objectField(header, "subagentInfo");
      const drafts = messageDrafts.get(composerId) ?? [];
      drafts.sort((left, right) => {
        const timestampDelta = timestampMs(left.timestamp) - timestampMs(right.timestamp);
        return timestampDelta || left.key.localeCompare(right.key);
      });

      metadata.set(composerId, {
        composerId,
        title: cleanTitle(stringField(header, "name")),
        projectPath:
          firstStringField(workspaceUri, ["fsPath", "path"]) ||
          firstStringField(agentUri, ["fsPath", "path"]) ||
          firstStringField(draftUri, ["fsPath", "path"]),
        createdAt: numberField(row, "createdAt") || numberField(header, "createdAt"),
        isDraft: unknownField(header, "isDraft") === true,
        isSubagent: numberField(row, "isSubagent") === 1 || Boolean(subagentInfo),
        parentSessionId: stringField(subagentInfo, "parentComposerId") || null,
        messages: drafts.map((draft, index) => messageFromParts(draft.role, draft.content, draft.timestamp, index)),
      });
    }
  } catch {
    return new Map();
  } finally {
    db.close();
  }

  return metadata;
}

export function loadCursorTranscriptFile(
  filePath: string,
  stat = safeStat(filePath),
  workspacePathMap?: ReadonlyMap<string, string>,
): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const { workspaceSlug, sessionId, isSubagent, parentSessionId } = parseCursorTranscriptPath(filePath);
  const rawId = sessionId;
  const messages = sourceMessages(rows, "cursor");
  const traceEvents = traceEventsFromCursorRows(rows);
  const question = firstQuestion(messages);
  const projectPath =
    rows.map((row) => (isRecord(row) ? firstStringField(row, ["cwd", "projectPath", "project_path", "workspacePath", "workspace_path"]) : "")).find(Boolean) ||
    decodeCursorWorkspaceSlug(workspaceSlug, workspacePathMap);
  const firstTs = cursorTimestampMsFromRows(rows) || stat.mtimeMs;
  const session = createIndexedSession({
    keyPrefix: "cursor",
    rawId,
    source: "cursor-agent",
    projectPath,
    filePath,
    originalTitle: cleanTitle(question) || rawId,
    firstQuestion: cleanTitle(question),
    timestamp: firstTs,
    stat,
    isSubagent,
    parentSessionId,
  });

  return {
    session: {
      ...session,
      sessionKey: workspaceSlug ? `cursor:${workspaceSlug}:${rawId}` : session.sessionKey,
    },
    messages,
    traceEvents,
  };
}

export function loadCursorAgentSessions(cursorDir = path.join(os.homedir(), ".cursor"), options: SessionLoadOptions = {}): LoadedSession[] {
  return [...loadCursorAgentSessionsIterator(cursorDir, options)];
}

export function* loadCursorAgentSessionsIterator(cursorDir = path.join(os.homedir(), ".cursor"), options: SessionLoadOptions = {}): Generator<LoadedSession> {
  const projectsDir = path.join(cursorDir, "projects");
  const stateDbPath = cursorWorkspaceStateDbPath(cursorDir, options.cursorStateDbPath);
  const stateDbStat = cursorDatabaseStat(stateDbPath);
  const composerMetadata = loadCursorComposerMetadata(stateDbPath);
  const workspacePathMap = options.cursorWorkspacePathMap ?? loadCursorWorkspacePathMap(cursorDir, stateDbPath);
  const transcriptSessionIds = new Set<string>();

  if (fs.existsSync(projectsDir)) {
    for (const filePath of walkJsonlFiles(projectsDir)) {
      if (!filePath.includes(`${path.sep}agent-transcripts${path.sep}`)) continue;
      const transcriptPath = parseCursorTranscriptPath(filePath);
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat, stateDbStat.mtimeMs)) {
        transcriptSessionIds.add(transcriptPath.sessionId);
        continue;
      }
      const loaded = loadCursorTranscriptFile(filePath, stat, workspacePathMap);
      if (!loaded) continue;
      transcriptSessionIds.add(transcriptPath.sessionId);
      const header = composerMetadata.get(transcriptPath.sessionId);
      if (header) {
        loaded.session = {
          ...loaded.session,
          projectPath: header.projectPath || loaded.session.projectPath,
          originalTitle: header.title || loaded.session.originalTitle,
          timestamp: header.createdAt || loaded.session.timestamp,
          isSubagent: header.isSubagent || loaded.session.isSubagent,
          parentSessionId: header.parentSessionId || loaded.session.parentSessionId,
        };
      }
      yield loaded;
    }
  }

  for (const header of composerMetadata.values()) {
    if (transcriptSessionIds.has(header.composerId)) continue;
    const question = cleanTitle(firstQuestion(header.messages));
    if (header.isDraft && !header.title && !question) continue;
    const workspaceSlug = encodeCursorWorkspaceSlug(header.projectPath);
    const session = createIndexedSession({
      keyPrefix: "cursor",
      rawId: header.composerId,
      source: "cursor-agent",
      projectPath: header.projectPath,
      filePath: stateDbPath,
      originalTitle: header.title || question || header.composerId,
      firstQuestion: question,
      timestamp: header.createdAt,
      stat: stateDbStat,
      isSubagent: header.isSubagent,
      parentSessionId: header.parentSessionId,
    });
    yield {
      session: {
        ...session,
        sessionKey: `cursor:${workspaceSlug}:${header.composerId}`,
      },
      messages: header.messages,
    };
  }
}
