import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LIVE_SESSION_INACTIVITY_TIMEOUT_MS, LIVE_SESSION_SNAPSHOT_CACHE_TTL_MS } from "./refresh-policy";
import { encodeCursorWorkspaceSlug, OMP_SESSIONS_DIR } from "./session-loader";
import type { LiveSession, LiveSessionFamily, LiveSessionSnapshot } from "./types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => import("node:sqlite").DatabaseSync };
const CLAUDE_SESSION_START_SKEW_MS = 2 * 60 * 1000;
const CODEX_LIFECYCLE_READ_CHUNK_SIZE = 1024 * 1024;
const CODEX_LIFECYCLE_MAX_LINE_SIZE = 512 * 1024;
const CODEX_LIFECYCLE_MAX_READ_SIZE = 8 * 1024 * 1024;
const CODEX_RECENT_ACTIVITY_FALLBACK_MS = 2 * 60 * 1000;

type ProcessListRunner = (command: string, args: string[]) => Promise<string>;
type LiveSessionSnapshotLoader = (options?: LoadLiveSessionOptions) => Promise<LiveSessionSnapshot>;

interface ProcessEntry {
  pid: number;
  command: string;
}

interface WindowsProcessEntry extends ProcessEntry {
  ppid: number;
  name: string;
  executablePath: string | null;
  startedAtMs: number | null;
}

const WIN32_PROCESS_LIST_COMMAND = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate) | ConvertTo-Json -Compress",
].join("; ");

const CODEX_VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "-m",
  "--model",
  "-C",
  "--cd",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "--add-dir",
  "-i",
  "--image",
]);

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
  fresh?: boolean;
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
  includeOmp?: boolean;
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
    if (options.fresh) return load(options);
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
  codexAppSessionFilesByPid: Map<number, string[]> = new Map(),
  platform?: NodeJS.Platform,
  ompSessionIdsByPid: Map<number, string> = new Map(),
): LiveSession[] {
  const sessions: LiveSession[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const entry = parseProcessLine(line);
    if (!entry) continue;

    const tokens = splitCommandLine(entry.command, platform);
    const commands: Array<{ family: LiveSessionFamily; rawId: string }> = [];
    if (isCodexAppServerCommand(tokens)) {
      for (const sessionFile of codexAppSessionFilesByPid.get(entry.pid) ?? []) {
        const rawId = extractCodexSessionId(sessionFile);
        if (rawId) commands.push({ family: "codex", rawId });
      }
    } else {
      const command =
        detectResumeCommand(tokens) ??
        detectPlainCodexCommand(tokens, codexSessionFilesByPid.get(entry.pid)) ??
        detectPlainClaudeCommand(tokens, claudeSessionFilesByPid.get(entry.pid)) ??
        detectPlainOpenClawCommand(tokens, openclawSessionFilesByPid.get(entry.pid)) ??
        detectPlainCursorCommand(tokens, cursorSessionFilesByPid.get(entry.pid)) ??
        detectPlainCodeBuddyCommand(tokens, codebuddySessionFilesByPid.get(entry.pid)) ??
        detectDbBackedCommand(tokens, dbSessionIdsByPid.get(entry.pid)) ??
        detectOmpCommand(tokens, ompSessionIdsByPid.get(entry.pid)) ??
        detectTraeAppSession(entry.command, traeSessionIdsByPid.get(entry.pid)) ??
        detectQoderAppSession(entry.command, qoderSessionIdsByPid.get(entry.pid));
      if (command) commands.push(command);
    }

    for (const command of commands) {
      const key = `${command.family}:${command.rawId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({ ...command, pid: entry.pid });
    }
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
    includeOmp: options.includeOmp !== false,
    homeDir: options.homeDir ?? os.homedir(),
  });
}

export async function loadLiveSessionSnapshot(options: LoadLiveSessionOptions = {}): Promise<LiveSessionSnapshot> {
  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? execText;
  const homeDir = options.homeDir ?? os.homedir();

  try {
    if (platform === "win32") {
      return await loadWindowsLiveSessionSnapshot(options, runner, homeDir, now, generatedAt);
    }

    const output = await runner("/bin/ps", ["-axo", "pid=,command="]);
    const lines = output.split(/\r?\n/);
    const [codexSessionFilesByPid, codexAppSessionFilesByPid, claudeSessionFilesByPid] = await Promise.all([
      loadPlainCodexSessionFiles(lines, runner, homeDir, now.getTime()),
      loadCodexAppSessionFiles(lines, runner, now.getTime()),
      loadPlainClaudeSessionFiles(lines, runner, now.getTime(), homeDir),
    ]);
    const traeSessionIdsByPid =
      options.includeTrae === false ? new Map<number, string>() : await loadTraeSessionIds(lines, runner);
    const qoderSessionIdsByPid =
      options.includeQoder === false ? new Map<number, string>() : await loadQoderSessionIds(lines, runner);
    const openclawSessionFilesByPid =
      options.includeOpenClaw === false ? new Map<number, string>() : await loadOpenClawSessionFiles(lines, runner);
    const cursorSessionFilesByPid =
      options.includeCursor === false
        ? new Map<number, string>()
        : await loadCursorSessionFiles(lines, runner, homeDir);
    const codebuddySessionFilesByPid =
      options.includeCodeBuddy === false
        ? new Map<number, string>()
        : await loadCodeBuddySessionFiles(lines, runner, homeDir);
    const dbSessionIdsByPid =
      options.includeHermes === false &&
      options.includeOpenCode === false &&
      options.includeZcode === false &&
      options.includeCodeWiz === false
        ? new Map<number, string>()
        : await loadDbSessionIds(lines, runner, {
            includeHermes: options.includeHermes !== false,
            includeOpenCode: options.includeOpenCode !== false,
            includeZcode: options.includeZcode !== false,
            includeCodeWiz: options.includeCodeWiz !== false,
          });
    const ompSessionIdsByPid =
      options.includeOmp === false
        ? new Map<number, string>()
        : await loadOmpSessionIds(lines, runner, homeDir, now.getTime());

    const sessions = detectLiveSessionsFromProcessLines(
      lines,
      codexSessionFilesByPid,
      claudeSessionFilesByPid,
      traeSessionIdsByPid,
      qoderSessionIdsByPid,
      openclawSessionFilesByPid,
      cursorSessionFilesByPid,
      codebuddySessionFilesByPid,
      dbSessionIdsByPid,
      codexAppSessionFilesByPid,
      undefined,
      ompSessionIdsByPid,
    );
    return {
      generatedAt,
      sessions,
    };
  } catch (error) {
    return {
      generatedAt,
      sessions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function loadWindowsLiveSessionSnapshot(
  options: LoadLiveSessionOptions,
  runner: ProcessListRunner,
  homeDir: string,
  now: Date,
  generatedAt: string,
): Promise<LiveSessionSnapshot> {
  const output = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32_PROCESS_LIST_COMMAND]);
  const entries = parseWindowsProcessEntries(output);
  if (entries.length === 0) {
    return { generatedAt, sessions: [] };
  }

  const lines = entries.map((entry) => `${entry.pid} ${entry.command}`);
  const childPidsByParent = new Map<number, number[]>();
  const entriesByPid = new Map<number, WindowsProcessEntry>();
  for (const entry of entries) {
    entriesByPid.set(entry.pid, entry);
    if (entry.ppid > 0) {
      const children = childPidsByParent.get(entry.ppid) ?? [];
      children.push(entry.pid);
      childPidsByParent.set(entry.ppid, children);
    }
  }

  const hasCodexChild = (pid: number): boolean =>
    (childPidsByParent.get(pid) ?? []).some((childPid) => {
      const child = entriesByPid.get(childPid);
      if (!child) return false;
      const childTokens = splitCommandLine(child.command, "win32");
      return isPlainCodexCommand(childTokens) || Boolean(detectResumeCommand(childTokens));
    });

  const codexSessionFilesByPid = new Map<number, string>();
  const claudeSessionFilesByPid = new Map<number, string>();
  const cursorSessionFilesByPid = new Map<number, string>();
  const codebuddySessionFilesByPid = new Map<number, string>();
  const dbSessionIdsByPid = new Map<number, string>();

  const claimedClaudeRawIds = new Set<string>();
  const claimedCodexFiles = new Set<string>();
  const pendingCodex: Array<{ pid: number; explicitCwd: string | null }> = [];
  const pendingClaude: Array<{ pid: number; explicitCwd: string | null; startedAtMs: number | null }> = [];
  const pendingCursor: Array<{ pid: number; explicitCwd: string | null }> = [];
  const pendingCodeBuddy: Array<{ pid: number; explicitCwd: string | null }> = [];
  const pendingDb: Array<{ pid: number; family: "hermes" | "opencode" | "zcode" | "codewiz"; dbPath: string; explicitCwd: string | null }> = [];
  const pendingOmp: PendingOmpProcess[] = [];
  const pidsNeedingCwd = new Set<number>();

  for (const entry of entries) {
    const tokens = splitCommandLine(entry.command, "win32");
    const resumed = detectResumeCommand(tokens);
    if (resumed) {
      if (resumed.family === "claude") claimedClaudeRawIds.add(resumed.rawId);
      continue;
    }
    if (isElectronHelperArgs(tokens)) continue;

    const explicitCwd = extractCwdFromArgs(tokens);

    if (options.includeOmp !== false) {
      const ompLaunch = parseOmpLaunch(tokens);
      if (ompLaunch) {
        pendingOmp.push({ pid: entry.pid, cwd: explicitCwd, startedAtMs: entry.startedAtMs, sessionArg: ompLaunch.sessionArg });
        if (!explicitCwd) pidsNeedingCwd.add(entry.pid);
        continue;
      }
    }

    if (isPlainCodexCommand(tokens) || (isPlainCodexNodeWrapper(tokens) && !hasCodexChild(entry.pid))) {
      pendingCodex.push({ pid: entry.pid, explicitCwd });
      if (!explicitCwd) pidsNeedingCwd.add(entry.pid);
      continue;
    }

    if (isPlainClaudeCommand(tokens) && !isDesktopClaudeProcess(tokens[0]) && !isDesktopClaudeProcess(entry.executablePath ?? undefined)) {
      const meta = readClaudeProcessSessionMeta(homeDir, entry.pid);
      if (meta?.sessionId) {
        const mappedPath = path.join(
          homeDir,
          ".claude",
          "projects",
          encodeClaudeProjectDir(meta.cwd || "session"),
          `${meta.sessionId}.jsonl`,
        );
        claudeSessionFilesByPid.set(entry.pid, mappedPath);
        claimedClaudeRawIds.add(meta.sessionId);
        continue;
      }
      const cwd = explicitCwd ?? meta?.cwd ?? null;
      pendingClaude.push({ pid: entry.pid, explicitCwd: cwd, startedAtMs: entry.startedAtMs });
      if (!cwd) pidsNeedingCwd.add(entry.pid);
      continue;
    }

    if (options.includeCursor !== false && isPlainCursorCommand(tokens)) {
      pendingCursor.push({ pid: entry.pid, explicitCwd });
      if (!explicitCwd) pidsNeedingCwd.add(entry.pid);
      continue;
    }

    if (options.includeCodeBuddy !== false && isPlainCodeBuddyCommand(tokens)) {
      pendingCodeBuddy.push({ pid: entry.pid, explicitCwd });
      if (!explicitCwd) pidsNeedingCwd.add(entry.pid);
      continue;
    }

    const dbFamily = dbBackedFamilyForTokens(tokens, options);
    if (dbFamily) {
      const dbPath = windowsDbPathForFamily(homeDir, dbFamily);
      if (fs.existsSync(dbPath)) {
        pendingDb.push({ pid: entry.pid, family: dbFamily, dbPath, explicitCwd });
        if (!explicitCwd && dbFamily !== "hermes") pidsNeedingCwd.add(entry.pid);
      }
    }
  }

  const processCwds = pidsNeedingCwd.size > 0
    ? await loadWindowsProcessCwds([...pidsNeedingCwd], runner)
    : new Map<number, string>();

  const nowMs = now.getTime();
  for (const item of pendingCodex) {
    const cwd = item.explicitCwd ?? processCwds.get(item.pid);
    if (!cwd) continue;
    const sessionFile = findMostRecentCodexSessionByCwd(homeDir, cwd, nowMs, claimedCodexFiles);
    if (sessionFile) {
      codexSessionFilesByPid.set(item.pid, sessionFile);
      claimedCodexFiles.add(sessionFile);
    }
  }

  const claudePendingWithCwd: PendingClaudeProcess[] = [];
  for (const item of pendingClaude) {
    const cwd = item.explicitCwd ?? processCwds.get(item.pid);
    if (cwd) {
      claudePendingWithCwd.push({ pid: item.pid, cwd, startedAtMs: item.startedAtMs });
    }
  }
  assignPendingClaudeProcesses(claudePendingWithCwd, homeDir, "win32", claimedClaudeRawIds, claudeSessionFilesByPid);

  for (const item of pendingCursor) {
    const cwd = item.explicitCwd ?? processCwds.get(item.pid);
    if (!cwd) continue;
    const transcriptsDir = findCursorTranscriptsDir(homeDir, cwd, "win32");
    const sessionId = findMostRecentSessionDirWithJsonl(transcriptsDir);
    if (sessionId) {
      cursorSessionFilesByPid.set(item.pid, path.join(transcriptsDir, sessionId, `${sessionId}.jsonl`));
    }
  }

  for (const item of pendingCodeBuddy) {
    const cwd = item.explicitCwd ?? processCwds.get(item.pid);
    if (!cwd) continue;
    const resolved = findMostRecentCodeBuddySession(homeDir, cwd);
    if (resolved) {
      codebuddySessionFilesByPid.set(
        item.pid,
        path.join(homeDir, ".codebuddy", "projects", resolved.slug, resolved.sessionId, "tool-results", "fallback.txt"),
      );
    }
  }

  const pidsByDb = new Map<string, Array<{ pid: number; cwd?: string }>>();
  for (const item of pendingDb) {
    const cwd = item.explicitCwd ?? processCwds.get(item.pid);
    const list = pidsByDb.get(item.dbPath) ?? [];
    list.push({ pid: item.pid, ...(cwd ? { cwd } : {}) });
    pidsByDb.set(item.dbPath, list);
  }
  for (const [dbPath, dbEntries] of pidsByDb) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        for (const dbEntry of dbEntries) {
          const rawId = readActiveSessionRawIdFromDb(db, dbPath, dbEntry.cwd);
          if (rawId) dbSessionIdsByPid.set(dbEntry.pid, rawId);
        }
      } finally {
        db.close();
      }
    } catch {
      // Ignore databases that are locked or malformed.
    }
  }

  const ompSessionIdsByPid = resolveOmpSessionIds(
    pendingOmp.map((item) => ({ ...item, cwd: item.cwd ?? processCwds.get(item.pid) ?? null })),
    homeDir,
  );
  const sessions = detectLiveSessionsFromProcessLines(
    lines,
    codexSessionFilesByPid,
    claudeSessionFilesByPid,
    new Map(),
    new Map(),
    new Map(),
    cursorSessionFilesByPid,
    codebuddySessionFilesByPid,
    dbSessionIdsByPid,
    new Map(),
    "win32",
    ompSessionIdsByPid,
  );
  return {
    generatedAt,
    sessions,
  };
}

async function loadPlainCodexSessionFiles(
  lines: string[],
  runner: ProcessListRunner,
  homeDir = os.homedir(),
  nowMs = Date.now(),
): Promise<Map<number, string>> {
  return loadPlainSessionFilesWithCwdFallback(
    lines,
    runner,
    isPlainCodexCommand,
    (lsofOutput) => extractCodexSessionFile(lsofOutput, nowMs),
    homeDir,
    (home, cwd) => findMostRecentCodexSessionByCwd(home, cwd, nowMs),
  );
}

async function loadCodexAppSessionFiles(lines: string[], runner: ProcessListRunner, nowMs: number): Promise<Map<number, string[]>> {
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const pids = entries.filter((entry) => isCodexAppServerCommand(splitCommandLine(entry.command))).map((entry) => entry.pid);
  const sessionFiles = new Map<number, string[]>();

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const files = extractCodexSessionFiles(await runner("lsof", ["-p", String(pid)])).filter((file) => isCodexAgentWorking(file, nowMs));
        if (files.length > 0) sessionFiles.set(pid, files);
      } catch {
        return;
      }
    }),
  );

  return sessionFiles;
}

/**
 * Codex sessions live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * and the first line of each file is session_meta with a `cwd` field. Walk recent
 * session files and return the most recently modified one whose cwd matches.
 */
function findMostRecentCodexSessionByCwd(
  homeDir: string,
  cwd: string,
  nowMs = Date.now(),
  excludeFiles: ReadonlySet<string> = new Set(),
): string | null {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  const candidates: {
    bestWorking: { filePath: string; mtimeMs: number } | null;
    bestAny: { filePath: string; mtimeMs: number } | null;
  } = {
    bestWorking: null,
    bestAny: null,
  };
  const consider = (filePath: string, mtimeMs: number): void => {
    if (excludeFiles.has(filePath)) return;
    if (
      candidates.bestAny !== null &&
      mtimeMs <= candidates.bestAny.mtimeMs &&
      candidates.bestWorking !== null &&
      mtimeMs <= candidates.bestWorking.mtimeMs
    ) {
      return;
    }
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(16 * 1024);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        const firstLine = buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
        if (!firstLine) return;
        const meta = JSON.parse(firstLine) as { payload?: { cwd?: string } };
        if (!sameWorkingDirectory(meta?.payload?.cwd, cwd)) return;
        if (!candidates.bestAny || mtimeMs > candidates.bestAny.mtimeMs) candidates.bestAny = { filePath, mtimeMs };
        if (isCodexAgentWorking(filePath, nowMs) && (!candidates.bestWorking || mtimeMs > candidates.bestWorking.mtimeMs)) {
          candidates.bestWorking = { filePath, mtimeMs };
        }
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
  return candidates.bestWorking?.filePath ?? candidates.bestAny?.filePath ?? null;
}

async function loadPlainClaudeSessionFiles(
  lines: string[],
  runner: ProcessListRunner,
  nowMs: number,
  homeDir = os.homedir(),
): Promise<Map<number, string>> {
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
        return { pid, sessionFile: null, cwd, startedAtMs: await loadProcessStartedAtMs(pid, runner, nowMs) };
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

  assignPendingClaudeProcesses(pending, homeDir, process.platform, claimedRawIds, sessionFiles);
  return sessionFiles;
}

function assignPendingClaudeProcesses(
  pending: PendingClaudeProcess[],
  homeDir: string,
  platform: NodeJS.Platform,
  claimedRawIds: Set<string>,
  sessionFiles: Map<number, string>,
): void {
  const candidatesByCwd = new Map<string, ClaudeSessionCandidate[]>();
  for (const proc of pending) {
    if (!candidatesByCwd.has(proc.cwd)) {
      candidatesByCwd.set(proc.cwd, listClaudeSessionCandidates(homeDir, proc.cwd, platform));
    }
  }

  const matches = pending.flatMap((proc) =>
    (candidatesByCwd.get(proc.cwd) ?? [])
      .filter((candidate) => !claimedRawIds.has(candidate.rawId))
      .filter(
        (candidate) =>
          proc.startedAtMs === null ||
          candidate.createdAtMs >= proc.startedAtMs - CLAUDE_SESSION_START_SKEW_MS ||
          candidate.modifiedAtMs >= proc.startedAtMs - CLAUDE_SESSION_START_SKEW_MS,
      )
      .map((candidate) => {
        const createdForProcess =
          proc.startedAtMs === null || candidate.createdAtMs >= proc.startedAtMs - CLAUDE_SESSION_START_SKEW_MS;
        const distanceMs =
          proc.startedAtMs === null
            ? -candidate.modifiedAtMs
            : Math.abs((createdForProcess ? candidate.createdAtMs : candidate.modifiedAtMs) - proc.startedAtMs);
        return { process: proc, candidate, fallbackRank: createdForProcess ? 0 : 1, distanceMs };
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

/**
 * `ps -o lstart=` renders the start time through the active locale, so `Date.parse`
 * returns NaN on any system that is not set to English and every caller silently
 * degrades to matching sessions without a start time. `etime` reports the elapsed
 * time as a locale-independent `[[dd-]hh:]mm:ss` value instead.
 */
async function loadProcessStartedAtMs(pid: number, runner: ProcessListRunner, nowMs: number): Promise<number | null> {
  try {
    const elapsed = (await runner("/bin/ps", ["-o", "etime=", "-p", String(pid)])).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!elapsed) return null;
    const days = Number(elapsed[1] ?? 0);
    const hours = Number(elapsed[2] ?? 0);
    const minutes = Number(elapsed[3] ?? 0);
    const seconds = Number(elapsed[4] ?? 0);
    return nowMs - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  } catch {
    return null;
  }
}

function listClaudeSessionCandidates(
  homeDir: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeSessionCandidate[] {
  const projectsRoot = path.join(homeDir, ".claude", "projects");
  const encoded = encodeClaudeProjectDir(cwd);
  let projectDir = path.join(projectsRoot, encoded);
  if (platform === "win32" && !fs.existsSync(projectDir)) {
    const targetLower = encoded.toLowerCase();
    try {
      const matched = fs
        .readdirSync(projectsRoot, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === targetLower);
      if (matched) projectDir = path.join(projectsRoot, matched.name);
    } catch {
      return [];
    }
  }
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
    // omp resume values are id prefixes or paths; resolveOmpSessionIds maps them to header ids.
    if (!family || family === "omp") continue;

    const args = tokens.slice(index + 1);
    const rawId =
      family === "codex" || family === "tcodex"
        ? codexResumeId(args)
        : flagResumeId(args, family === "codewiz");
    if (rawId) return { family, rawId };
  }

  return null;
}

function detectPlainCodexCommand(tokens: string[], sessionFile: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!sessionFile || (!isPlainCodexCommand(tokens) && !isPlainCodexNodeWrapper(tokens))) return null;
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
    if (family === "hermes" || family === "opencode" || family === "zcode" || family === "codewiz") {
      return { family, rawId };
    }
  }
  return null;
}

function detectTraeAppSession(command: string, rawId: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!rawId || !isTraeAppCommand(command)) return null;
  return { family: "trae", rawId };
}

function isPlainCodexCommand(tokens: string[]): boolean {
  if (isNodeExecutable(tokens[0])) return false;
  if (isCodexAppServerCommand(tokens)) return false;
  const commandStartIndexes = [0];

  for (const index of commandStartIndexes) {
    const family = executableFamily(tokens[index]);
    if (family !== "codex") continue;
    if (normalizedExecutableName(tokens[index]) !== "codex") continue;
    if (isCodexDesktopProcess(tokens[index])) return false;
    const args = tokens.slice(index + 1);
    if (args.includes("resume")) return false;
    return true;
  }

  return false;
}

function isCodexAppServerCommand(tokens: string[]): boolean {
  const commandStartIndexes = isNodeExecutable(tokens[0]) ? [1] : [0];

  for (const index of commandStartIndexes) {
    if (executableFamily(tokens[index]) !== "codex") continue;
    return tokens.slice(index + 1).includes("app-server");
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
  const lower = token.toLowerCase().replace(/\\/g, "/");
  if (lower.includes("/.codex/computer-use/")) return true;
  if (lower.includes("/codex-code-mode-host")) return true;
  if (lower.includes(".app/contents/") && !lower.includes("/contents/resources/codex")) return true;
  return lower.includes("/windowsapps/openai.codex") && !lower.endsWith("/resources/codex.exe");
}

function codexResumeId(args: string[]): string | null {
  let index = 0;
  let resumeIndex = -1;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "resume") {
      resumeIndex = index;
      break;
    }
    if (CODEX_VALUE_FLAGS.has(arg)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  if (resumeIndex < 0) return null;

  let argIndex = resumeIndex + 1;
  while (argIndex < args.length) {
    const arg = args[argIndex]?.trim();
    if (!arg) {
      argIndex += 1;
      continue;
    }
    if (CODEX_VALUE_FLAGS.has(arg)) {
      argIndex += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      argIndex += 1;
      continue;
    }
    return arg;
  }
  return null;
}

function flagResumeId(args: string[], allowSessionFlag = false): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--resume" || arg === "-r" || (allowSessionFlag && arg === "--session")) {
      const rawId = args[index + 1]?.trim();
      if (rawId && !rawId.startsWith("-")) return rawId;
    }
    if (arg.startsWith("--resume=")) {
      const rawId = arg.slice("--resume=".length).trim();
      if (rawId) return rawId;
    }
    if (allowSessionFlag && arg.startsWith("--session=")) {
      const rawId = arg.slice("--session=".length).trim();
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
  if (normalized === "codewiz") return "codewiz";
  if (normalized === "cursor-agent") return "cursor";
  if (normalized === "omp") return "omp";

  const lower = token.toLowerCase().replace(/\\/g, "/");
  if (lower.includes("@openai/codex") && !lower.includes("codex-code-mode-host")) return "codex";
  if (lower.includes("tcodex")) return "tcodex";
  if (lower.includes("tclaude")) return "tclaude";
  if (lower.includes("@anthropic-ai/claude") || lower.includes("claude-code")) return "claude";
  if (lower.includes("codebuddy")) return "codebuddy";
  if (lower.includes("openclaw")) return "openclaw";
  if (lower.includes("hermes")) return "hermes";
  if (lower.includes("opencode")) return "opencode";
  if (lower.includes("zcode")) return "zcode";
  if (lower.includes("codewiz")) return "codewiz";
  if (lower.includes("cursor-agent")) return "cursor";
  if (lower.includes("@oh-my-pi/")) return "omp";
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
  return name.replace(/\.(?:js|cjs|mjs|cmd|bat|exe)$/i, "");
}

function extractCodexSessionId(sessionFile: string): string | null {
  return sessionFile.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/)?.[1] ?? null;
}

function extractCodexSessionFile(lsofOutput: string, nowMs = Date.now()): string | null {
  const sessionFiles = extractCodexSessionFiles(lsofOutput);
  const workingFiles = sessionFiles.filter((sessionFile) => isCodexAgentWorking(sessionFile, nowMs));
  const candidates = workingFiles.length > 0 ? workingFiles : sessionFiles;
  let mostRecent: { filePath: string; modifiedAtMs: number } | null = null;
  for (const filePath of candidates) {
    try {
      const modifiedAtMs = fs.statSync(filePath).mtimeMs;
      if (!mostRecent || modifiedAtMs > mostRecent.modifiedAtMs) {
        mostRecent = { filePath, modifiedAtMs };
      }
    } catch {
      continue;
    }
  }
  return mostRecent?.filePath ?? candidates[0] ?? null;
}

function extractCodexSessionFiles(lsofOutput: string): string[] {
  const sessionFiles = new Set<string>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:[A-Za-z]:)?[\\/].*[\\/]\.codex[\\/]sessions[\\/].+?\.jsonl)\b/);
    if (match?.[1]) sessionFiles.add(match[1]);
  }
  return [...sessionFiles];
}

function isCodexAgentWorking(sessionFile: string, nowMs: number): boolean {
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(sessionFile, "r");
    const stat = fs.fstatSync(fileDescriptor);
    if (nowMs - stat.mtimeMs >= LIVE_SESSION_INACTIVITY_TIMEOUT_MS) return false;
    let position = stat.size;
    const earliestPosition = Math.max(0, stat.size - CODEX_LIFECYCLE_MAX_READ_SIZE);
    let partialLine = Buffer.alloc(0);
    let skippingOversizedLine = false;

    while (position > earliestPosition) {
      const bytesToRead = Math.min(
        CODEX_LIFECYCLE_READ_CHUNK_SIZE,
        position - earliestPosition,
      );
      position -= bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      fs.readSync(fileDescriptor, chunk, 0, bytesToRead, position);
      const content = partialLine.length > 0
        ? Buffer.concat([chunk, partialLine])
        : chunk;
      let lineEnd = content.length;
      let skipCurrentLine = skippingOversizedLine;

      for (let index = content.length - 1; index >= 0; index--) {
        if (content[index] !== 0x0a) continue;
        const line = content.subarray(index + 1, lineEnd);
        if (!skipCurrentLine && line.length <= CODEX_LIFECYCLE_MAX_LINE_SIZE) {
          const state = codexAgentWorkingStateFromLine(line.toString("utf8"));
          if (state !== null) return state;
        }
        skipCurrentLine = false;
        lineEnd = index;
      }

      const leadingPartial = content.subarray(0, lineEnd);
      if (skipCurrentLine || leadingPartial.length > CODEX_LIFECYCLE_MAX_LINE_SIZE) {
        partialLine = Buffer.alloc(0);
        skippingOversizedLine = true;
      } else {
        partialLine = Buffer.from(leadingPartial);
        skippingOversizedLine = false;
      }
    }

    if (!skippingOversizedLine && partialLine.length <= CODEX_LIFECYCLE_MAX_LINE_SIZE) {
      const state = codexAgentWorkingStateFromLine(partialLine.toString("utf8"));
      if (state !== null) return state;
    }
    return nowMs - stat.mtimeMs <= CODEX_RECENT_ACTIVITY_FALLBACK_MS;
  } catch {
    return false;
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
  }
}

function codexAgentWorkingStateFromLine(line: string): boolean | null {
  if (!line.includes("task_started") && !line.includes("task_complete") && !line.includes("turn_aborted")) return null;
  try {
    const row = JSON.parse(line) as { type?: unknown; payload?: { type?: unknown } };
    if (row.type !== "event_msg") return null;
    if (row.payload?.type === "task_started") return true;
    if (row.payload?.type === "task_complete" || row.payload?.type === "turn_aborted") return false;
  } catch {
    return null;
  }
  return null;
}

function extractClaudeSessionId(sessionFile: string): string | null {
  const rawId = sessionFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "").trim();
  return rawId || null;
}

function extractPathStartIndex(line: string): number {
  const slashIndex = line.indexOf("/");
  const driveMatch = line.match(/(?:^|\s)([A-Za-z]:[\\/])/);
  const driveIndex =
    driveMatch?.index !== undefined ? driveMatch.index + (driveMatch[0].length - driveMatch[1].length) : -1;
  if (slashIndex >= 0 && driveIndex >= 0) return Math.min(slashIndex, driveIndex);
  return Math.max(slashIndex, driveIndex);
}

function extractClaudeSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.claude[\\/]projects[\\/][^\r\n]+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractOpenClawSessionFile(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(
      /((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.(?:openclaw|clawdbot)[\\/]agents[\\/]\S+?[\\/]sessions[\\/][^\r\n]+?\.jsonl)\b/,
    );
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
    const match = line.match(
      /((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.cursor[\\/]projects[\\/][^\r\n]+?[\\/]agent-transcripts[\\/][^\r\n]+?\.jsonl)\b/,
    );
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
    const match = line.match(
      /((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.codebuddy[\\/]projects[\\/][^\r\n]+?[\\/]tool-results[\\/][^\r\n]+?\.txt)\b/,
    );
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractCodeBuddySessionId(sessionFile: string): string | null {
  const match = sessionFile.match(/\.codebuddy[\\/]projects[\\/][^\\/]+[\\/]([^\\/]+)[\\/]tool-results[\\/]/);
  return match?.[1] ?? null;
}

function extractHermesDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.hermes[\\/]state\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractOpenCodeDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.local[\\/]share[\\/]opencode[\\/]opencode\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractZcodeDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.zcode[\\/]cli[\\/]db[\\/]db\.sqlite)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractCodeWizDbPath(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    const match = line.match(/((?:(?:[A-Za-z]:)?[\\/][^\r\n]*?|\S*)\.local[\\/]share[\\/]codewiz[\\/]opencode\.db)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractProcessCwd(lsofOutput: string): string | null {
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!/\s+cwd\s+/.test(line)) continue;
    const start = extractPathStartIndex(line);
    if (start >= 0) return line.slice(start).trim();
  }
  return null;
}

function extractTraeStateDbPath(lsofOutput: string): string | null {
  const candidates: string[] = [];
  for (const line of lsofOutput.split(/\r?\n/)) {
    const end = line.indexOf("state.vscdb");
    if (end < 0) continue;
    const start = extractPathStartIndex(line);
    if (start < 0 || start > end) continue;
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
      const transcriptsDir = findCursorTranscriptsDir(home, cwd, process.platform);
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
      const resolved = findMostRecentCodeBuddySession(home, cwd);
      if (!resolved) return null;
      return path.join(home, ".codebuddy", "projects", resolved.slug, resolved.sessionId, "tool-results", "fallback.txt");
    },
  );
}

const OMP_SESSION_START_SKEW_MS = 2 * 60 * 1000;
const OMP_HEADER_SCAN_BYTES = 64 * 1024;

/** Every top-level omp subcommand except `launch` (the default session command); see `omp --help`. */
const OMP_NON_SESSION_SUBCOMMANDS = new Set([
  "acp", "auth-broker", "auth-gateway", "agents", "bench", "browser-relay", "cleanse", "collab", "clip", "commit",
  "completions", "compress", "config", "dry-balance", "find", "gc", "grep", "gallery", "git", "grievances", "if-bench",
  "images", "img", "install", "join", "login", "models", "plugin", "plugins", "play", "predict", "ps", "say", "share",
  "setup", "shell", "read", "render", "skill", "skills", "ssh", "stats", "stream", "update", "usage", "tiny-models",
  "token", "toks", "ttsr", "worktree", "wt", "search", "q", "web-search",
]);

/** Launch flags whose value is a separate token, so it is not mistaken for a subcommand. */
const OMP_VALUE_FLAGS = new Set([
  "--cwd", "--add-dir", "--config", "--fork", "--model", "--smol", "--slow", "--plan", "--models", "--provider",
  "--api-key", "--provider-session-id", "--prompt-cache-key", "--service-tier", "--thinking", "--prewalk-into",
  "--plan-yolo-into", "--goal", "--tools", "--approval-mode", "--max-time", "--motion", "--spinner-interval",
  "--max-fps", "--warn-cost", "--max-cost", "--extension", "-e", "--hook", "--trusted-extension", "--plugin-dir",
  "--skills", "--system-prompt", "--system-prompt-template", "--append-system-prompt",
]);

/** `--resume`, `-r` and `--session` take an optional id prefix or path; `--restore` resumes the same way. */
const OMP_SESSION_ARG_FLAGS = new Set(["--resume", "-r", "--session", "--restore"]);

/**
 * Runs that write no session into the indexed `~/.omp/agent/sessions` (ephemeral, other
 * profile or session dir) or exit immediately.
 */
const OMP_NON_INDEXED_FLAGS = new Set(["--no-session", "--session-dir", "--profile", "--export", "--alias", "--help", "-h", "--version", "-v"]);

interface OmpLaunch {
  sessionArg: string | null;
}

interface PendingOmpProcess {
  pid: number;
  cwd: string | null;
  startedAtMs: number | null;
  sessionArg: string | null;
}

interface OmpBreadcrumb {
  cwd: string;
  /** Null when the breadcrumb names a lazy session whose file is not written yet. */
  rawId: string | null;
  mtimeMs: number;
}

/**
 * Returns the launch details of an interactive or print-mode omp session process, or null
 * for other omp invocations (subcommands, `__omp_worker_*` helpers, ACP servers, runs whose
 * sessions are not indexed).
 */
function parseOmpLaunch(tokens: string[]): OmpLaunch | null {
  const wrapped = isNodeExecutable(tokens[0]) || normalizedExecutableName(tokens[0]) === "bun";
  const index = wrapped ? 1 : 0;
  if (executableFamily(tokens[index]) !== "omp") return null;

  const args = tokens.slice(index + 1);
  let sessionArg: string | null = null;
  let positionalSeen = false;
  for (let argIndex = 0; argIndex < args.length; argIndex += 1) {
    const arg = args[argIndex];
    if (arg === "--") break;
    if (arg.startsWith("__")) return null;
    const equalsIndex = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equalsIndex > 0 ? arg.slice(0, equalsIndex) : arg;
    const inlineValue = equalsIndex > 0 ? arg.slice(equalsIndex + 1) : null;
    const nextValue = inlineValue === null ? args[argIndex + 1] : undefined;
    if (OMP_NON_INDEXED_FLAGS.has(flag)) return null;
    if (flag === "--mode") {
      if ((inlineValue ?? nextValue) === "acp") return null;
      if (inlineValue === null) argIndex += 1;
      continue;
    }
    if (OMP_SESSION_ARG_FLAGS.has(flag)) {
      const value = inlineValue ?? (nextValue && !nextValue.startsWith("-") ? nextValue : null);
      if (inlineValue === null && value !== null) argIndex += 1;
      if (value?.trim()) sessionArg = value.trim();
      continue;
    }
    if (OMP_VALUE_FLAGS.has(flag)) {
      if (inlineValue === null) argIndex += 1;
      continue;
    }
    if (arg.startsWith("-") || positionalSeen) continue;
    positionalSeen = true;
    if (OMP_NON_SESSION_SUBCOMMANDS.has(arg)) return null;
  }
  return { sessionArg };
}

function detectOmpCommand(tokens: string[], rawId: string | undefined): { family: LiveSessionFamily; rawId: string } | null {
  if (!rawId || !parseOmpLaunch(tokens)) return null;
  return { family: "omp", rawId };
}

/** omp session files are `<timestamp>_<sessionId>.jsonl`; the id matches the header id. */
function ompRawIdFromSessionFile(filePath: string): string | null {
  const stem = path.basename(filePath).replace(/\.jsonl$/i, "");
  return stem.slice(stem.indexOf("_") + 1).trim() || null;
}

async function loadOmpSessionIds(
  lines: string[],
  runner: ProcessListRunner,
  homeDir: string,
  nowMs: number,
): Promise<Map<number, string>> {
  const entries = lines.map(parseProcessLine).filter((entry): entry is ProcessEntry => Boolean(entry));
  const pending = await Promise.all(
    entries.map(async (entry): Promise<PendingOmpProcess | null> => {
      const tokens = splitCommandLine(entry.command);
      const launch = parseOmpLaunch(tokens);
      if (!launch) return null;
      let cwd = extractCwdFromArgs(tokens);
      if (!cwd) {
        try {
          cwd = extractProcessCwd(await runner("lsof", ["-p", String(entry.pid)]));
        } catch {
          // The process can exit between ps and lsof; an explicit session arg may still resolve.
        }
      }
      const startedAtMs = await loadProcessStartedAtMs(entry.pid, runner, nowMs);
      return { pid: entry.pid, cwd, startedAtMs, sessionArg: launch.sessionArg };
    }),
  );
  return resolveOmpSessionIds(pending.filter((item): item is PendingOmpProcess => item !== null), homeDir);
}

/**
 * Maps omp processes to session header ids. An explicit `--resume` value wins. Otherwise the
 * terminal breadcrumbs (`~/.omp/agent/terminal-sessions/<terminal-id>`: cwd, then session file)
 * record each terminal's current session, including after `/new` or `/resume`; a breadcrumb
 * belongs to a process in the same cwd written since that process started. Without one, the
 * newest session written since the process started in the cwd bucket is used.
 */
function resolveOmpSessionIds(pending: PendingOmpProcess[], homeDir: string): Map<number, string> {
  const sessionsRoot = path.join(homeDir, OMP_SESSIONS_DIR);
  const result = new Map<number, string>();
  const claimed = new Set<string>();
  const unresolved: Array<PendingOmpProcess & { cwd: string }> = [];

  for (const proc of pending) {
    const explicitRawId = proc.sessionArg ? resolveOmpSessionArg(sessionsRoot, proc.sessionArg) : null;
    if (explicitRawId) {
      result.set(proc.pid, explicitRawId);
      claimed.add(explicitRawId);
    } else if (proc.cwd) {
      unresolved.push({ ...proc, cwd: proc.cwd });
    }
  }
  if (unresolved.length === 0) return result;

  const breadcrumbs = readOmpBreadcrumbs(homeDir);
  const matches = unresolved.flatMap((proc) =>
    breadcrumbs
      .map((crumb, crumbIndex) => ({ proc, crumb, crumbIndex }))
      .filter(({ crumb }) =>
        sameWorkingDirectory(crumb.cwd, proc.cwd) &&
        (proc.startedAtMs === null || crumb.mtimeMs >= proc.startedAtMs - OMP_SESSION_START_SKEW_MS),
      )
      .map((match) => ({
        ...match,
        distanceMs: proc.startedAtMs === null ? -match.crumb.mtimeMs : Math.abs(match.crumb.mtimeMs - proc.startedAtMs),
      })),
  );
  matches.sort((left, right) => left.distanceMs - right.distanceMs);

  const settledPids = new Set<number>();
  const usedCrumbs = new Set<number>();
  for (const { proc, crumb, crumbIndex } of matches) {
    if (settledPids.has(proc.pid) || usedCrumbs.has(crumbIndex)) continue;
    if (crumb.rawId && claimed.has(crumb.rawId)) continue;
    settledPids.add(proc.pid);
    usedCrumbs.add(crumbIndex);
    // A lazy breadcrumb means this terminal's session has no file yet: nothing indexed is live.
    if (crumb.rawId) {
      result.set(proc.pid, crumb.rawId);
      claimed.add(crumb.rawId);
    }
  }

  const candidatesByCwd = new Map<string, Array<{ rawId: string; mtimeMs: number }>>();
  const fallbackProcs = unresolved
    .filter((proc) => !settledPids.has(proc.pid))
    .sort((left, right) => (right.startedAtMs ?? -Infinity) - (left.startedAtMs ?? -Infinity));
  for (const proc of fallbackProcs) {
    let candidates = candidatesByCwd.get(proc.cwd);
    if (!candidates) {
      candidates = listOmpSessionCandidates(sessionsRoot, proc.cwd, homeDir);
      candidatesByCwd.set(proc.cwd, candidates);
    }
    const match = candidates.find((candidate) =>
      !claimed.has(candidate.rawId) &&
      (proc.startedAtMs === null || candidate.mtimeMs >= proc.startedAtMs - OMP_SESSION_START_SKEW_MS),
    );
    if (match) {
      result.set(proc.pid, match.rawId);
      claimed.add(match.rawId);
    }
  }
  return result;
}

/** Resolves a `--resume` value (session file path or id prefix) to a session id, newest match first. */
function resolveOmpSessionArg(sessionsRoot: string, value: string): string | null {
  if (/[\\/]/.test(value) || /\.jsonl$/i.test(value)) return ompRawIdFromSessionFile(value);
  let best: { rawId: string; mtimeMs: number } | null = null;
  for (const bucket of listChildDirectories(sessionsRoot)) {
    for (const filePath of listOmpSessionFiles(bucket)) {
      const rawId = ompRawIdFromSessionFile(filePath);
      if (!rawId?.startsWith(value)) continue;
      const mtimeMs = fs.statSync(filePath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (!best || mtimeMs > best.mtimeMs) best = { rawId, mtimeMs };
    }
  }
  return best?.rawId ?? null;
}

function readOmpBreadcrumbs(homeDir: string): OmpBreadcrumb[] {
  const breadcrumbsDir = path.join(homeDir, ".omp", "agent", "terminal-sessions");
  let names: string[];
  try {
    names = fs.readdirSync(breadcrumbsDir);
  } catch {
    return [];
  }
  const breadcrumbs: OmpBreadcrumb[] = [];
  for (const name of names) {
    const filePath = path.join(breadcrumbsDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const [cwd, sessionFile] = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 2).map((line) => line.trim());
      if (!cwd || !sessionFile) continue;
      let rawId: string | null = null;
      if (fs.existsSync(sessionFile)) {
        // Older omp builds could leave a subagent transcript (`<parent-stem>/<AgentId>.jsonl`) here.
        const parentFile = `${path.dirname(sessionFile)}.jsonl`;
        rawId = ompRawIdFromSessionFile(fs.existsSync(parentFile) ? parentFile : sessionFile);
      }
      breadcrumbs.push({ cwd, rawId, mtimeMs: stat.mtimeMs });
    } catch {
      // Breadcrumbs are rewritten in place; skip one that vanished or cannot be read.
    }
  }
  return breadcrumbs;
}

/** Parent session files of the cwd's bucket(s), newest first. */
function listOmpSessionCandidates(sessionsRoot: string, cwd: string, homeDir: string): Array<{ rawId: string; mtimeMs: number }> {
  const candidates: Array<{ rawId: string; mtimeMs: number }> = [];
  for (const bucket of findOmpSessionBuckets(sessionsRoot, cwd, homeDir)) {
    for (const filePath of listOmpSessionFiles(bucket)) {
      const rawId = ompRawIdFromSessionFile(filePath);
      const stat = fs.statSync(filePath, { throwIfNoEntry: false });
      if (rawId && stat) candidates.push({ rawId, mtimeMs: stat.mtimeMs });
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

/**
 * Finds `~/.omp/agent/sessions/<encoded-cwd>` buckets. Names follow omp's path encoding; if none
 * exists (a symlinked cwd, or an encoding change) the bucket whose session header has this cwd is used.
 */
function findOmpSessionBuckets(sessionsRoot: string, cwd: string, homeDir: string): string[] {
  const bucketNames = listChildDirectories(sessionsRoot).map((dir) => path.basename(dir));
  const encodedNames = new Set(ompBucketNameCandidates(cwd, homeDir));
  const caseInsensitive = isWindowsLikePath(cwd);
  const loweredNames = new Set([...encodedNames].map((name) => name.toLowerCase()));
  const named = bucketNames.filter((name) => encodedNames.has(name) || (caseInsensitive && loweredNames.has(name.toLowerCase())));
  if (named.length > 0) return named.map((name) => path.join(sessionsRoot, name));

  return bucketNames
    .map((name) => path.join(sessionsRoot, name))
    .filter((bucket) => {
      const sample = listOmpSessionFiles(bucket)[0];
      return sample !== undefined && sameWorkingDirectory(readOmpHeaderCwd(sample) ?? undefined, cwd);
    });
}

/**
 * omp encodes a cwd as `-<relative>` under home, `-tmp-<relative>` under the temp root, and
 * `--<absolute>--` elsewhere, with path separators (and the drive colon) replaced by `-`.
 */
function ompBucketNameCandidates(cwd: string, homeDir: string): string[] {
  const target = normalizeComparableDirectory(cwd);
  const encode = (value: string): string => value.replace(/[\\/:]/g, "-");
  const names = [`--${encode(target.replace(/^\/+/, ""))}--`];
  for (const [root, prefix] of [[os.tmpdir(), "-tmp"], [homeDir, ""]] as const) {
    const relative = relativeInsideDirectory(root, target);
    if (relative === null) continue;
    names.push(relative ? `${prefix}-${encode(relative)}` : prefix || "-");
  }
  return names;
}

function relativeInsideDirectory(root: string, target: string): string | null {
  const normalizedRoot = normalizeComparableDirectory(root);
  const caseInsensitive = isWindowsLikePath(normalizedRoot) || isWindowsLikePath(target);
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableTarget = caseInsensitive ? target.toLowerCase() : target;
  if (comparableTarget === comparableRoot) return "";
  const rootPrefix = comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`;
  return comparableTarget.startsWith(rootPrefix) ? target.slice(rootPrefix.length) : null;
}

function isWindowsLikePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}

function listChildDirectories(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** Top-level session files of a bucket; subagent transcripts live in nested directories. */
function listOmpSessionFiles(bucket: string): string[] {
  try {
    return fs
      .readdirSync(bucket, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(bucket, entry.name));
  } catch {
    return [];
  }
}

/** Reads the header cwd past omp's leading fixed-width title slot. */
function readOmpHeaderCwd(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(OMP_HEADER_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n", 2)) {
        try {
          const row = JSON.parse(line) as { type?: unknown; cwd?: unknown };
          if (row.type === "session") return typeof row.cwd === "string" ? row.cwd : null;
        } catch {
          // The title slot or a header cut by the scan limit; keep looking.
        }
      }
      return null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
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

function codeBuddyProjectSlugCandidates(cwd: string): string[] {
  const trimmed = cwd.replace(/^[/\\]+/, "");
  const candidates = [
    trimmed.replace(/\//g, "-"),
    trimmed.replace(/[:/\\]/g, "-"),
    trimmed.replace(/^([A-Za-z]):[/\\]+/, "$1-").replace(/[/\\]/g, "-"),
    trimmed.replace(/[^a-zA-Z0-9-]/g, "-"),
    trimmed.replace(/^([A-Za-z]):[/\\]+/, "$1-").replace(/[^a-zA-Z0-9-]/g, "-"),
  ];
  return [...new Set(candidates.filter((candidate) => candidate.length > 0 && !/[\\/:]/.test(candidate)))];
}

function findCursorTranscriptsDir(homeDir: string, cwd: string, platform: NodeJS.Platform): string {
  const projectsRoot = path.join(homeDir, ".cursor", "projects");
  const slug = encodeCursorWorkspaceSlug(cwd);
  const direct = path.join(projectsRoot, slug, "agent-transcripts");
  if (platform !== "win32" || fs.existsSync(direct)) return direct;
  const targetLower = slug.toLowerCase();
  try {
    const matched = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.toLowerCase() === targetLower);
    return matched ? path.join(projectsRoot, matched.name, "agent-transcripts") : direct;
  } catch {
    return direct;
  }
}

function findMostRecentCodeBuddySession(homeDir: string, cwd: string): { slug: string; sessionId: string } | null {
  const projectsRoot = path.join(homeDir, ".codebuddy", "projects");
  const slugCandidates = codeBuddyProjectSlugCandidates(cwd);
  const existingDirs: Array<{ slug: string; dir: string }> = [];
  for (const slug of slugCandidates) {
    const dir = path.join(projectsRoot, slug);
    if (fs.existsSync(dir)) existingDirs.push({ slug, dir });
  }
  if (existingDirs.length === 0) {
    try {
      const candidateLowerSet = new Set(slugCandidates.map((slug) => slug.toLowerCase()));
      for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !candidateLowerSet.has(entry.name.toLowerCase())) continue;
        existingDirs.push({ slug: entry.name, dir: path.join(projectsRoot, entry.name) });
      }
    } catch {
      return null;
    }
  }

  let best: { slug: string; sessionId: string; mtimeMs: number } | null = null;
  for (const { slug, dir } of existingDirs) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
        const toolResultsDir = path.join(dir, entry.name, "tool-results");
        const stat = fs.statSync(toolResultsDir, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!best || stat.mtimeMs > best.mtimeMs) best = { slug, sessionId: entry.name, mtimeMs: stat.mtimeMs };
      }
    } catch {
      continue;
    }
  }
  return best ? { slug: best.slug, sessionId: best.sessionId } : null;
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

function readActiveSessionRawIdFromDb(
  db: import("node:sqlite").DatabaseSync,
  dbPath: string,
  cwd?: string,
): string | null {
  try {
    if (dbPath.endsWith("state.db") && sqliteTableExists(db, "sessions")) {
      const row = db.prepare("SELECT id FROM sessions ORDER BY started_at DESC LIMIT 1").get() as { id?: unknown } | undefined;
      return typeof row?.id === "string" ? row.id : null;
    }

    if (
      (dbPath.endsWith("opencode.db") || dbPath.endsWith("db.sqlite")) &&
      sqliteTableExists(db, "session")
    ) {
      if (cwd && sqliteColumnExists(db, "session", "directory")) {
        const orderBy = dbPath.endsWith("db.sqlite")
          ? "ORDER BY time_updated DESC, time_created DESC, id DESC"
          : "ORDER BY time_updated DESC, time_created DESC";
        const rows = db
          .prepare(`SELECT id, directory FROM session ${orderBy} LIMIT 50`)
          .all() as Array<{ id?: unknown; directory?: unknown }>;
        const matched = rows.find(
          (row) =>
            typeof row.id === "string" &&
            typeof row.directory === "string" &&
            sameWorkingDirectory(row.directory, cwd),
        );
        if (typeof matched?.id === "string") return matched.id;
        return typeof rows[0]?.id === "string" ? rows[0].id : null;
      }

      if (dbPath.endsWith("opencode.db")) {
        const row = db
          .prepare("SELECT id FROM session ORDER BY time_updated DESC, time_created DESC LIMIT 1")
          .get() as { id?: unknown } | undefined;
        return typeof row?.id === "string" ? row.id : null;
      }

      if (dbPath.endsWith("db.sqlite")) {
        const row = db
          .prepare("SELECT id FROM session ORDER BY time_updated DESC, time_created DESC, id DESC LIMIT 1")
          .get() as { id?: unknown } | undefined;
        return typeof row?.id === "string" ? row.id : null;
      }
    }
  } catch {
    // Ignore transient read errors.
  }

  return null;
}

function sqliteColumnExists(db: import("node:sqlite").DatabaseSync, tableName: "session", columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
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
    const match = line.match(/(\S*conversation-history[\\/]\S+?\.jsonl)\b/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractQoderRawIdFromPath(filePath: string): string | null {
  const match = filePath.match(/projects[\\/]([^\\/]+)[\\/]conversation-history[\\/]([^\\/]+)[\\/]/);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function splitCommandLine(command: string, platform?: NodeJS.Platform): string[] {
  if (platform === "win32") return splitWindowsCommandLine(command);

  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      const next = command[index + 1];
      if (next && (next === "\\" || next === '"' || next === "'" || /\s/.test(next))) {
        escaping = true;
        continue;
      }
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

function splitWindowsCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inQuote = false;
  let index = 0;

  while (index < command.length) {
    const char = command[index];
    if (char === "\\") {
      let backslashes = 0;
      while (command[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (command[index] === '"') {
        token += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          token += '"';
          index += 1;
        }
      } else {
        token += "\\".repeat(backslashes);
      }
      continue;
    }

    if (char === '"') {
      if (inQuote && command[index + 1] === '"') {
        token += '"';
        index += 2;
        continue;
      }
      inQuote = !inQuote;
      index += 1;
      continue;
    }

    if (!inQuote && /\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      index += 1;
      continue;
    }

    token += char;
    index += 1;
  }

  if (token) tokens.push(token);
  return tokens;
}

function parseWindowsProcessEntries(output: string): WindowsProcessEntry[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rawItems = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
      const entries: WindowsProcessEntry[] = [];
      for (const rawItem of rawItems) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const pid = typeof item.ProcessId === "number" ? item.ProcessId : Number(item.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const ppidRaw = typeof item.ParentProcessId === "number" ? item.ParentProcessId : Number(item.ParentProcessId);
        const ppid = Number.isInteger(ppidRaw) && ppidRaw > 0 ? ppidRaw : 0;
        const name = typeof item.Name === "string" ? item.Name.trim() : "";
        const executablePath = typeof item.ExecutablePath === "string" && item.ExecutablePath.trim() ? item.ExecutablePath.trim() : null;
        const commandLine = typeof item.CommandLine === "string" ? item.CommandLine.trim() : "";
        const command = commandLine || executablePath || name;
        if (!command) continue;
        entries.push({
          pid,
          ppid,
          name,
          executablePath,
          command,
          startedAtMs: parseWindowsCreationDate(item.CreationDate),
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map(parseProcessLine)
    .filter((entry): entry is ProcessEntry => Boolean(entry))
    .map((entry) => ({
      ...entry,
      ppid: 0,
      name: "",
      executablePath: null,
      startedAtMs: null,
    }));
}

function parseWindowsCreationDate(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const dotnetMatch = value.match(/\/Date\((-?\d+)/);
  if (dotnetMatch) {
    const ms = Number(dotnetMatch[1]);
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractCwdFromArgs(tokens: string[]): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const arg = tokens[index];
    if (arg === "--cd" || arg === "-C" || arg === "--cwd" || arg === "--workspace") {
      const value = tokens[index + 1]?.trim();
      if (value && !value.startsWith("-")) return value;
    }
    for (const prefix of ["--cd=", "-C=", "--cwd=", "--workspace="]) {
      if (arg.startsWith(prefix)) {
        const value = arg.slice(prefix.length).trim();
        if (value) return value;
      }
    }
  }
  return null;
}

function isElectronHelperArgs(tokens: string[]): boolean {
  return tokens
    .slice(1)
    .some((token) => /^--type=(?:renderer|gpu-process|utility|zygote|broker|sandbox|crashpad-handler|ppapi)/i.test(token));
}

function isPlainCodexNodeWrapper(tokens: string[]): boolean {
  if (!isNodeExecutable(tokens[0])) return false;
  const script = tokens[1];
  if (!script || isCodexDesktopProcess(script)) return false;
  const lower = script.toLowerCase().replace(/\\/g, "/");
  if (lower.includes("codex-code-mode-host")) return false;
  const isCodexScript = normalizedExecutableName(script) === "codex" || lower.includes("@openai/codex/bin/codex");
  if (!isCodexScript) return false;
  const args = tokens.slice(2);
  if (args.includes("app-server") || args.includes("resume")) return false;
  return true;
}

function isDesktopClaudeProcess(token: string | undefined): boolean {
  if (!token) return false;
  const lower = token.toLowerCase().replace(/\\/g, "/");
  return (
    lower.includes("/anthropicclaude/") ||
    lower.includes("/windowsapps/claude_") ||
    lower.includes("/claude desktop/") ||
    lower.includes(".app/contents/")
  );
}

function readClaudeProcessSessionMeta(homeDir: string, pid: number): { sessionId: string | null; cwd: string | null } | null {
  const sessionMetaPath = path.join(homeDir, ".claude", "sessions", `${pid}.json`);
  try {
    const raw = fs.readFileSync(sessionMetaPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown; cwd?: unknown };
    if (typeof parsed.pid === "number" && parsed.pid !== pid) return null;
    const sessionId = typeof parsed.sessionId === "string" && parsed.sessionId.trim() ? parsed.sessionId.trim() : null;
    const cwd = typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : null;
    if (!sessionId && !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

function dbBackedFamilyForTokens(
  tokens: string[],
  options: LoadLiveSessionOptions,
): "hermes" | "opencode" | "zcode" | "codewiz" | null {
  const index = isNodeExecutable(tokens[0]) ? 1 : 0;
  const family = executableFamily(tokens[index]);
  if (family === "hermes" && options.includeHermes !== false) return "hermes";
  if (family === "opencode" && options.includeOpenCode !== false) return "opencode";
  if (family === "zcode" && options.includeZcode !== false) return "zcode";
  if (family === "codewiz" && options.includeCodeWiz !== false) return "codewiz";
  return null;
}

function windowsDbPathForFamily(
  homeDir: string,
  family: "hermes" | "opencode" | "zcode" | "codewiz",
): string {
  const candidates =
    family === "hermes"
      ? [path.join(homeDir, ".hermes", "state.db")]
      : family === "zcode"
        ? [path.join(homeDir, ".zcode", "cli", "db", "db.sqlite")]
        : family === "codewiz"
          ? [
              path.join(homeDir, ".local", "share", "codewiz", "opencode.db"),
              path.join(homeDir, "AppData", "Local", "codewiz", "opencode.db"),
            ]
          : [
              path.join(homeDir, ".local", "share", "opencode", "opencode.db"),
              path.join(homeDir, "AppData", "Local", "opencode", "opencode.db"),
            ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

async function loadWindowsProcessCwds(pids: number[], runner: ProcessListRunner): Promise<Map<number, string>> {
  const validPids = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (validPids.length === 0) return new Map();

  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WinProcCwd {
  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_BASIC_INFORMATION {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr hObject);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

  private static IntPtr ReadPtr(IntPtr hProc, IntPtr addr) {
    byte[] buf = new byte[IntPtr.Size];
    IntPtr read;
    if (!ReadProcessMemory(hProc, addr, buf, buf.Length, out read) || read.ToInt32() != buf.Length) return IntPtr.Zero;
    return IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(buf, 0)) : new IntPtr(BitConverter.ToInt32(buf, 0));
  }

  public static string GetCwd(int pid) {
    IntPtr hProc = OpenProcess(0x1010, false, pid);
    if (hProc == IntPtr.Zero) return null;
    try {
      PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
      int retLen;
      if (NtQueryInformationProcess(hProc, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out retLen) != 0) return null;
      if (pbi.PebBaseAddress == IntPtr.Zero) return null;
      int paramsOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
      IntPtr procParams = ReadPtr(hProc, new IntPtr(pbi.PebBaseAddress.ToInt64() + paramsOffset));
      if (procParams == IntPtr.Zero) return null;
      int cwdOffset = IntPtr.Size == 8 ? 0x38 : 0x24;
      int uniSize = IntPtr.Size == 8 ? 16 : 8;
      byte[] uni = new byte[uniSize];
      IntPtr read;
      if (!ReadProcessMemory(hProc, new IntPtr(procParams.ToInt64() + cwdOffset), uni, uni.Length, out read) || read.ToInt32() != uni.Length) return null;
      ushort len = BitConverter.ToUInt16(uni, 0);
      if (len == 0 || len > 8192) return null;
      IntPtr strPtr = IntPtr.Size == 8 ? new IntPtr(BitConverter.ToInt64(uni, 8)) : new IntPtr(BitConverter.ToInt32(uni, 4));
      if (strPtr == IntPtr.Zero) return null;
      byte[] chars = new byte[len];
      if (!ReadProcessMemory(hProc, strPtr, chars, len, out read) || read.ToInt32() != len) return null;
      string raw = Encoding.Unicode.GetString(chars).TrimEnd('\\0');
      if (raw.Length > 3) raw = raw.TrimEnd('\\\\');
      return raw.Length > 0 ? raw : null;
    } finally {
      CloseHandle(hProc);
    }
  }
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$cwds = @{}
foreach ($targetPid in @(${validPids.join(", ")})) {
  try {
    $cwd = [WinProcCwd]::GetCwd($targetPid)
    if ($cwd) { $cwds[[string]$targetPid] = $cwd }
  } catch {}
}
$cwds | ConvertTo-Json -Compress`;

  const result = new Map<number, string>();
  try {
    const output = (await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).trim();
    if (!output || (!output.startsWith("{") && !output.startsWith("["))) return result;
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    for (const [key, value] of Object.entries(parsed)) {
      const pid = Number(key);
      if (Number.isInteger(pid) && pid > 0 && typeof value === "string" && value.trim()) {
        result.set(pid, value.trim());
      }
    }
  } catch {
    return result;
  }
  return result;
}

function normalizeComparableDirectory(dirPath: string): string {
  const slashed = dirPath.trim().replace(/[\\/]+/g, "/");
  if (slashed === "/" || /^[A-Za-z]:\/$/.test(slashed)) return slashed;
  return slashed.replace(/\/+$/, "");
}

function sameWorkingDirectory(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeComparableDirectory(left);
  const normalizedRight = normalizeComparableDirectory(right);
  if (normalizedLeft === normalizedRight) return true;
  const looksWindows =
    /^[A-Za-z]:\//.test(normalizedLeft) ||
    /^[A-Za-z]:\//.test(normalizedRight) ||
    normalizedLeft.startsWith("//") ||
    normalizedRight.startsWith("//");
  return looksWindows && normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

function execText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: command === "lsof" ? 1500 : undefined,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
