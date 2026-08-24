import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { StringDecoder } from "node:string_decoder";
import { scanCompleteJsonlAsync } from "./codex-jsonl-stream";
import { isWorkBuddySessionFile } from "./session-loaders/workbuddy-paths";
import {
  CodexToolCallCollector,
  type StructuredToolCall as CodexStructuredToolCall,
} from "./session-loaders/codex-tool-calls";

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
  | "stepcode-session"
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
  | "stepcode-claude"
  | "stepcode-codex"
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
  // Set by claude-hook records and by codex-session scans (from the session's
  // own metadata). Lets a trigger resolve to a session even when the session
  // file moved, which Codex does when it archives a thread.
  sessionId?: string;
  cwd?: string;
  // sha256 of the skill's SKILL.md as it was at trigger time. Claude gets it
  // from the hook; Codex derives it from the skill text that its transcript
  // embeds. Absent means "version unknown".
  skillHash?: string;
}

export interface SkillUsageSource {
  // Kept for persistence compatibility. Events carry the attributed Skill owner.
  agent: SkillUsageAgent;
  provider?: SkillUsageProvider;
  kind: SkillUsageSourceKind;
  path: string;
  mtimeMs: number;
  fileSize: number;
  // Set on claude-session sources by listSkillUsageSources so the reader knows
  // where to find the hook log for skill_hash enrichment. The hook log is the
  // only place the trigger-time SKILL.md hash is captured for Claude; sessions
  // carry no such content, so the hash must be merged in at read time.
  hookLogPath?: string;
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
  includeStepcode?: boolean;
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
  pluginId?: string | null;
  scriptPath?: string | null;
  // Claude only: lets a call be dropped when its result reports an error.
  toolUseId?: string;
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

  const hookLogPath = resolveUsagePath(options);

  addJsonlSources(sources, path.join(homeDir, ".claude", "projects"), "claude", "claude", "claude-session");
  if (options.includeTclaude !== false) {
    addJsonlSources(sources, path.join(homeDir, ".tclaude", "projects"), "claude", "tclaude", "claude-session");
  }

  // Always include the hook source so its skill_hash data can enrich session
  // events at read time. The hook log is the only place the trigger-time
  // SKILL.md hash is captured for Claude; sessions carry no such content.
  const hookStat = safeStat(hookLogPath);
  if (hookStat) {
    sources.push({ agent: "claude", provider: "claude", kind: "claude-hook", path: hookLogPath, ...hookStat });
    // Attach the hook log path to Claude session sources so the reader knows
    // where to look for hash enrichment. tclaude sessions have different
    // session ids and won't match hook records, but setting the path is
    // harmless—the enrichment simply finds no matches.
    for (const source of sources) {
      if (source.kind === "claude-session" && source.provider === "claude") source.hookLogPath = hookLogPath;
    }
  }

  for (const codexSessionsDir of resolveCodexSessionDirs(options)) {
    addJsonlSources(sources, codexSessionsDir, "codex", "codex", "codex-session");
  }
  if (options.includeTcodex !== false) {
    addJsonlSources(sources, path.join(homeDir, ".tcodex", "sessions"), "codex", "tcodex", "codex-session");
  }
  if (options.includeStepcode) {
    addJsonlSources(sources, path.join(homeDir, ".stepcode", "sessions"), "claude", "stepcode-claude", "stepcode-session");
    addJsonlSources(sources, path.join(homeDir, ".stepcode", "codex", "sessions"), "codex", "stepcode-codex", "stepcode-session");
    addJsonlSources(sources, path.join(homeDir, ".stepcode", "codex", "archived_sessions"), "codex", "stepcode-codex", "stepcode-session");
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
  const hookLogPath = resolveUsagePath(options);

  await addJsonlSourcesAsync(sources, path.join(homeDir, ".claude", "projects"), "claude", "claude", "claude-session");
  if (options.includeTclaude !== false) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".tclaude", "projects"), "claude", "tclaude", "claude-session");
  }

  const hookStat = await safeStatAsync(hookLogPath);
  if (hookStat) {
    sources.push({ agent: "claude", provider: "claude", kind: "claude-hook", path: hookLogPath, ...hookStat });
    for (const source of sources) {
      if (source.kind === "claude-session" && source.provider === "claude") source.hookLogPath = hookLogPath;
    }
  }

  for (const codexSessionsDir of resolveCodexSessionDirs(options)) {
    await addJsonlSourcesAsync(sources, codexSessionsDir, "codex", "codex", "codex-session");
  }
  if (options.includeTcodex !== false) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".tcodex", "sessions"), "codex", "tcodex", "codex-session");
  }
  if (options.includeStepcode) {
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".stepcode", "sessions"), "claude", "stepcode-claude", "stepcode-session");
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".stepcode", "codex", "sessions"), "codex", "stepcode-codex", "stepcode-session");
    await addJsonlSourcesAsync(sources, path.join(homeDir, ".stepcode", "codex", "archived_sessions"), "codex", "stepcode-codex", "stepcode-session");
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
  // The hook source no longer emits independent events: its skill_hash data is
  // merged into claude-session events at read time via enrichEventsWithHookHash.
  if (source.kind === "claude-hook") return [];
  if (source.kind.endsWith("-db")) return readDatabaseUsageEvents(source);
  return readSessionFileUsageEvents(source);
}

export async function readSkillUsageSourceEventsAsync(source: SkillUsageSource): Promise<SkillUsageEvent[]> {
  // The hook source no longer emits independent events: its skill_hash data is
  // merged into claude-session events at read time via enrichEventsWithHookHash.
  if (source.kind === "claude-hook") return [];
  if (source.kind.endsWith("-db")) return readDatabaseUsageEvents(source);
  const context: SessionFileContext = { failedToolUseIds: new Set() };
  const events: ScannedUsageEvent[] = [];
  // Codex sessions are scanned as a whole file: the structured tool-call layer
  // must see requests and runtime completions together to deduplicate them.
  const codexRows = source.kind === "codex-session" ? [] as unknown[] : null;
  try {
    await scanCompleteJsonlAsync(source.path, {
      shouldParseLine: (line) => line.length <= 512 * 1024,
      onRecord: (record) => {
        if (codexRows) {
          if (isRecord(record)) collectCodexUsageRecord(record, codexRows, events, context);
          return;
        }
        events.push(...parseSessionUsageRecord(record, source, context));
      },
    });
  } catch {
    return [];
  }
  if (codexRows) events.push(...codexSessionUsageEvents(codexRows, source, context));
  const settled = settleSessionFileEvents(events, context);
  if (source.hookLogPath) enrichEventsWithHookHash(settled, source.hookLogPath);
  return settled;
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

// Merges the hook's skill_hash into Claude session events that describe the
// same trigger. Matching by session id + skill name + a 60-second time window
// keeps the enrichment precise even when a skill is called repeatedly in the
// same session. The hook fires at PostToolUse (after the tool returns), while
// the session timestamp is the transcript line time — the two differ by
// seconds, not minutes.
//
// The hook log is parsed once per refresh cycle and cached by path + mtime so
// that scanning many Claude session files does not re-read the same small file
// each time.
const hookEventCache = new Map<string, { mtimeMs: number; events: SkillUsageEvent[] | null }>();

function readCachedHookEvents(hookLogPath: string): SkillUsageEvent[] | null {
  const stat = safeStat(hookLogPath);
  if (!stat) return null;
  const cached = hookEventCache.get(hookLogPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.events;
  const events = readClaudeUsageEvents(hookLogPath);
  hookEventCache.set(hookLogPath, { mtimeMs: stat.mtimeMs, events });
  return events;
}

function enrichEventsWithHookHash(events: SkillUsageEvent[], hookLogPath: string): void {
  const hookEvents = readCachedHookEvents(hookLogPath);
  if (!hookEvents || hookEvents.length === 0) return;

  const hookBySession = new Map<string, Array<{ event: SkillUsageEvent; used: boolean }>>();
  for (const event of hookEvents) {
    if (!event.sessionId || !event.skillHash) continue;
    const list = hookBySession.get(event.sessionId) ?? [];
    list.push({ event, used: false });
    hookBySession.set(event.sessionId, list);
  }

  for (const event of events) {
    if (event.skillHash || !event.sessionId) continue;
    const candidates = hookBySession.get(event.sessionId);
    if (!candidates) continue;
    let best: { entry: { event: SkillUsageEvent; used: boolean }; diff: number } | null = null;
    for (const entry of candidates) {
      if (entry.used) continue;
      if (entry.event.skill.toLowerCase() !== event.skill.toLowerCase()) continue;
      const diff = Math.abs(entry.event.timestamp - event.timestamp);
      if (diff > 60_000) continue;
      if (!best || diff < best.diff) best = { entry, diff };
    }
    if (best) {
      event.skillHash = best.entry.event.skillHash;
      best.entry.used = true;
    }
  }
}

export function usageForSkill(
  snapshot: SkillUsageSnapshot,
  skillName: string,
  agent?: SkillUsageAgent,
): SkillUsageStat | null {
  if (agent) return snapshot.byAgentName[usageAgentKey(agent, skillName)] ?? null;
  return snapshot.byName[skillName.trim().toLowerCase()] ?? null;
}

function parseUsageLine(line: string): { skill: string; timestamp: number; sessionId?: string; cwd?: string; skillHash?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const skill = parsed.skill;
  if (typeof skill !== "string" || !skill.trim()) return null;
  const sessionId = optionalText((parsed as { session_id?: unknown }).session_id);
  const cwd = optionalText((parsed as { cwd?: unknown }).cwd);
  const skillHash = optionalText((parsed as { skill_hash?: unknown }).skill_hash);
  return {
    skill: skill.trim(),
    timestamp: timestampFrom(parsed.ts),
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(skillHash ? { skillHash } : {}),
  };
}

function optionalText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readSessionFileUsageEvents(source: SkillUsageSource): SkillUsageEvent[] {
  const context: SessionFileContext = { failedToolUseIds: new Set() };
  const events: ScannedUsageEvent[] = [];
  const codexRows = source.kind === "codex-session" ? [] as unknown[] : null;
  forEachJsonlLine(source.path, (line) => {
    if (codexRows) {
      const parsed = parseUsageRecordLine(line);
      if (parsed) collectCodexUsageRecord(parsed, codexRows, events, context);
      return;
    }
    events.push(...parseSessionUsageLine(line, source, context));
  });
  if (codexRows) events.push(...codexSessionUsageEvents(codexRows, source, context));
  const settled = settleSessionFileEvents(events, context);
  if (source.hookLogPath) enrichEventsWithHookHash(settled, source.hookLogPath);
  return settled;
}

// Scanning state that a single trigger cannot carry on its own: Codex keeps the
// session id and cwd in the first line, and Claude reports a failed skill call
// in the tool result that follows the call itself.
interface SessionFileContext {
  sessionId?: string;
  cwd?: string;
  failedToolUseIds: Set<string>;
}

interface ScannedUsageEvent extends SkillUsageEvent {
  toolUseId?: string;
}

// A skill that errored out ("Unknown skill", disabled, ...) was never exercised,
// so it must not count as usage. The result arrives after the call, which is why
// this runs once the whole file has been read.
function settleSessionFileEvents(
  events: ScannedUsageEvent[],
  context: SessionFileContext,
): SkillUsageEvent[] {
  const settled: SkillUsageEvent[] = [];
  for (const { toolUseId, ...event } of events) {
    if (toolUseId && context.failedToolUseIds.has(toolUseId)) continue;
    settled.push(event);
  }
  return settled;
}

// Codex tool usage flows through the structured tool-call layer so requests,
// runtime completions and namespaced tools are each counted once per call.
// Session-level evidence (header ids, skill envelopes) is still collected per
// record while the file streams in.
function collectCodexUsageRecord(
  row: Record<string, unknown>,
  rows: unknown[],
  events: ScannedUsageEvent[],
  context: SessionFileContext,
): void {
  if (readCodexSessionMeta(row, context)) {
    rows.push(row);
    return;
  }
  const timestamp = timestampFrom(row.timestamp ?? row.createdAt ?? row.created_at);
  const envelope = codexSkillEnvelopeEvent(row, timestamp, context);
  if (envelope) events.push(envelope);
  collectFailedToolUseIds(row, context);
  rows.push(row);
}

function codexSessionUsageEvents(
  rows: readonly unknown[],
  source: SkillUsageSource,
  context: SessionFileContext,
): ScannedUsageEvent[] {
  const defaultOwner = source.provider === "codex" || source.provider === "tcodex"
    ? "codex"
    : undefined;
  const collector = new CodexToolCallCollector();
  const packages = new Map<string, string>();
  for (const row of rows) {
    collector.consume(row);
    if (isRecord(row)) collectCodexSkillPackages(row, packages);
  }
  const events: ScannedUsageEvent[] = [];
  for (const call of collector.finish()) {
    if (collector.sessionFormat === "paginated" && call.executionEvidence !== "runtime-confirmed") continue;
    if (call.status === "failed" || call.status === "declined" || call.canonicalName === "exec") continue;
    const callEvents = call.canonicalName === "skills.read"
      ? skillReadUsageEvents(call, packages)
      : usageEventsFromToolCall({
          name: call.canonicalName,
          input: call.input,
          pluginId: call.pluginId,
          scriptPath: call.scriptPath,
        }, call.timestamp, defaultOwner);
    const cwd = call.cwd ?? context.cwd;
    for (const event of callEvents) {
      events.push({
        ...event,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(cwd ? { cwd } : {}),
      });
    }
  }
  return events;
}

function skillReadUsageEvents(
  call: CodexStructuredToolCall,
  packages: Map<string, string>,
): SkillUsageEvent[] {
  const input = parseMaybeJson(call.input);
  if (!isRecord(input) || input.cursor != null) return [];
  const resource = typeof input.resource === "string" ? input.resource.trim() : "";
  if (resource && !/(?:^|[/\\])SKILL\.md$/i.test(resource)) return [];
  const packageId = typeof input.package === "string" ? input.package.trim() : "";
  const skill = packages.get(packageId);
  return skill ? [{ agent: "codex", skill, timestamp: call.timestamp }] : [];
}

function collectCodexSkillPackages(row: Record<string, unknown>, packages: Map<string, string>): void {
  const payload = row.type === "response_item" ? recordField(row, "payload") : null;
  if (
    !payload
    || payload.type !== "message"
    || (payload.role !== "developer" && payload.role !== "system")
    || !Array.isArray(payload.content)
  ) return;
  const body = payload.content
    .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
    .join("\n");
  if (!body.includes("<skills_instructions>")) return;
  const linePattern = /^\s*-\s+(.+?):\s+[^\n]*\((?:executor|orchestrator) package:\s*([^\s)]+)\)\s*$/gim;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(body))) {
    const skill = match[1].replace(/^`|`$/g, "").trim();
    const packageId = match[2].replace(/^`|`$/g, "").trim();
    if (skill && packageId) packages.set(packageId, skill);
  }
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

function parseSessionUsageLine(
  line: string,
  source: SkillUsageSource,
  context: SessionFileContext,
): ScannedUsageEvent[] {
  const parsed = parseUsageRecordLine(line);
  return parsed ? parseSessionUsageRecord(parsed, source, context) : [];
}

function parseSessionUsageRecord(
  parsed: unknown,
  source: SkillUsageSource,
  context: SessionFileContext,
): ScannedUsageEvent[] {
  if (!isRecord(parsed)) return [];

  const timestamp = timestampFrom(parsed.timestamp ?? parsed.createdAt ?? parsed.created_at ?? parsed.ts);
  if (source.kind === "codex-session") return [];
  collectFailedToolUseIds(parsed, context);
  const calls = source.kind === "stepcode-session"
    ? stepCodeToolCalls(parsed)
    : source.kind === "codebuddy-session"
      ? codeBuddyToolCalls(parsed)
      : source.kind === "workbuddy-session"
        ? workBuddyToolCalls(parsed)
        : source.kind === "openclaw-session"
          ? openClawToolCalls(parsed)
          : assistantToolCalls(parsed);
  const defaultOwner = source.provider === "claude" || source.provider === "tclaude" || source.provider === "stepcode-claude"
    ? "claude"
    : source.provider === "codex" || source.provider === "tcodex" || source.provider === "stepcode-codex"
      ? "codex"
      : source.provider === "qoder"
        ? "qoder"
        : undefined;
  // StepCode logs both Claude and Codex turns in one file and tags each record
  // with its own agent, so trust that over the source-level default.
  let owner: SkillUsageAgent | undefined = defaultOwner;
  if (source.kind === "stepcode-session") {
    const recordAgent = optionalText(parsed.agent);
    if (recordAgent === "codex") owner = "codex";
    else if (recordAgent === "claude") owner = "claude";
  }
  const sessionId = optionalText(parsed.sessionId ?? parsed.session_id) || context.sessionId;
  const cwd = optionalText(parsed.cwd) || context.cwd;

  return calls.flatMap((call) => usageEventsFromToolCall(call, timestamp, owner).map((event) => ({
    ...event,
    ...(sessionId ? { sessionId } : {}),
    ...(cwd ? { cwd } : {}),
    ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
  })));
}

// The Codex session header carries the ids that every trigger in the file needs.
function readCodexSessionMeta(row: Record<string, unknown>, context: SessionFileContext): boolean {
  if (row.type !== "session_meta") return false;
  const payload = recordField(row, "payload") ?? row;
  context.sessionId = optionalText(payload.session_id ?? payload.id) || context.sessionId;
  context.cwd = optionalText(payload.cwd) || context.cwd;
  return true;
}

// Codex expands a skill by injecting a synthetic user message that names the
// skill, resolves its SKILL.md path and inlines that file's text. The user's own
// prompt stays a separate record, so merely mentioning a skill never registers
// as a trigger. The inlined text is the file's content plus one trailing
// newline, which makes the trigger-time version hash recoverable from history.
const CODEX_SKILL_ENVELOPE = /^<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>\n([\s\S]*)<\/skill>$/;

function codexSkillEnvelopeEvent(
  row: Record<string, unknown>,
  timestamp: number,
  context: SessionFileContext,
): ScannedUsageEvent | null {
  if (row.type !== "response_item") return null;
  const payload = recordField(row, "payload");
  if (!payload || payload.type !== "message" || payload.role !== "user") return null;
  const content = payload.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
    .join("")
    .trim();
  if (!text.startsWith("<skill>")) return null;
  const match = CODEX_SKILL_ENVELOPE.exec(text);
  if (!match) return null;
  const skill = match[1].trim();
  if (!skill) return null;
  const body = match[3];
  return {
    agent: "codex",
    skill,
    timestamp,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(body.endsWith("\n")
      // Hash the SKILL.md bytes, matching skillMarkdownHash in
      // bin/skill-usage-record.cjs so both agents key versions the same way.
      ? { skillHash: createHash("sha256").update(body.slice(0, -1), "utf8").digest("hex") }
      : {}),
  };
}

function collectFailedToolUseIds(row: Record<string, unknown>, context: SessionFileContext): void {
  const message = recordField(row, "message") ?? row;
  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!isRecord(item) || item.type !== "tool_result" || item.is_error !== true) continue;
    const id = optionalText(item.tool_use_id);
    if (id) context.failedToolUseIds.add(id);
  }
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
    const toolUseId = optionalText(item.id);
    return [{ name: item.name, input: item.input, ...(toolUseId ? { toolUseId } : {}) }];
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

// StepCode logs each tool invocation as a flat `tool.call` record with the tool
// name in `toolName` and the arguments plus outcome under `data`. A call that
// reported an error was never exercised, so it must not count as usage.
function stepCodeToolCalls(row: Record<string, unknown>): StructuredToolCall[] {
  if (row.type !== "tool.call") return [];
  const data = recordField(row, "data");
  if (data?.isError === true) return [];
  const name = typeof row.toolName === "string" ? row.toolName : "";
  if (!name) return [];
  return [{ name, input: data ? data.input : undefined }];
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
    const scriptEvents = usageEventsFromSkillScript(command, timestamp, defaultOwner, call.scriptPath, call.pluginId);
    if (scriptEvents.length) return scriptEvents;
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

function usageEventsFromSkillScript(
  command: string,
  timestamp: number,
  defaultOwner?: SkillUsageAgent,
  attributedScriptPath?: string | null,
  attributedPluginId?: string | null,
): SkillUsageEvent[] {
  const events = new Map<string, SkillUsageEvent>();
  for (const { skill, path: scriptPath } of executedSkillScriptPaths(command, attributedScriptPath, attributedPluginId)) {
    const owner = ownerFromSkillPath(scriptPath) ?? defaultOwner;
    if (owner) events.set(`${owner}:${skill.toLowerCase()}`, { agent: owner, skill, timestamp });
  }
  return [...events.values()];
}

const SCRIPT_INTERPRETERS = new Set([
  "bash", "bun", "deno", "fish", "node", "nodejs", "perl", "php", "py",
  "python", "python2", "python3", "pwsh", "powershell", "ruby", "sh", "zsh",
]);

function executedSkillScriptPaths(
  command: string,
  attributedScriptPath?: string | null,
  attributedPluginId?: string | null,
): Array<{ skill: string; path: string }> {
  const candidates = skillScriptPathsFromText(command);
  if (!command.trim() || candidates.length === 0) return [];

  if (attributedScriptPath && attributedPluginId) {
    const attributed = normalizedCommandToken(attributedScriptPath).toLowerCase();
    const matched = candidates.filter((candidate) => {
      const candidatePath = candidate.path.replace(/\\/g, "/").toLowerCase();
      return candidatePath === attributed || candidatePath.endsWith(`/${attributed}`);
    });
    if (matched.length === 1) return matched;
    if (candidates.length === 1) return candidates;
  }

  const tokens = shellCommandTokens(command);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (commandBaseName(tokens[index]) === "sudo") {
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) index += 1;
  }
  if (commandBaseName(tokens[index]) === "env") {
    index += 1;
    while (index < tokens.length && (tokens[index].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index += 1;
  }

  const executableToken = normalizedCommandToken(tokens[index]);
  const direct = skillScriptPathsFromText(executableToken);
  if (direct.length) return direct;
  const executable = commandBaseName(executableToken);
  if (!SCRIPT_INTERPRETERS.has(executable)) return [];
  index += 1;

  if (executable === "deno") {
    if (commandBaseName(tokens[index]) !== "run") return [];
    index += 1;
  }
  if (executable === "pwsh" || executable === "powershell") {
    const fileFlag = tokens.findIndex((token, tokenIndex) => tokenIndex >= index && /^-file$/i.test(token));
    if (fileFlag >= 0) return skillScriptPathsFromText(normalizedCommandToken(tokens[fileFlag + 1]));
  }

  for (; index < tokens.length; index += 1) {
    const token = normalizedCommandToken(tokens[index]);
    if (!token || token === "--") continue;
    if (/^(?:-c|-e|-m|--command|--eval)$/i.test(token)) return [];
    if (token.startsWith("-")) continue;
    return skillScriptPathsFromText(token);
  }
  return [];
}

function shellCommandTokens(command: string): string[] {
  return command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) ?? [];
}

function normalizedCommandToken(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "").replace(/[;&|]+$/g, "").replace(/\\\//g, "/");
}

function commandBaseName(value: string | undefined): string {
  return normalizedCommandToken(value).split(/[/\\]/).pop()?.replace(/\.exe$/i, "").toLowerCase() ?? "";
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

function skillScriptPathsFromText(text: string): Array<{ skill: string; path: string }> {
  const normalized = text.replace(/\\\//g, "/");
  const matches = new Map<string, { skill: string; path: string }>();
  const pattern = /([^\s"'`]*[/\\]skills[/\\])([^/\\\s"'`]+)[/\\]scripts[/\\][^\s"'`]+/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized))) {
    const skill = match[2];
    const scriptPath = match[0];
    matches.set(`${skill.toLowerCase()}\0${scriptPath.toLowerCase()}`, { skill, path: scriptPath });
  }
  return [...matches.values()];
}

// Maps a SKILL.md path back to the agent that owns it. Codex resolves plugin
// skills under `plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/`,
// which is why a plain `/.codex/skills/` check is not enough.
function ownerFromSkillPath(skillPath: string): SkillUsageAgent | null {
  const normalized = skillPath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/.claude/skills/")) return "claude";
  if (normalized.includes("/.qoder/skills/")) return "qoder";
  if (normalized.includes("/.codex/skills/") || normalized.includes("/.agents/skills/")) return "codex";
  if (normalized.includes("/.codex/plugins/")) return "codex";
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

// Codex keeps live threads in `sessions/` and moves older ones into a sibling
// `archived_sessions/`. Archiving must not make a recorded trigger disappear,
// so both directories are scanned.
function resolveCodexSessionDirs(options: SkillUsageOptions): string[] {
  if (options.codexSessionsDir === null) return [];
  const sessionsDir = options.codexSessionsDir
    || path.join(process.env.CODEX_HOME?.trim() || path.join(options.homeDir ?? os.homedir(), ".codex"), "sessions");
  return [sessionsDir, path.join(path.dirname(sessionsDir), "archived_sessions")];
}
