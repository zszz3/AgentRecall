import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIVE_SESSION_SNAPSHOT_CACHE_TTL_MS } from "./refresh-policy";
import { encodeCursorWorkspaceSlug } from "./session-loader";
import type { LiveSession, LiveSessionFamily, LiveSessionSnapshot } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => import("node:sqlite").DatabaseSync };
const CLAUDE_SESSION_START_SKEW_MS = 2 * 60 * 1000;

type ProcessListRunner = (command: string, args: string[]) => Promise<string>;
type LiveSessionSnapshotLoader = (options?: LoadLiveSessionOptions) => Promise<LiveSessionSnapshot>;

interface ProcessEntry {
  pid: number;
  command: string;
}

interface ClaudeSessionCandidate {
  filePath: string;
  rawId: string;
  createdAtMs: number;
  modifiedAtMs: number;
}

interface PendingClaudeProcess {
  pid: number;
  cwd: string;
  startedAtMs: number | null;
}

export interface LoadLiveSessionOptions {
  platform?: NodeJS.Platform;
  runner?: ProcessListRunner;
  now?: Date;
  includeTrae?: boolean;
  includeQoder?: boolean;
  includeOpenClaw?: boolean;
  includeHermes?: boolean;
  includeOpenCode?: boolean;
  includeZcode?: boolean;
  includeCursor?: boolean;
  includeCodeBuddy?: boolean;
  includeCodeWiz?: boolean;
  homeDir?: string;
}

export interface CachedLiveSessionSnapshotLoaderOptions {
  ttlMs?: number;
  nowMs?: () => number;
  load?: LiveSessionSnapshotLoader;
}

export function createCachedLiveSessionSnapshotLoader({
  ttlMs = LIVE_SESSION_SNAPSHOT_CACHE_TTL_MS,
  nowMs = Date.now,
  load = loadLiveSessionSnapshot,
}: CachedLiveSessionSnapshotLoaderOptions = {}): LiveSessionSnapshotLoader {
  const cache = new Map<string, { expiresAt: number; promise: Promise<LiveSessionSnapshot> }>();
  return (options: LoadLiveSessionOptions = {}) => {
    const key = liveSessionSnapshotCacheKey(options);
    const now = nowMs();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;

    const promise = load(options);
    cache.set(key, { expiresAt: now + ttlMs, promise });
    void promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  };
}

export function detectLiveSessionsFromProcessLines(
  lines: string[],
  codexSessionFilesByPid: Map<number, string> = new Map(),
  claudeSessionFilesByPid: Map<number, string> = new Map(),
  traeSessionIdsByPid: Map<number, string> = new Map(),
  qoderSessionIdsByPid: Map<number, string> = new Map(),
  openclawSessionFilesByPid: Map<number, string> = new Map(),
  cursorSessionFilesByPid: Map<number, string> = new Map(),
  codebuddySessionFilesByPid: Map<number, string> = new Map(),
  dbSessionIdsByPid: Map<number, string> = new Map(),
): LiveSession[] {
  const sessions: LiveSession[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const entry = parseProcessLine(line);
    if (!entry) continue;

    const tokens = splitCommandLine(entry.command);
    const command =
      detectResumeCommand(tokens) ??
      detectPlainCodexCommand(tokens, codexSessionFilesByPid.get(entry.pid)) ??
      detectPlainClaudeCommand(tokens, claudeSessionFilesByPid.get(entry.pid)) ??
      detectPlainOpenClawCommand(tokens, openclawSessionFilesByPid.get(entry.pid)) ??
      detectPlainCursorCommand(tokens, cursorSessionFilesByPid.get(entry.pid)) ??
      detectPlainCodeBuddyCommand(tokens, codebuddySessionFilesByPid.get(entry.pid)) ??
      detectDbBackedCommand(tokens, dbSessionIdsByPid.get(entry.pid)) ??
      detectTraeAppSession(entry.command, traeSessionIdsByPid.get(entry.pid)) ??
      detectQoderAppSession(entry.command, qoderSessionIdsByPid.get(entry.pid));
    if (!command) continue;

    const key = `${command.family}:${command.rawId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push({ ...command, pid: entry.pid });
  }

  return sessions;
}

function liveSessionSnapshotCacheKey(options: LoadLiveSessionOptions): string {
  return JSON.stringify({
    platform: options.platform ?? process.platform,
    includeTrae: options.includeTrae !== false,
    includeQoder: options.includeQoder !== false,
    includeOpenClaw: options.includeOpenClaw !== false,
    includeHermes: options.includeHermes !== false,
    includeOpenCode: options.includeOpenCode !== false,
    includeZcode: options.includeZcode !== false,
    includeCursor: options.includeCursor !== false,
    includeCodeBuddy: options.includeCodeBuddy !== false,
    includeCodeWiz: options.includeCodeWiz !== false,
    homeDir: options.homeDir ?? os.homedir(),
  });
}

export async function loadLiveSessionSnapshot(options: LoadLiveSessionOptions = {}): Promise<LiveSessionSnapshot> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? execText;

  try {
    const output =
      platform === "win32"
        ? await runner("powershell.exe", [
            "-NoProfile",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { "{0} {1}" -f $_.ProcessId, $_.CommandLine } }',
          ])
        : await runner("/bin/ps", ["-axo", "pid=,command="]);
    const lines = output.split(/\r?\n/);
    const [codexSessionFilesByPid, claudeSessionFilesByPid] =
      platform === "win32"
        ? [new Map<number, string>(), new Map<number, string>()]
        : await Promise.all([
            loadPlainCodexSessionFiles(lines, runner, options.homeDir ?? os.homedir()),
            loadPlainClaudeSessionFiles(lines, runner, options.homeDir ?? os.homedir()),
          ]);
    const traeSessionIdsByPid =
      platform === "win32" || options.includeTrae === false ? new Map<number, string>() : await loadTraeSessionIds(lines, runner);
    const qoderSessionIdsByPid =
      platform === "win32" || options.includeQoder === false ? new Map<number, string>() : await loadQoderSessionIds(lines, runner);
    const openclawSessionFilesByPid =
      platform === "win32" || options.includeOpenClaw === false ? new Map<number, string>() : await loadOpenClawSessionFiles(lines, runner);
    const cursorSessionFilesByPid =
      platform === "win32" || options.includeCursor === false
        ? new Map<number, string>()
        : await loadCursorSessionFiles(lines, runner, options.homeDir ?? os.homedir());
    const codebuddySessionFilesByPid =
      platform === "win32" || options.includeCodeBuddy === false
        ? new Map<number, string>()
        : await loadCodeBuddySessionFiles(lines, runner, options.homeDir ?? os.homedir());
    const dbSessionIdsByPid =
      platform === "win32" ||
      (options.includeHermes === false &&
        options.includeOpenCode === false &&
        options.includeZcode === false &&
        options.includeCodeWiz === false)
        ? new Map<number, string>()
        : await loadDbSessionIds(lines, runner, {
            includeHermes: options.includeHermes !== false,
            includeOpenCode: options.includeOpenCode !== false,
            includeZcode: options.includeZcode !== false,
            includeCodeWiz: options.includeCodeWiz !== false,
          });

    return {
      generatedAt,
      sessions: detectLiveSessionsFromProcessLines(
        lines,
        codexSessionFilesByPid,
        claudeSessionFilesByPid,
        traeSessionIdsByPid,
        qoderSessionIdsByPid,
        openclawSessionFilesByPid,
        cursorSessionFilesByPid,
        codebuddySessionFilesByPid,
        dbSessionIdsByPid,
      ),
    };
  } catch (error) {
    return {
      generatedAt,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadPlainCodexSessionFiles(lines: string[], runner: ProcessListRunner, homeDir = os.homedir()): Promise<Map<number, string>> {
  return loadPlainSessionFilesWithCwdFallback(
    lines,
    runner,
    isPlainCodexCommand,
    extractCodexSessionFile,
    homeDir,
    (home, cwd) => findMostRecentCodexSessionByCwd(home, cwd),
  );
}

/**
 * Codex sessions live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * and the first line of each file is session_meta with a `cwd` field. Walk recent
 * session files and return the most recently modified one whose cwd matches.
 */
function findMostRecentCodexSessionByCwd(homeDir: string, cwd: string): string | null {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  let best: { filePath: string; mtimeMs: number } | null = null;
  const consider = (filePath: string, mtimeMs: number): void => {
    if (best !== null && mtimeMs <= (best as { mtimeMs: number }).mtimeMs) return;
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
        if (!firstLine) return;
        const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } };
        if (meta?.payload?.cwd !== cwd) return;
        best = { filePath, mtimeMs };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Not a parseable session file; skip.
    }
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const stat = fs.statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      consider(full, stat.mtimeMs);
    }
  };
  walk(sessionsRoot, 0);
  return best === null ? null : (best as { filePath: string }).filePath;
}

async function loadPlainClaudeSessionFiles(lines: string[], runner: ProcessListRunner, homeDir = os.homedir()): Promise<Map<number, string>> {
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const plainPids = entries.filter((entry) => isPlainClaudeCommand(splitCommandLine(entry.command))).map((entry) => entry.pid);
  const claimedRawIds = new Set(
    entries
      .map((entry) => detectResumeCommand(splitCommandLine(entry.command)))
      .filter((command): command is { family: LiveSessionFamily; rawId: string } => command?.family === "claude")
      .map((command) => command.rawId),
  );
  const sessionFiles = new Map<number, string>();
  const pending: PendingClaudeProcess[] = [];

  const inspections = await Promise.all(
    plainPids.map(async (pid) => {
      try {
        const lsofOutput = await runner("lsof", ["-p", String(pid)]);
        const sessionFile = extractClaudeSessionFile(lsofOutput);
        if (sessionFile) return { pid, sessionFile, cwd: null, startedAtMs: null };
        const cwd = extractProcessCwd(lsofOutput);
        if (!cwd) return null;
        return { pid, sessionFile: null, cwd, startedAtMs: await loadProcessStartedAtMs(pid, runner) };
      } catch {
        return null;
      }
    }),
  );

  for (const inspection of inspections) {
    if (!inspection) continue;
    if (inspection.sessionFile) {
      sessionFiles.set(inspection.pid, inspection.sessionFile);
      const rawId = extractClaudeSessionId(inspection.sessionFile);
      if (rawId) claimedRawIds.add(rawId);
    } else if (inspection.cwd) {
      pending.push({ pid: inspection.pid, cwd: inspection.cwd, startedAtMs: inspection.startedAtMs });
    }
  }

  const candidatesByCwd = new Map<string, ClaudeSessionCandidate[]>();
  for (const process of pending) {
    if (!candidatesByCwd.has(process.cwd)) candidatesByCwd.set(process.cwd, listClaudeSessionCandidates(homeDir, process.cwd));
  }

  const matches = pending.flatMap((process) =>
    (candidatesByCwd.get(process.cwd) ?? [])
      .filter((candidate) => !claimedRawIds.has(candidate.rawId))
      .filter(
        (candidate) =>
          process.startedAtMs === null ||
          candidate.createdAtMs >= process.startedAtMs - CLAUDE_SESSION_START_SKEW_MS ||
          candidate.modifiedAtMs >= process.startedAtMs - CLAUDE_SESSION_START_SKEW_MS,
      )
      .map((candidate) => {
        const createdForProcess =
          process.startedAtMs === null || candidate.createdAtMs >= process.startedAtMs - CLAUDE_SESSION_START_SKEW_MS;
        const distanceMs =
          process.startedAtMs === null
            ? -candidate.modifiedAtMs
            : Math.abs((createdForProcess ? candidate.createdAtMs : candidate.modifiedAtMs) - process.startedAtMs);
        return { process, candidate, fallbackRank: createdForProcess ? 0 : 1, distanceMs };
      }),
  );
  matches.sort((left, right) => left.fallbackRank - right.fallbackRank || left.distanceMs - right.distanceMs);

  const assignedPids = new Set<number>();
  for (const match of matches) {
    if (assignedPids.has(match.process.pid) || claimedRawIds.has(match.candidate.rawId)) continue;
    sessionFiles.set(match.process.pid, match.candidate.filePath);
    assignedPids.add(match.process.pid);
    claimedRawIds.add(match.candidate.rawId);
  }

  return sessionFiles;
}

async function loadPlainSessionFiles(
  lines: string[],
  runner: ProcessListRunner,
  isPlainCommand: (tokens: string[]) => boolean,
  extractSessionFile: (lsofOutput: string) => string | null,
  fallbackSessionFile?: (pid: number, lsofOutput: string) => Promise<string | null> | string | null,
): Promise<Map<number, string>> {
  const sessionFiles = new Map<number, string>();
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const pids = entries.filter((entry) => isPlainCommand(splitCommandLine(entry.command))).map((entry) => entry.pid);

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const lsofOutput = await runner("lsof", ["-p", String(pid)]);
        const sessionFile = extractSessionFile(lsofOutput) ?? (await fallbackSessionFile?.(pid, lsofOutput));
        if (sessionFile) sessionFiles.set(pid, sessionFile);
      } catch {
        // A process can exit between ps and lsof; ignore it and keep the rest.
      }
    }),
  );

  return sessionFiles;
}

async function loadProcessStartedAtMs(pid: number, runner: ProcessListRunner): Promise<number | null> {
  try {
    const startedAtMs = Date.parse((await runner("/bin/ps", ["-o", "lstart=", "-p", String(pid)])).trim());
    return Number.isFinite(startedAtMs) ? startedAtMs : null;
  } catch {
    return null;
  }
}

function listClaudeSessionCandidates(homeDir: string, cwd: string): ClaudeSessionCandidate[] {
  const projectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectDir(cwd));
  const candidates: ClaudeSessionCandidate[] = [];

  try {
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(projectDir, entry.name);
      const stat = fs.statSync(filePath);
      const rawId = extractClaudeSessionId(filePath);
      if (!rawId) continue;
      candidates.push({
        filePath,
        rawId,
        createdAtMs: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs,
        modifiedAtMs: stat.mtimeMs,
      });
    }
  } catch {
    return [];
  }

  return candidates;
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

async function loadTraeSessionIds(lines: string[], runner: ProcessListRunner): Promise<Map<number, string>> {
  const sessionIds = new Map<number, string>();
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const pids = entries.filter((entry) => isTraeAppCommand(entry.command)).map((entry) => entry.pid);

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const output = await runner("lsof", ["-p", String(pid)]);
        const stateDbPath = extractTraeStateDbPath(output);
        if (!stateDbPath) return;
        const rawId = readTraeCurrentSessionRawId(stateDbPath);
        if (rawId) sessionIds.set(pid, rawId);
      } catch {
        // Trae can rotate workspaces or exit between ps and lsof; keep the rest.
      }
    }),
  );

  return sessionIds;
}

function parseProcessLine(line: string): ProcessEntry | null {
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!match) return null;

  const pid = Number(match[1]);
  const command = match[2]?.trim();
  if (!Number.isFinite(pid) || !command) return null;

  return { pid, command };
}

function detectResumeCommand(tokens: string[]): { family: LiveSessionFamily; rawId: string } | null {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (!family) continue;

    const args = tokens.slice(index + 1);
    const rawId = family === "codex" || family === "tcodex" ? codexResumeId(args) : flagResumeId(args);
    if (rawId) return { family, rawId };
  }

  return null;
}

function detectPlainCodexCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || !isPlainCodexCommand(tokens)) return null;
  const rawId = extractCodexSessionId(sessionFile);
  return rawId ? { family: "codex", rawId } : null;
}

function detectPlainClaudeCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || !isPlainClaudeCommand(tokens)) return null;
  const rawId = extractClaudeSessionId(sessionFile);
  return rawId ? { family: "claude", rawId } : null;
}

function detectPlainOpenClawCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || !isPlainOpenClawCommand(tokens)) return null;
  const rawId = extractOpenClawSessionId(sessionFile);
  return rawId ? { family: "openclaw", rawId } : null;
}

function detectPlainCursorCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || !isPlainCursorCommand(tokens)) return null;
  const rawId = extractCursorSessionId(sessionFile);
  return rawId ? { family: "cursor", rawId } : null;
}

function detectPlainCodeBuddyCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || !isPlainCodeBuddyCommand(tokens)) return null;
  const rawId = extractCodeBuddySessionId(sessionFile);
  return rawId ? { family: "codebuddy", rawId } : null;
}

function detectDbBackedCommand(tokens: string[], rawId: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!rawId) return null;
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];
  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family === "hermes" || family === "opencode" || family === "zcode") return { family, rawId };
  }
  return null;
}

function detectTraeAppSession(command: string, rawId: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!rawId || !isTraeAppCommand(command)) return null;
  return { family: "trae", rawId };
}

function isPlainCodexCommand(tokens: string[]): boolean {
  if (isNodeExecutable(tokens[0])) return false;
  const commandStartIndexes = [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "codex") continue;
    if (isCodexDesktopProcess(tokens[index])) return false;
    const args = tokens.slice(index + 1);
    if (args.includes("resume")) return false;
    if (args[0] === "app-server") return false;
    return true;
  }

  return false;
}

function isPlainClaudeCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "claude") continue;
    const args = tokens.slice(index + 1);
    if (flagResumeId(args)) return false;
    return true;
  }

  return false;
}

function isPlainOpenClawCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "openclaw") continue;
    const args = tokens.slice(index + 1);
    if (flagResumeId(args)) return false;
    return true;
  }

  return false;
}

function isPlainCursorCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "cursor") continue;
    const args = tokens.slice(index + 1);
    if (flagResumeId(args)) return false;
    return true;
  }

  return false;
}

function isPlainCodeBuddyCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "codebuddy") continue;
    const args = tokens.slice(index + 1);
    if (flagResumeId(args)) return false;
    return true;
  }

  return false;
}

function isDbBackedCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family === "hermes" || family === "opencode" || family === "zcode" || family === "codewiz") return true;
  }

  return false;
}

function isCodexDesktopProcess(token: string | undefined): boolean {
  if (!token) return false;
  const lower = token.toLowerCase();
  if (lower.includes("/.codex/computer-use/")) return true;
  return lower.includes(".app/contents/") && !lower.includes("/contents/resources/codex");
}

function codexResumeId(args: string[]): string | null {
  const resumeIndex = args.findIndex((arg) => arg === "resume");
  if (resumeIndex < 0) return null;
  const rawId = args[resumeIndex + 1]?.trim();
  return rawId && !rawId.startsWith("-") ? rawId : null;
}

function flagResumeId(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--resume" || arg === "-r") {
      const rawId = args[index + 1]?.trim();
      if (rawId && !rawId.startsWith("-")) return rawId;
    }
    if (arg.startsWith("--resume=")) {
      const rawId = arg.slice("--resume=".length).trim();
      if (rawId) return rawId;
    }
  }

  return null;
}

function executableFamily(token: string | undefined): LiveSessionFamily | null {
  if (!token) return null;
  const normalized = normalizedExecutableName(token);
  if (normalized === "codex") return "codex";
  if (normalized === "tcodex") return "tcodex";
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "tclaude") return "tclaude";
  if (normalized === "codebuddy" || normalized === "cbc") return "codebuddy";
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "hermes") return "hermes";
  if (normalized === "opencode") return "opencode";
  if (normalized === "zcode") return "zcode";
  if (normalized === "cursor-agent") return "cursor";

  const lower = token.toLowerCase();
  if (lower.includes("@openai/codex")) return "codex";
  if (lower.includes("@anthropic-ai/claude") || lower.includes("claude-code")) return "claude";
  if (lower.includes("codebuddy")) return "codebuddy";
  if (lower.includes("openclaw")) return "openclaw";
  if (lower.includes("hermes")) return "hermes";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("zcode")) return "zcode";
  if (lower.includes("cursor-agent")) return "cursor";
  return null;
}

function isTraeAppCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return (
    lower.includes("trae") &&
    (lower.includes(".app") || lower.includes("--user-data-dir") || lower.includes("trae cn") || lower.includes("trae.exe"))
  );
}

function isNodeExecutable(token: string | undefined): boolean {
  const normalized = normalizedExecutableName(token);
  return normalized === "node" || normalized === "nodejs";
}

function normalizedExecutableName(token: string | undefined): string {
  if (!token) return "";
  const name = token.replace(/^['"]|['"]$/g, "").split(/[\\/]/).pop()?.toLowerCase() || "";
  return name.replace(/\.(?:js|cjs|mjs|cmd|exe)$/i, "");
}

function extractCodexSessionId(sessionFile: string): string | null {
  return sessionFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? null;
}

function extractCodexSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.codex\/sessions\/\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractClaudeSessionId(sessionFile: string): string | null {
  const rawId = sessionFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "").trim();
  return rawId || null;
}

function extractClaudeSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.claude\/projects\/\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractOpenClawSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.(?:openclaw|clawdbot)\/agents\/\S+?\/sessions\/\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractOpenClawSessionId(sessionFile: string): string | null {
  const rawId = sessionFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "").trim();
  return rawId || null;
}

function extractCursorSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.cursor\/projects\/\S+?\/agent-transcripts\/\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractCursorSessionId(sessionFile: string): string | null {
  const rawId = sessionFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "").trim();
  return rawId || null;
}

function extractCodeBuddySessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.codebuddy\/projects\/\S+?\/tool-results\/\S+?\.txt)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractCodeBuddySessionId(sessionFile: string): string | null {
  const match = sessionFile.match(/\.codebuddy\/projects\/[^/]+\/([^/]+)\/tool-results\//);
  return match?.[1] ?? null;
}

function extractHermesDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.hermes\/state\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractOpenCodeDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.local\/share\/opencode\/opencode\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractZcodeDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.zcode\/cli\/db\/db\.sqlite)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractCodeWizDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*\.local\/share\/codewiz\/opencode\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractProcessCwd(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!/\s+cwd\s+/.test(line)) continue;
    const start = line.indexOf("/");
    if (start >= 0) return line.slice(start).trim();
  }
  return null;
}

function extractTraeStateDbPath(lsofOutput: string): string | null {
  const candidates: string[] = [];
  for (const line of lsofOutput.split(/\r?\n/)) {
    const end = line.indexOf("state.vscdb");
    if (end < 0) continue;
    const start = line.indexOf("/");
    if (start < 0) continue;
    candidates.push(line.slice(start, end + "state.vscdb".length));
  }
  return candidates.find((candidate) => candidate.includes("workspaceStorage")) ?? candidates[0] ?? null;
}

function readTraeCurrentSessionRawId(stateDbPath: string): string | null {
  try {
    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
        .get("memento/icube-ai-agent-storage") as { value?: unknown } | undefined;
      const sessionId = typeof row?.value === "string" ? extractTraeCurrentSessionId(JSON.parse(row.value)) : null;
      return sessionId ? normalizeTraeSessionRawId(sessionId) : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function extractTraeCurrentSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  if ("currentSessionId" in value && typeof value.currentSessionId === "string") return value.currentSessionId;
  for (const child of Object.values(value)) {
    const sessionId = extractTraeCurrentSessionId(child);
    if (sessionId) return sessionId;
  }
  return null;
}

function normalizeTraeSessionRawId(sessionId: string): string {
  return sessionId.startsWith("session_memory_") ? sessionId : `session_memory_${sessionId}`;
}

function isQoderAppCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return (
    lower.includes("qoder") &&
    (lower.includes(".app") || lower.includes("--user-data-dir") || lower.includes("qoder.exe"))
  );
}

function detectQoderAppSession(command: string, rawId: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!rawId || !isQoderAppCommand(command)) return null;
  return { family: "qoder", rawId };
}

async function loadOpenClawSessionFiles(lines: string[], runner: ProcessListRunner): Promise<Map<number, string>> {
  return loadPlainSessionFiles(lines, runner, isPlainOpenClawCommand, extractOpenClawSessionFile);
}

async function loadCursorSessionFiles(lines: string[], runner: ProcessListRunner, homeDir = os.homedir()): Promise<Map<number, string>> {
  return loadPlainSessionFilesWithCwdFallback(
    lines,
    runner,
    isPlainCursorCommand,
    extractCursorSessionFile,
    homeDir,
    (home, cwd) => {
      // cursor: ~/.cursor/projects/<slug>/agent-transcripts/<sessionId>/<sessionId>.jsonl
      const slug = encodeCursorWorkspaceSlug(cwd);
      const transcriptsDir = path.join(home, ".cursor", "projects", slug, "agent-transcripts");
      const sessionId = findMostRecentSessionDirWithJsonl(transcriptsDir);
      if (!sessionId) return null;
      return path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`);
    },
  );
}

async function loadCodeBuddySessionFiles(lines: string[], runner: ProcessListRunner, homeDir = os.homedir()): Promise<Map<number, string>> {
  return loadPlainSessionFilesWithCwdFallback(
    lines,
    runner,
    isPlainCodeBuddyCommand,
    extractCodeBuddySessionFile,
    homeDir,
    (home, cwd) => {
      const sessionId = findMostRecentCodeBuddySessionId(home, cwd);
      if (!sessionId) return null;
      return path.join(home, ".codebuddy", "projects", encodeProjectDirSlug(cwd), sessionId, "tool-results", "fallback.txt");
    },
  );
}

/**
 * Generic loader: try lsof to find an open session file; if lsof cannot see other
 * processes' regular files (e.g. restricted environments like Electron main), fall
 * back to using the process cwd and inferring the session from the project dir.
 */
async function loadPlainSessionFilesWithCwdFallback(
  lines: string[],
  runner: ProcessListRunner,
  isPlainCommand: (tokens: string[]) => boolean,
  extractSessionFile: (lsofOutput: string) => string | null,
  homeDir: string,
  buildFallbackPath: (homeDir: string, cwd: string) => string | null,
): Promise<Map<number, string>> {
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const plainPids = entries.filter((entry) => isPlainCommand(splitCommandLine(entry.command))).map((entry) => entry.pid);
  const sessionFiles = new Map<number, string>();
  const pendingCwds: Array<{ pid: number; cwd: string }> = [];

  await Promise.all(
    plainPids.map(async (pid) => {
      try {
        const lsofOutput = await runner("lsof", ["-p", String(pid)]);
        const sessionFile = extractSessionFile(lsofOutput);
        if (sessionFile) {
          sessionFiles.set(pid, sessionFile);
          return;
        }
        const cwd = extractProcessCwd(lsofOutput);
        if (cwd) pendingCwds.push({ pid, cwd });
      } catch {
        // Process may exit between ps and lsof; ignore.
      }
    }),
  );

  for (const { pid, cwd } of pendingCwds) {
    const fallback = buildFallbackPath(homeDir, cwd);
    if (fallback) sessionFiles.set(pid, fallback);
  }

  return sessionFiles;
}

function encodeProjectDirSlug(cwd: string): string {
  return cwd.replace(/^\/+/, "").replace(/\//g, "-");
}

function findMostRecentCodeBuddySessionId(homeDir: string, cwd: string): string | null {
  const projectDir = path.join(homeDir, ".codebuddy", "projects", encodeProjectDirSlug(cwd));
  try {
    let best: { sessionId: string; mtimeMs: number } | null = null;
    for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
      const toolResultsDir = path.join(projectDir, entry.name, "tool-results");
      const stat = fs.statSync(toolResultsDir, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { sessionId: entry.name, mtimeMs: stat.mtimeMs };
    }
    return best?.sessionId ?? null;
  } catch {
    return null;
  }
}

/**
 * Returns the name of the most recently modified subdirectory under `dir` that
 * itself contains a `<dirname>.jsonl` file (e.g. cursor's agent-transcripts layout).
 */
function findMostRecentSessionDirWithJsonl(dir: string): string | null {
  try {
    let best: { name: string; mtimeMs: number } | null = null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const jsonlPath = path.join(dir, entry.name, `${entry.name}.jsonl`);
      const stat = fs.statSync(jsonlPath, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { name: entry.name, mtimeMs: stat.mtimeMs };
    }
    return best?.name ?? null;
  } catch {
    return null;
  }
}

async function loadDbSessionIds(
  lines: string[],
  runner: ProcessListRunner,
  options: { includeHermes: boolean; includeOpenCode: boolean; includeZcode: boolean; includeCodeWiz: boolean },
): Promise<Map<number, string>> {
  const sessionIds = new Map<number, string>();
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));

  const pidsByDbPath = new Map<string, number[]>();
  for (const entry of entries) {
    if (!isDbBackedCommand(splitCommandLine(entry.command))) continue;
    const dbPath = await findDbPathForProcess(entry.pid, entry.command, runner, options);
    if (!dbPath) continue;
    const list = pidsByDbPath.get(dbPath) ?? [];
    list.push(entry.pid);
    pidsByDbPath.set(dbPath, list);
  }

  for (const [dbPath, pids] of pidsByDbPath) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        for (const pid of pids) {
          const rawId = readActiveSessionRawIdFromDb(db, dbPath);
          if (rawId) sessionIds.set(pid, rawId);
        }
      } finally {
        db.close();
      }
    } catch {
      // Ignore databases that are locked or malformed.
    }
  }

  return sessionIds;
}

async function findDbPathForProcess(
  pid: number,
  command: string,
  runner: ProcessListRunner,
  options: { includeHermes: boolean; includeOpenCode: boolean; includeZcode: boolean; includeCodeWiz: boolean },
): Promise<string | null> {
  const tokens = splitCommandLine(command);
  const family = executableFamily(tokens[isNodeExecutable(tokens[0]) ? 1 : 0]);
  if (!family) return null;

  try {
    const output = await runner("lsof", ["-p", String(pid)]);
    if (family === "hermes" && options.includeHermes) return extractHermesDbPath(output);
    if (family === "opencode" && options.includeOpenCode) return extractOpenCodeDbPath(output);
    if (family === "zcode" && options.includeZcode) return extractZcodeDbPath(output);
    if (family === "codewiz" && options.includeCodeWiz) return extractCodeWizDbPath(output);
  } catch {
    // Process may exit between ps and lsof.
  }

  return null;
}

function readActiveSessionRawIdFromDb(db: import("node:sqlite").DatabaseSync, dbPath: string): string | null {
  try {
    if (dbPath.endsWith("state.db") && sqliteTableExists(db, "sessions")) {
      const row = db.prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1").get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }

    if (dbPath.endsWith("opencode.db") && sqliteTableExists(db, "session")) {
      const row = db
        .prepare("SELECT id FROM session ORDER BY time_updated DESC, time_created DESC LIMIT 1")
        .get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }

    if (dbPath.endsWith("db.sqlite") && sqliteTableExists(db, "session")) {
      const row = db
        .prepare("SELECT id FROM session ORDER BY time_updated DESC, time_created DESC, id DESC LIMIT 1")
        .get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }

    if (dbPath.endsWith("opencode.db") && dbPath.includes("codewiz") && sqliteTableExists(db, "session")) {
      const row = db
        .prepare("SELECT id FROM session ORDER BY time_updated DESC, time_created DESC LIMIT 1")
        .get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }
  } catch {
    // Ignore transient read errors.
  }

  return null;
}

function sqliteTableExists(db: import("node:sqlite").DatabaseSync, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1").get("table", tableName) as
      | { 1?: number }
      | undefined;
    return row?.[1] === 1;
  } catch {
    return false;
  }
}

async function loadQoderSessionIds(lines: string[], runner: ProcessListRunner): Promise<Map<number, string>> {
  const sessionIds = new Map<number, string>();
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const pids = entries.filter((entry) => isQoderAppCommand(entry.command)).map((entry) => entry.pid);

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const output = await runner("lsof", ["-p", String(pid)]);
        const filePath = extractQoderConversationFile(output);
        if (!filePath) return;
        const rawId = extractQoderRawIdFromPath(filePath);
        if (rawId) sessionIds.set(pid, rawId);
      } catch {
        // Qoder can rotate workspaces or exit between ps and lsof; keep the rest.
      }
    }),
  );

  return sessionIds;
}

function extractQoderConversationFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/(\S*conversation-history\/\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractQoderRawIdFromPath(filePath: string): string | null {
  const match = filePath.match(/projects\/([^/]+)\/conversation-history\/([^/]+)\//);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function splitCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }

    token += char;
  }

  if (token) tokens.push(token);
  return tokens;
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: command === "lsof" ? 1500 : undefined }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
