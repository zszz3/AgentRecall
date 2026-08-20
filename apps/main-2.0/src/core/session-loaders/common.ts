import * as fs from "node:fs";
import * as path from "node:path";

import { getAdapter, isMeaningfulUserMessage } from "../format-adapters";
import { truncateTraceDetail } from "../trace-detail";
import type {
  IndexedSession,
  LoadedSession,
  SessionFormat,
  SessionMessage,
  SessionSource,
  SessionTraceEvent,
  TokenUsage,
  TokenUsageEvent,
} from "../types";

export type TraceEventDraft = Omit<SessionTraceEvent, "index">;

export interface SessionLoadOptions {
  homeDir?: string;
  includeStepcode?: boolean;
  stepcodeSessionAgents?: ReadonlyMap<string, "claude" | "codex">;
  includeTclaude?: boolean;
  includeTcodex?: boolean;
  includeCodeBuddyCli?: boolean;
  includeWorkBuddy?: boolean;
  includeCodeWizCli?: boolean;
  includeOpenClaw?: boolean;
  includeHermes?: boolean;
  includeOpenCode?: boolean;
  includeZcode?: boolean;
  includeCursorAgent?: boolean;
  includeTrae?: boolean;
  includeQoder?: boolean;
  includePi?: boolean;
  includeKimiCli?: boolean;
  includeDeepSeekCli?: boolean;
  cursorStateDbPath?: string;
  cursorWorkspacePathMap?: ReadonlyMap<string, string>;
  shouldSkipFile?: (
    filePath: string,
    stat: VirtualSessionFileStat,
    dependencyMtimeMs?: number,
    source?: SessionSource,
  ) => boolean;
  onSkippedFile?: (filePath: string, stat: VirtualSessionFileStat) => void;
  incrementalCodexSessions?: ReadonlyMap<string, { offset: number; loaded: LoadedSession }>;
  loadIncrementalCodexSession?: (
    filePath: string,
  ) => Promise<{ offset: number; loaded: LoadedSession } | undefined>;
}

export interface VirtualSessionFileStat {
  mtimeMs: number;
  size: number;
}

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export function safeStat(filePath: string): VirtualSessionFileStat {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

export function shouldSkipFile(
  options: SessionLoadOptions,
  filePath: string,
  stat = safeStat(filePath),
  dependencyMtimeMs = 0,
  source?: SessionSource,
): boolean {
  if (!options.shouldSkipFile?.(filePath, stat, dependencyMtimeMs, source)) return false;
  options.onSkippedFile?.(filePath, stat);
  return true;
}

export function parseJsonlText(content: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Keep parsing the rest of the JSONL text.
    }
  }
  return rows;
}

export function readJsonl(filePath: string): unknown[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  return parseJsonlText(content);
}

export function extractMessages(rows: unknown[], format: SessionFormat): SessionMessage[] {
  const adapter = getAdapter(format);
  const messages: SessionMessage[] = [];
  for (const raw of rows) {
    const parsed = adapter.parseLine(raw);
    if (!parsed) continue;
    if (parsed.role === "user" && !isMeaningfulUserMessage(parsed.content)) continue;
    messages.push({ ...parsed, index: messages.length });
  }
  return messages;
}

export function firstQuestion(messages: SessionMessage[]): string {
  return messages.find(
    (message) => message.role === "user" && isMeaningfulUserMessage(message.content),
  )?.content || "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}

export function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

export function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

export function unknownField(value: unknown, key: string): unknown {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function stringifyDetail(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return truncateTraceDetail(value);
  try {
    return truncateTraceDetail(JSON.stringify(value, null, 2));
  } catch {
    return truncateTraceDetail(String(value));
  }
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function firstStringField(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  return "";
}

export function titleWithSummary(name: string, summary: string): string {
  return summary ? `${name} · ${summary}` : name;
}

export function mcpResultStatus(result: unknown): SessionTraceEvent["status"] {
  if (!isRecord(result)) return "unknown";
  if ("Err" in result) return "failed";
  const ok = result.Ok;
  if (!isRecord(ok)) return "unknown";
  if (ok.isError === true) return "failed";
  if (ok.isError === false) return "completed";
  return "unknown";
}

export function mcpDurationAttribute(duration: unknown): { durationMs?: number } {
  if (!isRecord(duration)) return {};
  const secs = typeof duration.secs === "number" && Number.isFinite(duration.secs) ? duration.secs : null;
  const nanos = typeof duration.nanos === "number" && Number.isFinite(duration.nanos) ? duration.nanos : null;
  if (secs === null && nanos === null) return {};
  const durationMs = Math.round((secs ?? 0) * 1_000 + (nanos ?? 0) / 1_000_000);
  return durationMs >= 0 ? { durationMs } : {};
}

export function statusFromExit(
  exitCode: number | undefined,
  fallback?: boolean,
): "completed" | "failed" | "unknown" {
  if (typeof exitCode === "number") return exitCode === 0 ? "completed" : "failed";
  if (typeof fallback === "boolean") return fallback ? "completed" : "failed";
  return "unknown";
}

export function joinNonEmpty(parts: string[]): string {
  return truncateTraceDetail(parts.filter((part) => part.trim()).join("\n\n"));
}

export function dedupeTraceEvents(events: TraceEventDraft[]): SessionTraceEvent[] {
  const eventCallIds = new Set(
    events
      .filter((event) => event.kind === "event" && event.callId)
      .map((event) => event.callId),
  );
  return events
    .filter(
      (event) => !(event.kind === "tool_result" && event.callId && eventCallIds.has(event.callId)),
    )
    .map((event, index) => ({ ...event, index }));
}

export function createTokenUsage(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
  cacheCreationInputTokens = 0,
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheCreationInputTokens > 0 ? { cacheCreationInputTokens } : {}),
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheCreationInputTokens + reasoningOutputTokens,
  };
}

export function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function tokenEvent(
  timestamp: number,
  dedupeKey: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  reasoningOutputTokens: number,
  cacheCreationInputTokens = 0,
): TokenUsageEvent {
  return {
    timestamp,
    dedupeKey,
    ...createTokenUsage(inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, cacheCreationInputTokens),
  };
}

export function putTokenEvent(
  entries: Map<string, TokenUsageEvent>,
  entry: TokenUsageEvent,
): void {
  const existing = entries.get(entry.dedupeKey);
  if (!existing || entry.totalTokens > existing.totalTokens) entries.set(entry.dedupeKey, entry);
}

export function tokenUsageFromEvents(events: TokenUsageEvent[]): TokenUsage {
  const total = emptyTokenUsage();
  for (const entry of events) {
    total.inputTokens += entry.inputTokens;
    total.outputTokens += entry.outputTokens;
    total.cachedInputTokens += entry.cachedInputTokens;
    if (total.cacheCreationInputTokens !== undefined || entry.cacheCreationInputTokens !== undefined) {
      total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (entry.cacheCreationInputTokens ?? 0);
    }
    total.reasoningOutputTokens += entry.reasoningOutputTokens;
    total.totalTokens += entry.totalTokens;
  }
  return total;
}

export function createIndexedSession(input: {
  keyPrefix:
    | "claude"
    | "codex"
    | "stepcode"
    | "stepcode-claude"
    | "stepcode-codex"
    | "tclaude"
    | "tcodex"
    | "codebuddy"
    | "workbuddy"
    | "codewiz"
    | "openclaw"
    | "hermes"
    | "opencode"
    | "zcode"
    | "cursor"
    | "trae"
    | "qoder"
    | "pi"
    | "kimi"
    | "deepseek";
  rawId: string;
  source: SessionSource;
  projectPath: string;
  filePath: string;
  originalTitle: string;
  firstQuestion: string;
  timestamp: number;
  prUrl?: string | null;
  prNumber?: number | null;
  gitBranch?: string | null;
  tokenUsage?: TokenUsage;
  stat?: VirtualSessionFileStat;
  isSubagent?: boolean;
  parentSessionId?: string | null;
}): IndexedSession {
  const stat = input.stat ?? safeStat(input.filePath);
  return {
    sessionKey: `${input.keyPrefix}:${input.rawId}`,
    rawId: input.rawId,
    source: input.source,
    projectPath: input.projectPath,
    filePath: input.filePath,
    originalTitle: input.originalTitle || input.firstQuestion || "Untitled Session",
    firstQuestion: input.firstQuestion,
    timestamp: input.timestamp || stat.mtimeMs,
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    gitBranch: input.gitBranch ?? null,
    tokenUsage: input.tokenUsage ?? emptyTokenUsage(),
    isSubagent: input.isSubagent ?? false,
    parentSessionId: input.parentSessionId ?? null,
  };
}

export function walkJsonlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonlFiles(fullPath));
    else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}
