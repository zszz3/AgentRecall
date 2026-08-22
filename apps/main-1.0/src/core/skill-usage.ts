import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { scanCompleteJsonlAsync } from "./codex-jsonl-stream";
import { extractCodexStructuredToolCalls } from "./session-loaders/codex-tool-calls";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => import("node:sqlite").DatabaseSync;
};

export interface SkillUsageStat {
  skill: string;
  count: number;
  lastUsedAt: number;
}

export type SkillUsageAgent = "codex" | "claude" | "qoder";
export type SkillUsageSourceKind =
  | "claude-hook"
  | "claude-session"
  | "codex-session"
  | "codebuddy-session"
  | "workbuddy-session"
  | "cursor-session"
  | "openclaw-session"
  | "qoder-session"
  | "hermes-db"
  | "opencode-db"
  | "codewiz-db"
  | "zcode-db";

export type SkillUsageProvider =
  | "claude"
  | "codex"
  | "tclaude"
  | "tcodex"
  | "codebuddy"
  | "workbuddy"
  | "cursor"
  | "openclaw"
  | "qoder"
  | "hermes"
  | "opencode"
  | "codewiz"
  | "zcode";

export interface SkillUsageEvent {
  agent: SkillUsageAgent;
  skill: string;
  timestamp: number;
}

export interface SkillUsageSource {
  // Kept for persistence compatibility. Events carry the attributed Skill owner.
  agent: SkillUsageAgent;
  provider?: SkillUsageProvider;
  kind: SkillUsageSourceKind;
  path: string;
  mtimeMs: number;
  fileSize: number;
}

export interface SkillUsageRefreshStatus {
  refreshed: number;
  skipped: number;
  total: number;
  totalEvents: number;
  lastRefreshedAt: number;
}

export interface SkillUsageSnapshot {
  path: string;
  exists: boolean;
  totalEvents: number;
  stats: SkillUsageStat[];
  byName: Record<string, SkillUsageStat>;
  byAgentName: Record<string, SkillUsageStat>;
}

export interface SkillUsageOptions {
  homeDir?: string;
  usagePath?: string;
  codexSessionsDir?: string | null;
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
  includeQoder?: boolean;
}

interface StructuredToolCall {
  name: string;
  input: unknown;
}

export function loadSkillUsage(options: SkillUsageOptions = {}): SkillUsageSnapshot {
  const usagePath = resolveUsagePath(options);
  let exists = false;
  const events: SkillUsageEvent[] = [];
  for (const source of listSkillUsageSources(options)) {
    const sourceEvents = readSkillUsageSourceEvents(source);
    if (source.kind === "claude-hook" || sourceEvents.length > 0) exists = true;
    events.push(...sourceEvents);
  }

  return skillUsageSnapshotFromEvents(events, usagePath, exists);
}

export function skillUsageSnapshotFromEvents(
  events: SkillUsageEvent[],
  usagePath = "",
  exists = events.length > 0,
): SkillUsageSnapshot {
  const byKey = new Map<string, SkillUsageStat>();
  const byAgentKey = new Map<string, SkillUsageStat>();
  addUsageEvents(byKey, byAgentKey, events);
  const byName: Record<string, SkillUsageStat> = {};
  for (const [key, stat] of byKey) byName[key] = stat;
  const byAgentName: Record<string, SkillUsageStat> = {};
  for (const [key, stat] of byAgentKey) byAgentName[key] = stat;
  const stats = [...byKey.values()].sort(
    (a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.skill.localeCompare(b.skill),
  );

  return { path: usagePath, exists, totalEvents: events.length, stats, byName, byAgentName };
}

export function listSkillUsageSources(options: SkillUsageOptions = {}): SkillUsageSource[] {
  const homeDir = options.homeDir ?? os.homedir();
  const sources: SkillUsageSource[] = [];

  addJsonlSources(sources, path.join(homeDir, ".claude", "projects"), "claude", "claude", "claude-session");
  if (options.includeTclaude !== false) {
    addJsonlSources(sources, path.join(homeDir, ".tclaude", "projects"), "claude", "tclaude", "claude-session");
  }

  const hasNativeClaudeSessions = sources.some(
    (source) => source.kind === "claude-session" && source.provider === "claude",
  );
  if (!hasNativeClaudeSessions) {
    const usagePath = resolveUsagePath(options);
    const stat = safeStat(usagePath);
    if (stat) {
      sources.push({ agent: "claude", provider: "claude", kind: "claude-hook", path: usagePath, ...stat });
    }
  }

  const codexSessionsDir = resolveCodexSessionsDir(options);
  if (codexSessionsDir) addJsonlSources(sources, codexSessionsDir, "codex", "codex", "codex-session");
  if (options.includeTcodex !== false) {
    addJsonlSources(sources, path.join(homeDir, ".tcodex", "sessions"), "codex", "tcodex", "codex-session");
  }
  if (options.includeCodeBuddyCli !== false) {
    addJsonlSources(sources, path.join(homeDir, ".codebuddy", "projects"), "codex", "codebuddy", "codebuddy-session");
  }
  if (options.includeWorkBuddy !== false) {
    const projectsDir = path.join(homeDir, ".workbuddy", "projects");
    addJsonlSources(sources, projectsDir, "codex", "workbuddy", "workbuddy-session", undefined, (filePath) =>
      isWorkBuddySessionFile(projectsDir, filePath));
  }
  if (options.includeCursorAgent !== false) addCursorSources(sources, path.join(homeDir, ".cursor", "projects"));
  if (options.includeOpenClaw !== false) {
    addOpenClawSources(sources, path.join(homeDir, ".openclaw", "agents"));
    addOpenClawSources(sources, path.join(homeDir, ".clawdbot", "agents"));
  }
  if (options.includeQoder !== false) {
    addJsonlSources(
      sources,
      path.join(homeDir, ".qoder", "cache", "projects"),
      "qoder",
      "qoder",
      "qoder-session",
      "/conversation-history/",
    );
  }
  if (options.includeHermes !== false) {
    addDatabaseSource(sources, path.join(homeDir, ".hermes", "state.db"), "hermes", "hermes-db");
  }
  if (options.includeOpenCode !== false) {
    addDatabaseSource(sources, path.join(homeDir, ".local", "share", "opencode", "opencode.db"), "opencode", "opencode-db");
  }
  if (options.includeCodeWizCli !== false) {
    addDatabaseSource(sources, path.join(homeDir, ".local", "share", "codewiz", "opencode.db"), "codewiz", "codewiz-db");
  }
  if (options.includeZcode !== false) {
    addDatabaseSource(sources, path.join(homeDir, ".zcode", "cli", "db", "db.sqlite"), "zcode", "zcode-db");
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listSkillUsageSourcesAsync(options: SkillUsageOptions = {}): Promise<SkillUsageSource[]> {
  const homeDir = options.homeDir ?? os.homedir();
  const sources: SkillUsageSource[] = [];

  await addJsonlSourcesAsync(sources, path.join(homeDir, ".claude", "projects"), "claude", "claude", "claude-session");
  if (options.includeTclaude !== false) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".tclaude", "projects"), "claude", "tclaude", "claude-session");
  }

  const hasNativeClaudeSessions = sources.some(
    (source) => source.kind === "claude-session" && source.provider === "claude",
  );
  if (!hasNativeClaudeSessions) {
    const usagePath = resolveUsagePath(options);
    const stat = await safeStatAsync(usagePath);
    if (stat) sources.push({ agent: "claude", provider: "claude", kind: "claude-hook", path: usagePath, ...stat });
  }

  const codexSessionsDir = resolveCodexSessionsDir(options);
  if (codexSessionsDir) await addJsonlSourcesAsync(sources, codexSessionsDir, "codex", "codex", "codex-session");
  if (options.includeTcodex !== false) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".tcodex", "sessions"), "codex", "tcodex", "codex-session");
  }
  if (options.includeCodeBuddyCli !== false) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".codebuddy", "projects"), "codex", "codebuddy", "codebuddy-session");
  }
  if (options.includeWorkBuddy !== false) {
    const projectsDir = path.join(homeDir, ".workbuddy", "projects");
    await addJsonlSourcesAsync(sources, projectsDir, "codex", "workbuddy", "workbuddy-session", undefined, (filePath) =>
      isWorkBuddySessionFile(projectsDir, filePath));
  }
  if (options.includeCursorAgent !== false) await addCursorSourcesAsync(sources, path.join(homeDir, ".cursor", "projects"));
  if (options.includeOpenClaw !== false) {
    await addOpenClawSourcesAsync(sources, path.join(homeDir, ".openclaw", "agents"));
    await addOpenClawSourcesAsync(sources, path.join(homeDir, ".clawdbot", "agents"));
  }
  if (options.includeQoder !== false) {
    await addJsonlSourcesAsync(
      sources,
      path.join(homeDir, ".qoder", "cache", "projects"),
      "qoder",
      "qoder",
      "qoder-session",
      "/conversation-history/",
    );
  }
  if (options.includeHermes !== false) {
    await addDatabaseSourceAsync(sources, path.join(homeDir, ".hermes", "state.db"), "hermes", "hermes-db");
  }
  if (options.includeOpenCode !== false) {
    await addDatabaseSourceAsync(sources, path.join(homeDir, ".local", "share", "opencode", "opencode.db"), "opencode", "opencode-db");
  }
  if (options.includeCodeWizCli !== false) {
    await addDatabaseSourceAsync(sources, path.join(homeDir, ".local", "share", "codewiz", "opencode.db"), "codewiz", "codewiz-db");
  }
  if (options.includeZcode !== false) {
    await addDatabaseSourceAsync(sources, path.join(homeDir, ".zcode", "cli", "db", "db.sqlite"), "zcode", "zcode-db");
  }

  return sources.sort((a, b) => a.path.localeCompare(b.path));
}

export function readSkillUsageSourceEvents(source: SkillUsageSource): SkillUsageEvent[] {
  if (source.kind === "claude-hook") return readClaudeUsageEvents(source.path) ?? [];
  if (source.kind.endsWith("-db")) return readDatabaseUsageEvents(source);
  return readSessionFileUsageEvents(source);
}

export async function readSkillUsageSourceEventsAsync(source: SkillUsageSource): Promise<SkillUsageEvent[]> {
  if (source.kind.endsWith("-db")) return readDatabaseUsageEvents(source);
  if (source.kind === "codex-session") return readCodexSessionUsageEventsAsync(source);
  const events: SkillUsageEvent[] = [];
  try {
    await scanCompleteJsonlAsync(source.path, {
      shouldParseLine: (line) => line.length <= 512 * 1024,
      onRecord: (record) => {
        if (!isRecord(record)) return;
        if (source.kind === "claude-hook") {
          const skill = record.skill;
          if (typeof skill === "string" && skill.trim()) {
            events.push({ agent: "claude", skill: skill.trim(), timestamp: timestampFrom(record.ts) });
          }
          return;
        }
        events.push(...parseSessionUsageRecord(record, source));
      },
    });
  } catch {
    return [];
  }
  return events;
}

// Codex sessions are scanned as a whole file: the structured tool-call layer
// must see requests and runtime completions together to deduplicate them.
async function readCodexSessionUsageEventsAsync(source: SkillUsageSource): Promise<SkillUsageEvent[]> {
  const rows: unknown[] = [];
  try {
    await scanCompleteJsonlAsync(source.path, {
      shouldParseLine: (line) => line.length <= 512 * 1024,
      onRecord: (record) => {
        if (isRecord(record)) rows.push(record);
      },
    });
  } catch {
    return [];
  }
  return codexSessionUsageEvents(rows, source);
}

function addUsageEvents(
  byKey: Map<string, SkillUsageStat>,
  byAgentKey: Map<string, SkillUsageStat>,
  events: SkillUsageEvent[],
): number {
  let added = 0;
  for (const event of events) {
    added += 1;
    const key = event.skill.toLowerCase();
    const agentKey = usageAgentKey(event.agent, event.skill);
    const current = byKey.get(key);
    if (current) {
      current.count += 1;
      if (event.timestamp > current.lastUsedAt) current.lastUsedAt = event.timestamp;
    } else {
      byKey.set(key, { skill: event.skill, count: 1, lastUsedAt: event.timestamp });
    }
    const currentForAgent = byAgentKey.get(agentKey);
    if (currentForAgent) {
      currentForAgent.count += 1;
      if (event.timestamp > currentForAgent.lastUsedAt) currentForAgent.lastUsedAt = event.timestamp;
    } else {
      byAgentKey.set(agentKey, { skill: event.skill, count: 1, lastUsedAt: event.timestamp });
    }
  }
  return added;
}

function readClaudeUsageEvents(usagePath: string): SkillUsageEvent[] | null {
  const events: SkillUsageEvent[] = [];
  const read = forEachJsonlLine(usagePath, (line) => {
    const event = parseUsageLine(line);
    if (event) events.push({ ...event, agent: "claude" });
  });
  return read ? events : null;
}

export function usageForSkill(
  snapshot: SkillUsageSnapshot,
  skillName: string,
  agent?: SkillUsageAgent,
): SkillUsageStat | null {
  if (agent) return snapshot.byAgentName[usageAgentKey(agent, skillName)] ?? null;
  return snapshot.byName[skillName.trim().toLowerCase()] ?? null;
}

function parseUsageLine(line: string): { skill: string; timestamp: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const skill = parsed.skill;
  if (typeof skill !== "string" || !skill.trim()) return null;
  return { skill: skill.trim(), timestamp: timestampFrom(parsed.ts) };
}

function readSessionFileUsageEvents(source: SkillUsageSource): SkillUsageEvent[] {
  if (source.kind === "codex-session") {
    const rows: unknown[] = [];
    forEachJsonlLine(source.path, (line) => {
      const parsed = parseUsageRecordLine(line);
      if (parsed) rows.push(parsed);
    });
    return codexSessionUsageEvents(rows, source);
  }
  const events: SkillUsageEvent[] = [];
  forEachJsonlLine(source.path, (line) => events.push(...parseSessionUsageLine(line, source)));
  return events;
}

// Codex tool usage flows through the structured tool-call layer so requests,
// runtime completions and namespaced tools are each counted once per call.
function codexSessionUsageEvents(rows: readonly unknown[], source: SkillUsageSource): SkillUsageEvent[] {
  const defaultOwner = source.provider === "codex" || source.provider === "tcodex"
    ? "codex"
    : undefined;
  return extractCodexStructuredToolCalls(rows).flatMap((call) => usageEventsFromToolCall(
    { name: call.canonicalName, input: call.input },
    Math.min(...call.evidence.map((item) => item.timestamp)),
    defaultOwner,
  ));
}

function parseUsageRecordLine(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

function parseSessionUsageLine(line: string, source: SkillUsageSource): SkillUsageEvent[] {
  const parsed = parseUsageRecordLine(line);
  return parsed ? parseSessionUsageRecord(parsed, source) : [];
}

function parseSessionUsageRecord(parsed: Record<string, unknown>, source: SkillUsageSource): SkillUsageEvent[] {

  const timestamp = timestampFrom(parsed.timestamp ?? parsed.createdAt ?? parsed.created_at);
  if (source.kind === "codex-session") return [];
  const calls = source.kind === "codebuddy-session"
      ? codeBuddyToolCalls(parsed)
      : source.kind === "workbuddy-session"
        ? workBuddyToolCalls(parsed)
        : source.kind === "openclaw-session"
          ? openClawToolCalls(parsed)
          : assistantToolCalls(parsed);
  const defaultOwner = source.provider === "claude" || source.provider === "tclaude"
    ? "claude"
    : source.provider === "codex" || source.provider === "tcodex"
      ? "codex"
      : source.provider === "qoder"
        ? "qoder"
        : undefined;

  return calls.flatMap((call) => usageEventsFromToolCall(call, timestamp, defaultOwner));
}

function codeBuddyToolCalls(row: Record<string, unknown>): StructuredToolCall[] {
  if (row.type === "function_call" && typeof row.name === "string") {
    return [{ name: row.name, input: row.input ?? row.arguments }];
  }
  return assistantToolCalls(row);
}

function workBuddyToolCalls(row: Record<string, unknown>): StructuredToolCall[] {
  if (row.type !== "function_call" || typeof row.name !== "string") return [];
  return [{ name: row.name, input: row.arguments }];
}

function assistantToolCalls(row: Record<string, unknown>): StructuredToolCall[] {
  const message = recordField(row, "message") ?? row;
  if (message.role !== "assistant" && row.type !== "assistant") return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): StructuredToolCall[] => {
    if (!isRecord(item) || item.type !== "tool_use" || typeof item.name !== "string") return [];
    return [{ name: item.name, input: item.input }];
  });
}

function openClawToolCalls(row: Record<string, unknown>): StructuredToolCall[] {
  if (row.type !== "custom" || row.customType !== "tool_call") return [];
  const data = recordField(row, "data");
  if (!data) return [];
  const name = typeof data.name === "string" ? data.name : typeof data.tool_name === "string" ? data.tool_name : null;
  if (!name) return [];
  return [{ name, input: data.input ?? data.arguments ?? data }];
}

function usageEventsFromToolCall(
  call: StructuredToolCall,
  timestamp: number,
  defaultOwner?: SkillUsageAgent,
): SkillUsageEvent[] {
  const normalizedName = baseToolName(call.name);
  if (!normalizedName || isMutatingOrResultTool(normalizedName)) return [];
  const input = parseMaybeJson(call.input);

  if (normalizedName === "skill") {
    if (!defaultOwner) return [];
    const skill = explicitSkillName(input);
    return skill ? [{ agent: defaultOwner, skill, timestamp }] : [];
  }
  if (isShellTool(normalizedName)) {
    const command = shellCommandText(input);
    if (!isReadOnlySkillCommand(command)) return [];
  } else if (!isReadOnlyFileTool(normalizedName)) {
    return [];
  }

  const events = new Map<string, SkillUsageEvent>();
  for (const { skill, path: skillPath } of skillPathsFromText(toolInputText(input))) {
    const owner = ownerFromSkillPath(skillPath) ?? defaultOwner;
    if (owner) events.set(`${owner}:${skill.toLowerCase()}`, { agent: owner, skill, timestamp });
  }
  return [...events.values()];
}

function baseToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.split(/[:./]/).filter(Boolean).pop() ?? "";
}

function isMutatingOrResultTool(name: string): boolean {
  return name.includes("apply_patch") || name.includes("patch") || name.includes("write") ||
    name.includes("edit") || name.includes("delete") || name.includes("remove") ||
    name.includes("move") || name.includes("copy") || name.includes("result") || name.includes("output");
}

function isReadOnlyFileTool(name: string): boolean {
  return name === "read" || name === "read_file" || name === "readfile" ||
    name.endsWith("_read") || name.endsWith("__read_file") || name.endsWith("__readfile");
}

function isShellTool(name: string): boolean {
  return name.includes("exec") || name.includes("command") || name.includes("shell") ||
    name === "bash" || name === "terminal" || name === "powershell";
}

function shellCommandText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return "";
  for (const key of ["cmd", "command"]) {
    const value = input[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  }
  return "";
}

function isReadOnlySkillCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed || !skillPathsFromText(trimmed).length) return false;
  if (/(^|[^<])>(?!>)|>>|\b(?:rm|mv|cp|install|tee|dd|truncate|touch|chmod|chown|del|erase|remove-item|move-item|copy-item|set-content|add-content|out-file)\b/i.test(trimmed)) {
    return false;
  }
  const segments = trimmed.split(/&&|\|\||;|\r?\n/).map((part) => part.trim()).filter(Boolean);
  if (segments.length !== 1) return false;
  const executable = segments[0].match(/^(?:sudo\s+)?(?:[A-Za-z]:\\[^\s]+\s+|[^\s]+\/)?([^\s]+)(?:\s|$)/)?.[1]?.toLowerCase();
  if (!executable) return false;
  if (["cat", "head", "tail", "less", "more", "bat", "type", "get-content", "gc"].includes(executable)) return true;
  return executable === "sed" && /(?:^|\s)-n(?:\s|$)/.test(segments[0]) && !/(?:^|\s)-(?:i|e)(?:\s|$)/.test(segments[0]);
}

function explicitSkillName(input: unknown): string | null {
  if (typeof input === "string") return input.trim() || null;
  if (!isRecord(input)) return null;
  for (const key of ["skill", "skill_name", "skillName", "name"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function toolInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!isRecord(input)) return "";
  const values: string[] = [];
  for (const key of ["path", "file_path", "cmd", "command"]) {
    const value = input[key];
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((item): item is string => typeof item === "string"));
  }
  return values.join(" ");
}

function skillPathsFromText(text: string): Array<{ skill: string; path: string }> {
  const normalized = text.replace(/\\\//g, "/");
  const matches = new Map<string, { skill: string; path: string }>();
  const pattern = /([^\s"'`]*[/\\])?([^/\\\s"'`]+)[/\\]SKILL\.md\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    const skill = match[2];
    if (!skill) continue;
    const skillPath = match[0];
    matches.set(`${skill.toLowerCase()}\0${skillPath.toLowerCase()}`, { skill, path: skillPath });
  }
  return [...matches.values()];
}

function ownerFromSkillPath(skillPath: string): SkillUsageAgent | null {
  const normalized = skillPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.claude/skills/")) return "claude";
  if (normalized.includes("/.qoder/skills/")) return "qoder";
  if (normalized.includes("/.codex/skills/") || normalized.includes("/.agents/skills/")) return "codex";
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readDatabaseUsageEvents(source: SkillUsageSource): SkillUsageEvent[] {
  let db: import("node:sqlite").DatabaseSync;
  try {
    db = new DatabaseSync(source.path, { readOnly: true });
  } catch {
    return [];
  }
  try {
    if (source.kind === "hermes-db") return readHermesUsageEvents(db);
    return readOpenCodeLikeUsageEvents(db);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readHermesUsageEvents(db: import("node:sqlite").DatabaseSync): SkillUsageEvent[] {
  const rows = db.prepare(
    "SELECT tool_name, tool_calls, timestamp FROM messages WHERE tool_name IS NOT NULL OR tool_calls IS NOT NULL ORDER BY timestamp, id",
  ).all() as Array<Record<string, unknown>>;
  const events: SkillUsageEvent[] = [];
  for (const row of rows) {
    const timestamp = timestampFromDatabase(row.timestamp);
    const calls = parseMaybeJson(row.tool_calls);
    if (Array.isArray(calls)) {
      for (const value of calls) {
        if (!isRecord(value)) continue;
        const fn = recordField(value, "function") ?? value;
        if (typeof fn.name === "string") {
          events.push(...usageEventsFromToolCall({ name: fn.name, input: fn.arguments ?? fn.input }, timestamp));
        }
      }
      continue;
    }
    if (typeof row.tool_name === "string" && isRecord(calls)) {
      events.push(...usageEventsFromToolCall({ name: row.tool_name, input: calls }, timestamp));
    }
  }
  return events;
}

function readOpenCodeLikeUsageEvents(db: import("node:sqlite").DatabaseSync): SkillUsageEvent[] {
  const rows = db.prepare("SELECT data, time_created FROM part ORDER BY time_created, id").all() as Array<Record<string, unknown>>;
  const events: SkillUsageEvent[] = [];
  for (const row of rows) {
    const part = parseMaybeJson(row.data);
    if (!isRecord(part) || part.type !== "tool") continue;
    const tool = typeof part.tool === "string"
      ? part.tool
      : typeof part.toolName === "string"
        ? part.toolName
        : typeof part.name === "string"
          ? part.name
          : null;
    if (!tool) continue;
    const state = recordField(part, "state");
    const input = state?.input ?? part.input ?? part.arguments;
    const time = state ? recordField(state, "time") : null;
    const timestamp = timestampFromDatabase(time?.start ?? row.time_created);
    events.push(...usageEventsFromToolCall({ name: tool, input }, timestamp));
  }
  return events;
}

function timestampFromDatabase(value: unknown): number {
  const timestamp = timestampFrom(value);
  return timestamp > 0 && timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
}

function addJsonlSources(
  sources: SkillUsageSource[],
  dir: string,
  agent: SkillUsageAgent,
  provider: SkillUsageProvider,
  kind: SkillUsageSourceKind,
  requiredPathPart?: string,
  acceptFile?: (filePath: string) => boolean,
): void {
  for (const filePath of walkJsonlFiles(dir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (requiredPathPart && !normalized.includes(requiredPathPart)) continue;
    if (acceptFile && !acceptFile(filePath)) continue;
    const stat = safeStat(filePath);
    if (stat) sources.push({ agent, provider, kind, path: filePath, ...stat });
  }
}

async function addJsonlSourcesAsync(
  sources: SkillUsageSource[],
  dir: string,
  agent: SkillUsageAgent,
  provider: SkillUsageProvider,
  kind: SkillUsageSourceKind,
  requiredPathPart?: string,
  acceptFile?: (filePath: string) => boolean,
): Promise<void> {
  for await (const filePath of walkJsonlFilesAsync(dir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (requiredPathPart && !normalized.includes(requiredPathPart)) continue;
    if (acceptFile && !acceptFile(filePath)) continue;
    const stat = await safeStatAsync(filePath);
    if (stat) sources.push({ agent, provider, kind, path: filePath, ...stat });
  }
}

function isWorkBuddySessionFile(projectsDir: string, filePath: string): boolean {
  const relativePath = path.relative(projectsDir, filePath);
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return false;
  const segments = relativePath.split(path.sep);
  const stem = path.basename(filePath, ".jsonl");
  if (!stem || stem === "." || stem === ".." || path.extname(filePath) !== ".jsonl") return false;
  if (segments.length === 2) return /^[A-Za-z0-9_-]+$/u.test(stem);
  return segments.length === 4
    && segments[2] === "subagents"
    && /^[A-Za-z0-9_-]+$/u.test(segments[1]);
}

function addDatabaseSource(
  sources: SkillUsageSource[],
  filePath: string,
  provider: SkillUsageProvider,
  kind: SkillUsageSourceKind,
): void {
  const stat = safeStat(filePath);
  if (stat) sources.push({ agent: "codex", provider, kind, path: filePath, ...stat });
}

async function addDatabaseSourceAsync(
  sources: SkillUsageSource[],
  filePath: string,
  provider: SkillUsageProvider,
  kind: SkillUsageSourceKind,
): Promise<void> {
  const stat = await safeStatAsync(filePath);
  if (stat) sources.push({ agent: "codex", provider, kind, path: filePath, ...stat });
}

function addCursorSources(sources: SkillUsageSource[], projectsDir: string): void {
  for (const filePath of walkJsonlFiles(projectsDir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (!normalized.includes("/agent-transcripts/")) continue;
    const stat = safeStat(filePath);
    if (stat) sources.push({ agent: "codex", provider: "cursor", kind: "cursor-session", path: filePath, ...stat });
  }
}

async function addCursorSourcesAsync(sources: SkillUsageSource[], projectsDir: string): Promise<void> {
  for await (const filePath of walkJsonlFilesAsync(projectsDir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (!normalized.includes("/agent-transcripts/")) continue;
    const stat = await safeStatAsync(filePath);
    if (stat) sources.push({ agent: "codex", provider: "cursor", kind: "cursor-session", path: filePath, ...stat });
  }
}

function addOpenClawSources(sources: SkillUsageSource[], agentsDir: string): void {
  for (const filePath of walkJsonlFiles(agentsDir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (!normalized.includes("/sessions/") || normalized.endsWith(".trajectory.jsonl")) continue;
    const stat = safeStat(filePath);
    if (stat) sources.push({ agent: "codex", provider: "openclaw", kind: "openclaw-session", path: filePath, ...stat });
  }
}

async function addOpenClawSourcesAsync(sources: SkillUsageSource[], agentsDir: string): Promise<void> {
  for await (const filePath of walkJsonlFilesAsync(agentsDir)) {
    const normalized = filePath.replace(/\\/g, "/");
    if (!normalized.includes("/sessions/") || normalized.endsWith(".trajectory.jsonl")) continue;
    const stat = await safeStatAsync(filePath);
    if (stat) sources.push({ agent: "codex", provider: "openclaw", kind: "openclaw-session", path: filePath, ...stat });
  }
}

function walkJsonlFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonlFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
  }
  return files;
}

async function* walkJsonlFilesAsync(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonlFilesAsync(entryPath);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield entryPath;
  }
}

function forEachJsonlLine(filePath: string, visit: (line: string) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return false;
  }

  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  let pending = "";
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      pending += decoder.write(buffer.subarray(0, bytesRead));
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) visit(trimmed);
      }
    } while (bytesRead > 0);
    pending += decoder.end();
    const trimmed = pending.trim();
    if (trimmed) visit(trimmed);
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function safeStat(filePath: string): { mtimeMs: number; fileSize: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, fileSize: stat.size } : null;
  } catch {
    return null;
  }
}

async function safeStatAsync(filePath: string): Promise<{ mtimeMs: number; fileSize: number } | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs, fileSize: stat.size } : null;
  } catch {
    return null;
  }
}

function timestampFrom(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function usageAgentKey(agent: SkillUsageAgent, skillName: string): string {
  return `${agent}:${skillName.trim().toLowerCase()}`;
}

function resolveUsagePath(options: SkillUsageOptions): string {
  if (options.usagePath) return options.usagePath;
  const homeDir = options.homeDir ?? os.homedir();
  return path.join(homeDir, ".claude", "skill-usage.jsonl");
}

function resolveCodexSessionsDir(options: SkillUsageOptions): string | null {
  if (options.codexSessionsDir === null) return null;
  if (options.codexSessionsDir) return options.codexSessionsDir;
  const homeDir = options.homeDir ?? os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  return path.join(codexHome, "sessions");
}
