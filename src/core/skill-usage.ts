import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Aggregates skill usage from two local sources:
// - Claude Code PostToolUse hook records in ~/.claude/skill-usage.jsonl.
// - Codex function_call arguments that reference a */SKILL.md file in
//   ~/.codex/sessions/**/*.jsonl.

export interface SkillUsageStat {
  skill: string;
  count: number;
  lastUsedAt: number;
}

export type SkillUsageAgent = "codex" | "claude" | "qoder";
export type SkillUsageSourceKind = "claude-hook" | "codex-session";

export interface SkillUsageEvent {
  agent: SkillUsageAgent;
  skill: string;
  timestamp: number;
}

export interface SkillUsageSource {
  agent: SkillUsageAgent;
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

export function skillUsageSnapshotFromEvents(events: SkillUsageEvent[], usagePath = "", exists = events.length > 0): SkillUsageSnapshot {
  const byKey = new Map<string, SkillUsageStat>();
  const byAgentKey = new Map<string, SkillUsageStat>();
  addUsageEvents(byKey, byAgentKey, events);
  const byName: Record<string, SkillUsageStat> = {};
  for (const [key, stat] of byKey) byName[key] = stat;
  const byAgentName: Record<string, SkillUsageStat> = {};
  for (const [key, stat] of byAgentKey) byAgentName[key] = stat;
  const stats = [...byKey.values()].sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt || a.skill.localeCompare(b.skill));

  return { path: usagePath, exists, totalEvents: events.length, stats, byName, byAgentName };
}

export function listSkillUsageSources(options: SkillUsageOptions = {}): SkillUsageSource[] {
  const sources: SkillUsageSource[] = [];
  const usagePath = resolveUsagePath(options);
  const claudeStat = safeStat(usagePath);
  if (claudeStat) {
    sources.push({ agent: "claude", kind: "claude-hook", path: usagePath, ...claudeStat });
  }

  const codexSessionsDir = resolveCodexSessionsDir(options);
  if (codexSessionsDir) {
    for (const filePath of walkJsonlFiles(codexSessionsDir)) {
      const stat = safeStat(filePath);
      if (stat) sources.push({ agent: "codex", kind: "codex-session", path: filePath, ...stat });
    }
  }

  return sources;
}

export function readSkillUsageSourceEvents(source: SkillUsageSource): SkillUsageEvent[] {
  if (source.kind === "claude-hook") return readClaudeUsageEvents(source.path) ?? [];
  return readCodexSessionFileUsageEvents(source.path);
}

function addUsageEvents(byKey: Map<string, SkillUsageStat>, byAgentKey: Map<string, SkillUsageStat>, events: SkillUsageEvent[]): number {
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
  let raw: string;
  try {
    raw = fs.readFileSync(usagePath, "utf8");
  } catch {
    return null;
  }

  const events: SkillUsageEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const event = parseUsageLine(trimmed);
    if (!event) continue;
    events.push({ ...event, agent: "claude" });
  }
  return events;
}

// Looks up a usage stat by skill name, case-insensitively, matching how the
// hook records names regardless of capitalization differences across sources.
export function usageForSkill(snapshot: SkillUsageSnapshot, skillName: string, agent?: SkillUsageAgent): SkillUsageStat | null {
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
  if (!parsed || typeof parsed !== "object") return null;
  const skill = (parsed as { skill?: unknown }).skill;
  if (typeof skill !== "string" || !skill.trim()) return null;
  const ts = (parsed as { ts?: unknown }).ts;
  const timestamp = typeof ts === "string" ? Date.parse(ts) : NaN;
  return { skill: skill.trim(), timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
}

function readCodexSessionUsageEvents(sessionsDir: string): SkillUsageEvent[] {
  const events: SkillUsageEvent[] = [];
  for (const filePath of walkJsonlFiles(sessionsDir)) {
    events.push(...readCodexSessionFileUsageEvents(filePath));
  }
  return events;
}

function readCodexSessionFileUsageEvents(filePath: string): SkillUsageEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: SkillUsageEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const eventRows = parseCodexUsageLine(line);
    events.push(...eventRows);
  }
  return events;
}

function parseCodexUsageLine(line: string): SkillUsageEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || parsed.type !== "response_item") return [];
  const payload = recordField(parsed, "payload");
  if (!payload || payload.type !== "function_call") return [];

  if (!isCodexSkillReadFunction(payload.name)) return [];
  const skillNames = skillNamesFromText(codexCommandText(payload.arguments));
  if (skillNames.length === 0) return [];
  const timestamp = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
  return skillNames.map((skill) => ({ agent: "codex", skill, timestamp: Number.isFinite(timestamp) ? timestamp : 0 }));
}

function isCodexSkillReadFunction(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes("apply_patch") || normalized.includes("patch") || normalized.includes("write") || normalized.includes("edit")) {
    return false;
  }
  return normalized.includes("exec") || normalized.includes("command") || normalized.includes("shell");
}

function codexCommandText(argumentsValue: unknown): string {
  const args = parseMaybeJson(argumentsValue);
  if (!isRecord(args)) return "";
  const cmd = args.cmd;
  if (typeof cmd === "string" && cmd) return cmd;
  const command = args.command;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((item): item is string => typeof item === "string").join(" ");
  return "";
}

function skillNamesFromText(text: string): string[] {
  const normalized = text.replace(/\\\//g, "/");
  const names = new Set<string>();
  const pattern = /([^/\\\s"'`]+)[/\\]SKILL\.md\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function recordField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return isRecord(field) ? field : null;
}

function safeStat(filePath: string): { mtimeMs: number; fileSize: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, fileSize: stat.size };
  } catch {
    return null;
  }
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
  return path.join(homeDir, ".codex", "sessions");
}
