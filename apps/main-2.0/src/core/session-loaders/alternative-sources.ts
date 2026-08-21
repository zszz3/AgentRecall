import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  cleanTitle,
  cursorTimestampFromRow,
  extractCursorUserQuery,
  isMeaningfulUserMessage,
} from "../format-adapters";
import {
  DEEPSEEK_HARNESS_DIR,
  DEEPSEEK_HARNESS_LOG_NAME,
  parseDeepSeekSessionLog,
  projectDeepSeekSession,
} from "../deepseek-harness";
import type {
  LoadedSession,
  SessionFormat,
  SessionMessage,
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
export const PI_SESSIONS_DIR = path.join(".pi", "agent", "sessions");
export const QODER_DIR = ".qoder";
export const TRAE_DIR_NAMES = [".trae", ".trae-cn"] as const;
export const KIMI_CODE_DIR = ".kimi-code";
export const KIMI_LEGACY_DIR = ".kimi";

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

function parseValidPiTimestampMs(value: unknown): number | null {
  const timestamp = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string"
      ? new Date(value).getTime()
      : Number.NaN;
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null;
}

function piActiveRows(rows: unknown[]): unknown[] | null {
  const header = rows[0];
  if (!isRecord(header) || header.type !== "session" || !stringField(header, "id").trim()) return null;
  const rawVersion = unknownField(header, "version");
  const version = rawVersion === undefined || rawVersion === null ? 1 : rawVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 3) return null;
  if (version < 2) return rows.slice(1);

  const nodes = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  for (const row of rows.slice(1)) {
    if (!isRecord(row)) continue;
    const id = stringField(row, "id");
    if (!id) continue;
    if (nodes.has(id)) return null;
    nodes.set(id, row);
    current = row;
  }
  if (!current) return null;

  const activeRows: unknown[] = [];
  const visited = new Set<string>();
  while (current) {
    const id = stringField(current, "id");
    if (!id || visited.has(id)) return null;
    visited.add(id);
    activeRows.push(current);

    const parentId = unknownField(current, "parentId");
    if (parentId === null) break;
    if (typeof parentId !== "string" || !parentId) return null;
    const parent = nodes.get(parentId);
    if (!parent) return null;
    current = parent;
  }

  return activeRows.reverse();
}

function piTokenEvents(rows: unknown[]): TokenUsageEvent[] {
  const events: TokenUsageEvent[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row) || row.type !== "message") return;
    const message = objectField(row, "message");
    if (stringField(message, "role") !== "assistant") return;
    const usage = objectField(message, "usage");
    if (!usage) return;
    const innerTimestamp = parseValidPiTimestampMs(unknownField(message, "timestamp"));

    const tokenUsage = createTokenUsage(
      numberField(usage, "input"),
      Math.max(0, numberField(usage, "output") - numberField(usage, "reasoning")),
      numberField(usage, "cacheRead") + numberField(usage, "cacheWrite"),
      numberField(usage, "reasoning"),
    );
    events.push({
      ...tokenUsage,
      timestamp: innerTimestamp ?? parseValidPiTimestampMs(row.timestamp) ?? 0,
      dedupeKey: `pi:${stringField(row, "id") || index}`,
    });
  });
  return events;
}

function piTraceEvents(rows: unknown[]): SessionTraceEvent[] {
  const events: TraceEventDraft[] = [];

  for (const row of rows) {
    if (!isRecord(row) || row.type !== "message") continue;
    const message = objectField(row, "message");
    const role = stringField(message, "role");
    const innerTimestamp = parseValidPiTimestampMs(unknownField(message, "timestamp"));
    const timestamp = innerTimestamp !== null
      ? new Date(innerTimestamp).toISOString()
      : stringField(row, "timestamp");
    if (role === "assistant") {
      const content = unknownField(message, "content");
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        const args = unknownField(block, "arguments");
        const name = stringField(block, "name") || "tool";
        events.push({
          kind: "tool_call",
          source: "pi",
          title: titleWithSummary(name, firstStringField(args, ["command", "cmd", "file_path", "path", "query", "url"])),
          detail: stringifyDetail(args),
          timestamp,
          callId: stringField(block, "id") || null,
          eventType: null,
          status: "unknown",
        });
      }
      continue;
    }

    if (role !== "toolResult") continue;
    const isError = unknownField(message, "isError");
    events.push({
      kind: "tool_result",
      source: "pi",
      title: titleWithSummary(stringField(message, "toolName") || "tool", "result"),
      detail: stringifyDetail(unknownField(message, "content")),
      timestamp,
      callId: stringField(message, "toolCallId") || null,
      eventType: null,
      status: typeof isError === "boolean" ? (isError ? "failed" : "completed") : "unknown",
    });
  }

  return events.map((event, index) => ({ ...event, index }));
}

function loadPiSessionFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath);
  const header = rows[0];
  if (!isRecord(header)) return null;
  const rawId = stringField(header, "id").trim();
  const projectPath = stringField(header, "cwd").trim();
  const timestamp = parseValidPiTimestampMs(header.timestamp);
  if (!rawId || !projectPath || timestamp === null) return null;
  const activeRows = piActiveRows(rows);
  if (!activeRows) return null;

  const messages = extractMessages(activeRows, "pi");
  if (messages.length === 0) return null;
  let question = "";
  for (const row of activeRows) {
    if (!isRecord(row) || row.type !== "message") continue;
    const message = objectField(row, "message");
    if (stringField(message, "role") !== "user") continue;
    const content = unknownField(message, "content");
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((block) => isRecord(block) && block.type === "text")
          .map((block) => stringField(block, "text"))
          .filter(Boolean)
          .join("\n")
        : "";
    if (!isMeaningfulUserMessage(text)) continue;
    question = cleanTitle(text);
    break;
  }
  let latestName = "";
  for (const row of rows) {
    if (isRecord(row) && row.type === "session_info") latestName = stringField(row, "name").trim();
  }
  const tokenEvents = piTokenEvents(rows);
  const traceEvents = piTraceEvents(activeRows);
  const session = createIndexedSession({
    keyPrefix: "pi",
    rawId,
    source: "pi-cli",
    projectPath,
    filePath,
    originalTitle: latestName || question,
    firstQuestion: question,
    timestamp,
    tokenUsage: tokenUsageFromEvents(tokenEvents),
    stat,
  });
  return { session, messages, tokenEvents, traceEvents };
}

export function* loadPiSessionsIterator(
  piSessionsDir: string,
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  for (const filePath of walkJsonlFiles(piSessionsDir)) {
    const stat = safeStat(filePath);
    if (shouldSkipFile(options, filePath, stat)) continue;
    const loaded = loadPiSessionFile(filePath, stat);
    if (loaded) yield loaded;
  }
}

function loadKimiProjectPaths(root: string): { dependencyMtimeMs: number; paths: Map<string, string> } {
  const metadataPath = path.join(root, "kimi.json");
  const metadataStat = safeStat(metadataPath);
  const paths = new Map<string, string>();
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as unknown;
    if (!isRecord(metadata) || !Array.isArray(metadata.work_dirs)) return { dependencyMtimeMs: metadataStat.mtimeMs, paths };
    for (const item of metadata.work_dirs) {
      if (!isRecord(item)) continue;
      const projectPath = stringField(item, "path");
      if (!projectPath) continue;
      paths.set(createHash("md5").update(projectPath, "utf8").digest("hex"), projectPath);
    }
  } catch {
    // Missing or malformed metadata should not prevent session discovery.
  }
  return { dependencyMtimeMs: metadataStat.mtimeMs, paths };
}

function legacyKimiSessionRawId(filePath: string, root: string): string {
  const relativeParts = path.relative(root, filePath).split(/[\\/]+/u);
  const sessionsIndex = relativeParts.indexOf("sessions");
  const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
  const fileName = path.basename(filePath).toLowerCase();
  if (/^(?:context|wire)\.jsonl$/u.test(fileName)) return sessionParts.slice(0, -1).filter(Boolean).join("/");
  return [...sessionParts.slice(0, -1), path.basename(filePath, ".jsonl")].filter(Boolean).join("/");
}

function legacyKimiSessionId(filePath: string): string {
  return /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath))
    ? path.basename(path.dirname(filePath))
    : path.basename(filePath, ".jsonl");
}

function legacyKimiStatePath(filePath: string): string | null {
  return /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath))
    ? path.join(path.dirname(filePath), "state.json")
    : null;
}

function loadLegacyKimiSessionFile(filePath: string, root: string, projectPaths: ReadonlyMap<string, string>, stat = safeStat(filePath)): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;
  const messages = sourceMessages(rows, "kimi");
  if (messages.length === 0) return null;
  const meta = rows.find((row): row is Record<string, unknown> => isRecord(row) && (stringField(row, "type") === "session" || stringField(row, "type") === "session_info"));
  const relativeParts = path.relative(root, filePath).split(/[\\/]+/u);
  const sessionsIndex = relativeParts.indexOf("sessions");
  const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
  const rawId = legacyKimiSessionRawId(filePath, root) || stringField(meta, "id") || path.basename(path.dirname(filePath)) || path.basename(filePath, ".jsonl");
  const workDirKey = sessionParts[0] ?? "";
  const mappedProjectPath = [...projectPaths].find(([hash]) => workDirKey === hash || workDirKey.endsWith(`_${hash}`))?.[1] ?? "";
  const projectPath = stringField(meta, "cwd") || stringField(meta, "workDir") || stringField(meta, "work_dir") || mappedProjectPath;
  const question = firstQuestion(messages);
  const statePath = legacyKimiStatePath(filePath);
  const state = statePath ? readJsonObject(statePath) : null;
  const title = stringField(state, "custom_title") || cleanTitle(question) || rawId;
  return {
    session: createIndexedSession({
      keyPrefix: "kimi",
      rawId,
      source: "kimi-cli",
      projectPath,
      filePath,
      originalTitle: title,
      firstQuestion: cleanTitle(question),
      timestamp: stat.mtimeMs,
      stat,
    }),
    messages,
    traceEvents: traceEventsFromRows(rows, "kimi"),
  };
}

interface KimiCodeIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readKimiCodeSessionIndex(root: string): Map<string, KimiCodeIndexEntry> {
  const sessionsRoot = path.join(root, "sessions");
  const entries = new Map<string, KimiCodeIndexEntry>();
  for (const row of readJsonl(path.join(root, "session_index.jsonl"))) {
    if (!isRecord(row)) continue;
    const sessionId = stringField(row, "sessionId");
    if (!sessionId) continue;
    if (row.deleted === true) {
      entries.delete(sessionId);
      continue;
    }
    const sessionDir = stringField(row, "sessionDir");
    const workDir = stringField(row, "workDir");
    if (!path.isAbsolute(sessionDir) || path.basename(sessionDir) !== sessionId || !isPathInside(sessionsRoot, sessionDir)) continue;
    entries.set(sessionId, { sessionId, sessionDir: path.resolve(sessionDir), workDir });
  }
  return entries;
}

function kimiCodeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && stringField(part, "type") === "text" ? stringField(part, "text") : "")
    .filter(Boolean)
    .join("\n");
}

function kimiCodeMessages(rows: unknown[]): SessionMessage[] {
  const drafts: Array<{ role: "user" | "assistant"; parts: string[]; timestamp: string }> = [];
  const openSteps = new Map<string, (typeof drafts)[number]>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const recordType = stringField(row, "type");
    if (recordType === "context.append_message") {
      const message = objectField(row, "message");
      const role = stringField(message, "role");
      if (role !== "user" && role !== "assistant") continue;
      const text = kimiCodeContentText(message?.content);
      if (!text || (role === "user" && !isMeaningfulUserMessage(text))) continue;
      drafts.push({ role, parts: [text], timestamp: timestampString(row.time) });
      continue;
    }
    if (recordType !== "context.append_loop_event") continue;
    const event = objectField(row, "event");
    const eventType = stringField(event, "type");
    if (eventType === "step.begin") {
      const stepId = stringField(event, "uuid");
      if (!stepId) continue;
      const draft = { role: "assistant" as const, parts: [], timestamp: timestampString(row.time) };
      drafts.push(draft);
      openSteps.set(stepId, draft);
      continue;
    }
    if (eventType === "content.part") {
      const draft = openSteps.get(stringField(event, "stepUuid"));
      const part = objectField(event, "part");
      if (draft && stringField(part, "type") === "text") {
        const text = stringField(part, "text");
        if (text) draft.parts.push(text);
      }
      continue;
    }
    if (eventType === "step.end") openSteps.delete(stringField(event, "uuid"));
  }
  return drafts
    .map((draft) => ({ ...draft, content: draft.parts.join("\n") }))
    .filter((draft) => Boolean(draft.content))
    .map((draft, index) => messageFromParts(draft.role, draft.content, draft.timestamp, index));
}

function kimiCodeMainWireIdentity(filePath: string, root: string): { sessionId: string; sessionDir: string } | null {
  const parts = path.relative(root, filePath).split(/[\\/]+/u);
  if (parts.length !== 6 || parts[0] !== "sessions" || parts[3] !== "agents" || parts[4] !== "main" || parts[5] !== "wire.jsonl") return null;
  return { sessionId: parts[2], sessionDir: path.dirname(path.dirname(path.dirname(filePath))) };
}

function kimiCodeTitle(state: Record<string, unknown>, question: string, rawId: string): string {
  const title = stringField(state, "title");
  if (typeof state.isCustomTitle === "boolean" && title) return title;
  return stringField(state, "customTitle") || title || stringField(state, "lastPrompt") || question || rawId;
}

function loadKimiCodeSessionFile(
  filePath: string,
  root: string,
  indexEntry: KimiCodeIndexEntry | undefined,
  state: Record<string, unknown>,
  stat: VirtualSessionFileStat,
): LoadedSession | null {
  const identity = kimiCodeMainWireIdentity(filePath, root);
  if (!identity) return null;
  const rows = readJsonl(filePath);
  const messages = kimiCodeMessages(rows);
  if (messages.length === 0) return null;
  const question = cleanTitle(firstQuestion(messages));
  const projectPath = stringField(state, "cwd") || stringField(state, "workDir") || indexEntry?.workDir || "";
  const timestamp = timestampMs(state.updatedAt) || timestampMs(state.createdAt) || stat.mtimeMs;
  return {
    session: createIndexedSession({
      keyPrefix: "kimi",
      rawId: identity.sessionId,
      source: "kimi-cli",
      projectPath,
      filePath,
      originalTitle: kimiCodeTitle(state, question, identity.sessionId),
      firstQuestion: question,
      timestamp,
      stat,
    }),
    messages,
  };
}

export function* loadKimiSessionsIterator(
  legacyRoot: string,
  codeRoot: string,
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const seen = new Set<string>();
  const legacySessionIds = new Set<string>();
  const projectMetadata = loadKimiProjectPaths(legacyRoot);
  const filesBySessionDir = new Map<string, string[]>();
  for (const filePath of walkJsonlFiles(legacyRoot)) {
    const relativeParts = path.relative(legacyRoot, filePath).split(/[\\/]+/u);
    if (relativeParts.some((part) => part === "agents" || part === "subagents")) continue;
    const sessionsIndex = relativeParts.indexOf("sessions");
    const sessionParts = sessionsIndex >= 0 ? relativeParts.slice(sessionsIndex + 1) : [];
    const isDirectorySession = /^(?:context|wire)\.jsonl$/iu.test(path.basename(filePath));
    const isFlatSession = sessionParts.length === 2 && path.extname(filePath).toLowerCase() === ".jsonl";
    if (!isDirectorySession && !isFlatSession) continue;
    const sessionDir = isDirectorySession ? path.dirname(filePath) : filePath;
    const files = filesBySessionDir.get(sessionDir) ?? [];
    files.push(filePath);
    filesBySessionDir.set(sessionDir, files);
  }
  const representativeFiles = [...filesBySessionDir.values()]
    .map((files) => files.sort((left, right) => {
      const leftPriority = path.basename(left).toLowerCase() === "context.jsonl" ? 0 : 1;
      const rightPriority = path.basename(right).toLowerCase() === "context.jsonl" ? 0 : 1;
      return leftPriority - rightPriority || left.localeCompare(right);
    })[0])
    .sort((left, right) => left.localeCompare(right));
  for (const filePath of representativeFiles) {
    const rawId = legacyKimiSessionRawId(filePath, legacyRoot);
    const seenKey = rawId || filePath;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    legacySessionIds.add(legacyKimiSessionId(filePath));
    const stat = safeStat(filePath);
    const statePath = legacyKimiStatePath(filePath);
    const dependencyMtimeMs = Math.max(projectMetadata.dependencyMtimeMs, statePath ? safeStat(statePath).mtimeMs : 0);
    if (shouldSkipFile(options, filePath, stat, dependencyMtimeMs)) continue;
    const loaded = loadLegacyKimiSessionFile(filePath, legacyRoot, projectMetadata.paths, stat);
    if (loaded) yield loaded;
  }

  const indexPath = path.join(codeRoot, "session_index.jsonl");
  const sessionIndex = readKimiCodeSessionIndex(codeRoot);
  const candidates = new Map<string, { sessionId: string; sessionDir: string; filePath: string }>();
  for (const entry of sessionIndex.values()) {
    const filePath = path.join(entry.sessionDir, "agents", "main", "wire.jsonl");
    if (fs.existsSync(filePath)) candidates.set(path.resolve(entry.sessionDir), { sessionId: entry.sessionId, sessionDir: entry.sessionDir, filePath });
  }
  for (const filePath of walkJsonlFiles(path.join(codeRoot, "sessions"))) {
    const identity = kimiCodeMainWireIdentity(filePath, codeRoot);
    if (identity) candidates.set(path.resolve(identity.sessionDir), { ...identity, filePath });
  }
  for (const candidate of [...candidates.values()].sort((left, right) => left.filePath.localeCompare(right.filePath))) {
    const statePath = path.join(candidate.sessionDir, "state.json");
    const state = readJsonObject(statePath) ?? {};
    const custom = objectField(state, "custom");
    const importedLegacyId = stringField(custom, "kimi_cli_session_id");
    if (importedLegacyId && legacySessionIds.has(importedLegacyId)) continue;
    const stat = safeStat(candidate.filePath);
    const dependencyMtimeMs = Math.max(safeStat(indexPath).mtimeMs, safeStat(statePath).mtimeMs);
    if (shouldSkipFile(options, candidate.filePath, stat, dependencyMtimeMs)) continue;
    const indexed = sessionIndex.get(candidate.sessionId);
    const indexEntry = indexed && path.resolve(indexed.sessionDir) === path.resolve(candidate.sessionDir) ? indexed : undefined;
    const loaded = loadKimiCodeSessionFile(candidate.filePath, codeRoot, indexEntry, state, stat);
    if (loaded) yield loaded;
  }
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

function loadTraeMemoryFile(filePath: string, stat = safeStat(filePath)): LoadedSession | null {
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
    const loaded = loadTraeMemoryFile(filePath, stat);
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
  const raw = content
    .filter((item): item is Record<string, unknown> => isRecord(item) && stringField(item, "type") === "text")
    .map((item) => stringField(item, "text"))
    .filter(Boolean)
    .join("\n");
  return stripQoderWrapperTags(raw);
}

function stripQoderWrapperTags(text: string): string {
  const withoutSystemReminder = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, "");
  const withoutAttachedFiles = withoutSystemReminder.replace(/<attached_files>[\s\S]*?<\/attached_files>/giu, "");
  const userQueryMatch = withoutAttachedFiles.match(/<user_query>([\s\S]*?)<\/user_query>/iu);
  return (userQueryMatch?.[1] ?? withoutAttachedFiles).trim();
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

export function loadDeepSeekCliSessionFile(filePath: string, stat: VirtualSessionFileStat): LoadedSession | null {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const log = parseDeepSeekSessionLog(buffer, filePath);
  if (!log) return null;
  const view = projectDeepSeekSession(log);
  if (view.messages.length === 0) return null;
  const question = firstQuestion(view.messages);
  const usage = createSourceTokenUsage(
    view.usage.inputTokens,
    view.usage.outputTokens,
    view.usage.cacheReadTokens,
    view.usage.reasoningTokens,
  );
  return {
    session: createIndexedSession({
      keyPrefix: "deepseek",
      rawId: log.header.id,
      source: "deepseek-cli",
      projectPath: log.header.cwd || "",
      filePath,
      originalTitle: view.title || cleanTitle(question) || log.header.id,
      firstQuestion: cleanTitle(question),
      timestamp: log.header.createdAt || stat.mtimeMs,
      tokenUsage: usage,
      isSubagent: log.header.delegationDepth > 0,
      parentSessionId: log.header.parentSession ?? null,
      stat,
    }),
    messages: view.messages,
    tokenEvents: view.tokenEvents,
    traceEvents: view.traceEvents,
  };
}

export function loadDeepSeekCliSessions(deepSeekDir?: string): LoadedSession[] {
  return [...loadDeepSeekCliSessionsIterator(deepSeekDir)];
}

export function* loadDeepSeekCliSessionsIterator(
  deepSeekDir = process.env.DSH_HOME?.trim() || path.join(os.homedir(), DEEPSEEK_HARNESS_DIR),
  options: SessionLoadOptions = {},
): Generator<LoadedSession> {
  const sessionsDir = path.join(deepSeekDir, "sessions");
  let projectEntries: fs.Dirent[];
  try {
    projectEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, projectEntry.name);
    let sessionEntries: fs.Dirent[];
    try {
      sessionEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const filePath = path.join(projectDir, sessionEntry.name, DEEPSEEK_HARNESS_LOG_NAME);
      const stat = safeStat(filePath);
      if (shouldSkipFile(options, filePath, stat)) continue;
      const loaded = loadDeepSeekCliSessionFile(filePath, stat);
      if (loaded) yield loaded;
    }
  }
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
  const modelConfig = parseJsonText(unknownField(session, "model_config"));
  const delegateFrom = isRecord(modelConfig) ? stringField(modelConfig, "_delegate_from") || null : null;
  const parentSessionId = delegateFrom
    ? stringField(session, "parent_session_id") || delegateFrom
    : null;
  return {
    session: createIndexedSession({
      keyPrefix: "hermes",
      rawId,
      source: "hermes",
      projectPath:
        stringField(session, "cwd") ||
        extractProjectPathFromJson(unknownField(session, "model_config")),
      filePath: dbPath,
      originalTitle: title || cleanTitle(question) || rawId,
      firstQuestion: cleanTitle(question),
      timestamp: timestampMs(unknownField(session, "started_at")) || stat.mtimeMs,
      tokenUsage: usage,
      stat,
      isSubagent: parentSessionId !== null,
      parentSessionId,
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

function zcodeToolStatus(value: string): "completed" | "failed" | "unknown" {
  if (value === "completed") return "completed";
  if (value === "error") return "failed";
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
      const cached = Math.max(0, numberField(row, "cache_read_input_tokens"));
      const cacheCreation = Math.max(0, numberField(row, "cache_creation_input_tokens"));
      const freshInput = Math.max(0, numberField(row, "input_tokens") - cached - cacheCreation);
      events.push(
        tokenEvent(
          timestampMs(unknownField(row, "completed_at")) || timestampMs(unknownField(row, "started_at")),
          id,
          freshInput,
          Math.max(0, numberField(row, "output_tokens")),
          cached,
          Math.max(0, numberField(row, "reasoning_tokens")),
          cacheCreation,
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
  hasVisibleConversation: boolean;
  executionEnvironmentHint?: LoadedSession["executionEnvironmentHint"];
}

interface CursorBubbleDraft {
  bubbleId: string;
  key: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

function cursorSshEnvironmentHint(
  ...uris: Array<Record<string, unknown> | null>
): LoadedSession["executionEnvironmentHint"] | undefined {
  for (const uri of uris) {
    if (!uri || stringField(uri, "scheme") !== "vscode-remote") continue;
    const authority = stringField(uri, "authority");
    if (!authority.startsWith("ssh-remote+")) continue;
    const hostAlias = authority.slice("ssh-remote+".length).trim();
    if (hostAlias) return { kind: "ssh", label: hostAlias, hostAlias };
  }
  return undefined;
}

function loadCursorComposerMetadata(stateDbPath: string): Map<string, CursorComposerMetadata> {
  const metadata = new Map<string, CursorComposerMetadata>();
  const db = readOnlyDatabase(stateDbPath);
  if (!db) return metadata;

  try {
    if (!sqliteHasColumns(db, "composerHeaders", ["composerId", "createdAt", "isSubagent", "value"])) return metadata;

    const messageDrafts = new Map<string, Map<string, CursorBubbleDraft>>();
    const visibleBubbleIds = new Map<string, string[]>();
    if (sqliteHasColumns(db, "cursorDiskKV", ["key", "value"])) {
      const composerRows = db
        .prepare("SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all() as Array<{ key?: string; value?: string }>;
      for (const row of composerRows) {
        const key = row.key || "";
        const composerId = key.slice("composerData:".length);
        const composerData = parseJsonText(row.value);
        if (!composerId || !isRecord(composerData)) continue;
        const headers = unknownField(composerData, "fullConversationHeadersOnly");
        if (!Array.isArray(headers)) continue;
        visibleBubbleIds.set(
          composerId,
          headers
            .map((header) => stringField(header, "bubbleId"))
            .filter((bubbleId): bubbleId is string => Boolean(bubbleId)),
        );
      }

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
        const bubbleId = stringField(bubble, "bubbleId") || key.slice(separator + 1);
        if (!bubbleId) continue;
        const type = numberField(bubble, "type");
        const role = type === 1 ? "user" : type === 2 ? "assistant" : null;
        if (!role) continue;
        const plainText = stringField(bubble, "text").trim();
        const rawContent = plainText || extractText(parseJsonText(stringField(bubble, "richText"))).trim();
        const content = role === "user" ? extractCursorUserQuery(rawContent) : rawContent;
        if (!content || (role === "user" && !isMeaningfulUserMessage(content))) continue;
        const drafts = messageDrafts.get(composerId) ?? new Map<string, CursorBubbleDraft>();
        drafts.set(bubbleId, {
          bubbleId,
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
      const draftsById = messageDrafts.get(composerId) ?? new Map<string, CursorBubbleDraft>();
      const visibleIds = visibleBubbleIds.get(composerId);
      const drafts = visibleIds !== undefined
        ? visibleIds.flatMap((bubbleId) => {
            const draft = draftsById.get(bubbleId);
            return draft ? [draft] : [];
          })
        : [...draftsById.values()].sort((left, right) => {
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
        hasVisibleConversation: visibleIds !== undefined,
        executionEnvironmentHint: cursorSshEnvironmentHint(workspaceUri, agentUri, draftUri),
      });
    }
  } catch {
    return new Map();
  } finally {
    db.close();
  }

  return metadata;
}

function cursorTranscriptRowsForVisibleBranch(
  rows: unknown[],
  visibleMessages: SessionMessage[],
): unknown[] | null {
  const visiblePrompts = visibleMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim());
  if (visiblePrompts.length === 0) return [];

  const turns: Array<{ rowIndex: number; prompt: string }> = [];
  for (const [rowIndex, row] of rows.entries()) {
    const prompt = sourceMessages([row], "cursor")
      .find((message) => message.role === "user")
      ?.content.trim();
    if (prompt) turns.push({ rowIndex, prompt });
  }

  // Cursor appends replacement turns after discarded ones. Match backwards so
  // repeated prompts resolve to the latest visible branch.
  const visibleTurnRows = new Set<number>();
  let turnIndex = turns.length - 1;
  for (let visibleIndex = visiblePrompts.length - 1; visibleIndex >= 0; visibleIndex -= 1) {
    while (turnIndex >= 0 && turns[turnIndex].prompt !== visiblePrompts[visibleIndex]) {
      turnIndex -= 1;
    }
    if (turnIndex < 0) return null;
    visibleTurnRows.add(turns[turnIndex].rowIndex);
    turnIndex -= 1;
  }

  const filtered: unknown[] = [];
  const turnRows = new Set(turns.map((turn) => turn.rowIndex));
  let includeTurn = false;
  for (const [rowIndex, row] of rows.entries()) {
    if (turnRows.has(rowIndex)) includeTurn = visibleTurnRows.has(rowIndex);
    if (includeTurn) filtered.push(row);
  }
  return filtered;
}

export function loadCursorTranscriptFile(
  filePath: string,
  stat = safeStat(filePath),
  workspacePathMap?: ReadonlyMap<string, string>,
  visibleMessages?: SessionMessage[],
): LoadedSession | null {
  const rows = readJsonl(filePath);
  if (rows.length === 0) return null;

  const { workspaceSlug, sessionId, isSubagent, parentSessionId } = parseCursorTranscriptPath(filePath);
  const rawId = sessionId;
  const visibleRows = visibleMessages === undefined
    ? rows
    : cursorTranscriptRowsForVisibleBranch(rows, visibleMessages);
  const messages = visibleRows === null
    ? (visibleMessages ?? sourceMessages(rows, "cursor"))
    : sourceMessages(visibleRows, "cursor");
  const traceEvents = visibleRows === null ? [] : traceEventsFromCursorRows(visibleRows);
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
      const header = composerMetadata.get(transcriptPath.sessionId);
      const loaded = loadCursorTranscriptFile(
        filePath,
        stat,
        workspacePathMap,
        header?.hasVisibleConversation ? header.messages : undefined,
      );
      if (!loaded) continue;
      transcriptSessionIds.add(transcriptPath.sessionId);
      if (header) {
        loaded.session = {
          ...loaded.session,
          projectPath: header.projectPath || loaded.session.projectPath,
          originalTitle: header.title || loaded.session.originalTitle,
          timestamp: header.createdAt || loaded.session.timestamp,
          isSubagent: header.isSubagent || loaded.session.isSubagent,
          parentSessionId: header.parentSessionId || loaded.session.parentSessionId,
          storageEnvironmentId: "local",
        };
        loaded.executionEnvironmentHint = header.executionEnvironmentHint;
      }
      yield loaded;
    }
  }

  for (const header of composerMetadata.values()) {
    if (transcriptSessionIds.has(header.composerId)) continue;
    if (header.messages.length === 0) continue;
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
        storageEnvironmentId: "local",
      },
      messages: header.messages,
      executionEnvironmentHint: header.executionEnvironmentHint,
    };
  }
}
