import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { IslandAppKind, IslandSignalSource, IslandSnapshot, IslandTask, IslandTaskStatus, IslandTaskTokens } from "../shared/ipc/island";
import {
  DEEPSEEK_HARNESS_DIR,
  DEEPSEEK_HARNESS_LOG_NAMES,
  decompressDeepSeekZstdFrame,
  scanDeepSeekZstdFrames,
} from "./deepseek-harness";
import { sessionSourceDescriptor } from "./session-sources";
import type { SessionSource } from "./types";

export interface IslandSignalEvent {
  source: SessionSource;
  sessionId: string;
  status: IslandTaskStatus;
  signalSource: IslandSignalSource;
  appKind?: IslandAppKind;
  projectPath?: string | null;
  title?: string | null;
  summary?: string | null;
  activeTool?: string | null;
  model?: string | null;
  tokens?: IslandTaskTokens | null;
  pid?: number | null;
  timestamp?: number;
}

export interface IslandStoreConfig {
  enabled: boolean;
  soundEnabled: boolean;
  suppressWhenFocused: boolean;
  autoCollapseSeconds: number;
}

export interface IslandIngestResult {
  changed: boolean;
  /** Non-null when this transition should alert the user in the expanded Dynamic Island. */
  alertedTask: IslandTask | null;
  snapshot: IslandSnapshot;
}

const MAX_TRACKED_TASKS = 24;
const COMPLETED_RETENTION_MS = 4 * 60 * 60 * 1000;
const STALE_RUNNING_MS = 30 * 60 * 1000;
const GATEWAY_DEDUPE_WINDOW_MS = 15_000;
const RECENT_FILE_WINDOW_MS = 15 * 60 * 1000;
const MAX_SUMMARY_LENGTH = 140;
const WATCH_DEBOUNCE_MS = 60;
const DEFAULT_FALLBACK_POLL_MS = 30_000;
const DEFAULT_LEGACY_POLL_MS = 3_000;
const DEEPSEEK_LOG_NAME_SET = new Set<string>(DEEPSEEK_HARNESS_LOG_NAMES);

type WatchRootKind = "deepseek" | "claude" | "codex" | "pi";

function matchesWatchFile(kind: WatchRootKind, filePath: string): boolean {
  const base = path.basename(filePath);
  if (!base) return false;
  if (kind === "deepseek") return DEEPSEEK_LOG_NAME_SET.has(base);
  if (kind === "claude") return base.endsWith(".jsonl") && !base.startsWith("agent-");
  return base.endsWith(".jsonl");
}

function compactText(value: string | null | undefined, max = MAX_SUMMARY_LENGTH): string {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function projectNameFromPath(projectPath: string | null | undefined): string {
  const trimmed = String(projectPath ?? "").trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  return path.basename(trimmed) || trimmed;
}

function defaultAppKindForSource(source: SessionSource): IslandAppKind {
  if (
    source === "deepseek-cli"
    || source === "claude-app"
    || source === "codex-app"
    || source === "cursor-agent"
    || source === "zcode-cli"
    || source === "workbuddy-cli"
    || source === "trae"
    || source === "qoder-ide"
    || source === "antigravity"
  ) {
    return "desktop";
  }
  return "terminal";
}

function taskStatusRank(status: IslandTaskStatus): number {
  if (status === "waiting_input") return 0;
  if (status === "error") return 1;
  if (status === "running") return 2;
  return 3;
}

export class IslandTaskStore {
  private readonly tasks = new Map<string, IslandTask>();
  private config: IslandStoreConfig;
  private muted = false;
  private highlightedTaskId: string | null = null;
  private highlightVersion = 0;

  constructor(
    config: IslandStoreConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...config };
  }

  updateConfig(config: Partial<IslandStoreConfig>): IslandSnapshot {
    this.config = { ...this.config, ...config };
    if (!this.config.enabled) this.highlightedTaskId = null;
    return this.snapshot();
  }

  setMuted(muted: boolean): IslandSnapshot {
    this.muted = Boolean(muted);
    if (this.muted) this.highlightedTaskId = null;
    return this.snapshot();
  }

  clearHighlight(expectedVersion?: number): IslandSnapshot {
    if (expectedVersion !== undefined && this.highlightVersion !== expectedVersion) {
      return this.snapshot();
    }
    this.highlightedTaskId = null;
    return this.snapshot();
  }

  attachSessionKey(taskId: string, sessionKey: string): void {
    const task = this.tasks.get(taskId);
    if (task && !task.sessionKey) {
      task.sessionKey = sessionKey;
    }
  }

  getTask(taskId: string): IslandTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  markRead(taskId: string): IslandSnapshot {
    const task = this.tasks.get(taskId);
    if (task) {
      task.unread = false;
      if (this.highlightedTaskId === taskId) this.highlightedTaskId = null;
    }
    return this.snapshot();
  }

  dismiss(taskId: string): IslandSnapshot {
    this.tasks.delete(taskId);
    if (this.highlightedTaskId === taskId) this.highlightedTaskId = null;
    return this.snapshot();
  }

  clearCompleted(): IslandSnapshot {
    for (const [id, task] of this.tasks) {
      if (task.status === "completed" || task.status === "error") {
        this.tasks.delete(id);
        if (this.highlightedTaskId === id) this.highlightedTaskId = null;
      }
    }
    return this.snapshot();
  }

  prune(): boolean {
    const current = this.now();
    let changed = false;
    for (const [id, task] of this.tasks) {
      const age = current - task.updatedAt;
      if ((task.status === "completed" || task.status === "error") && age > COMPLETED_RETENTION_MS) {
        this.tasks.delete(id);
        if (this.highlightedTaskId === id) this.highlightedTaskId = null;
        changed = true;
      } else if (task.status === "running" && age > STALE_RUNNING_MS) {
        this.tasks.delete(id);
        if (this.highlightedTaskId === id) this.highlightedTaskId = null;
        changed = true;
      }
    }
    if (this.tasks.size > MAX_TRACKED_TASKS) {
      const ordered = this.orderedTasks();
      for (const overflow of ordered.slice(MAX_TRACKED_TASKS)) {
        this.tasks.delete(overflow.id);
        if (this.highlightedTaskId === overflow.id) this.highlightedTaskId = null;
        changed = true;
      }
    }
    return changed;
  }

  ingest(event: IslandSignalEvent, options: { suppressAlert?: boolean } = {}): IslandIngestResult {
    const timestamp = event.timestamp ?? this.now();
    const id = `${event.source}:${event.sessionId}`;
    const existing = this.tasks.get(id) ?? this.findDedupeCandidate(event, timestamp);
    const taskId = existing?.id ?? id;
    const prevStatus = existing?.status ?? null;
    const descriptor = sessionSourceDescriptor(event.source);

    const projectPath = event.projectPath ?? existing?.projectPath ?? null;
    const projectName = projectNameFromPath(projectPath) || existing?.projectName || "";
    const title = compactText(event.title, 80) || existing?.title || projectName || descriptor.label;
    const summary = compactText(event.summary) || (
      event.status === "running"
        ? (event.activeTool ? `正在执行 ${event.activeTool}` : existing?.summary || "模型思考中…")
        : existing?.summary || ""
    );

    const isFreshRun = event.status === "running" && prevStatus !== "running";
    const startedAt = isFreshRun ? timestamp : (existing?.startedAt ?? timestamp);
    const completedAt = event.status === "completed" || event.status === "error"
      ? timestamp
      : (event.status === "running" ? null : existing?.completedAt ?? null);
    const durationMs = completedAt !== null ? Math.max(0, completedAt - startedAt) : null;

    // Avoid firing duplicate completion alerts when both gateway and log watcher observe the same turn.
    const alreadyTerminal = prevStatus === event.status
      && (event.status === "completed" || event.status === "error" || event.status === "waiting_input")
      && existing !== undefined
      && (timestamp - existing.updatedAt) < GATEWAY_DEDUPE_WINDOW_MS;

    const shouldAlert = !alreadyTerminal
      && !options.suppressAlert
      && !this.muted
      && this.config.enabled
      && (event.status === "completed" || event.status === "waiting_input" || event.status === "error");

    const next: IslandTask = {
      id: taskId,
      source: event.source,
      agentLabel: descriptor.label,
      appKind: event.appKind ?? existing?.appKind ?? defaultAppKindForSource(event.source),
      sessionId: existing?.sessionId || event.sessionId,
      sessionKey: existing?.sessionKey ?? null,
      projectPath,
      projectName,
      title,
      status: event.status,
      summary,
      activeTool: event.status === "running" ? (event.activeTool ?? existing?.activeTool ?? null) : null,
      model: event.model ?? existing?.model ?? null,
      startedAt,
      updatedAt: timestamp,
      completedAt,
      durationMs,
      tokens: event.tokens ?? existing?.tokens ?? null,
      pid: event.pid ?? existing?.pid ?? null,
      signalSource: event.signalSource,
      unread: event.status === "running"
        ? false
        : (shouldAlert ? true : (existing?.unread ?? false)),
    };

    this.tasks.set(taskId, next);
    this.prune();

    if (shouldAlert) {
      this.highlightedTaskId = taskId;
      this.highlightVersion += 1;
    } else if (event.status === "running" && this.highlightedTaskId === taskId) {
      this.highlightedTaskId = null;
    }

    return {
      changed: true,
      alertedTask: shouldAlert ? { ...next } : null,
      snapshot: this.snapshot(),
    };
  }

  snapshot(): IslandSnapshot {
    const tasks = this.orderedTasks();
    const highlightedTaskId = this.highlightedTaskId && this.tasks.has(this.highlightedTaskId)
      ? this.highlightedTaskId
      : null;
    return {
      enabled: this.config.enabled,
      muted: this.muted,
      soundEnabled: this.config.soundEnabled,
      suppressWhenFocused: this.config.suppressWhenFocused,
      autoCollapseSeconds: this.config.autoCollapseSeconds,
      tasks,
      highlightedTaskId,
      highlightVersion: this.highlightVersion,
    };
  }

  private orderedTasks(): IslandTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => {
        if (a.unread !== b.unread) return a.unread ? -1 : 1;
        const rankDiff = taskStatusRank(a.status) - taskStatusRank(b.status);
        if (rankDiff !== 0) return rankDiff;
        return b.updatedAt - a.updatedAt;
      })
      .map((task) => ({ ...task }));
  }

  private findDedupeCandidate(event: IslandSignalEvent, timestamp: number): IslandTask | undefined {
    // When a gateway signal lacks the agent's native session id (uses a synthetic gateway id),
    // merge with a very recent task from the same source so the user sees one clean card.
    if (event.signalSource !== "gateway" && event.signalSource !== "log") return undefined;
    for (const task of this.tasks.values()) {
      if (task.source !== event.source) continue;
      if (task.signalSource === event.signalSource) continue;
      if (Math.abs(timestamp - task.updatedAt) > GATEWAY_DEDUPE_WINDOW_MS) continue;
      if (task.sessionId.startsWith("gw-") || event.sessionId.startsWith("gw-")) {
        return task;
      }
    }
    return undefined;
  }
}

interface TrackedFileState {
  offset: number;
  mtimeMs: number;
  sessionId: string;
  projectPath: string | null;
  title: string | null;
  isSubagent: boolean;
  lastTurnCompleted?: number;
  pendingReplyText?: string;
}

export interface LocalSessionActivityMonitorOptions {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  pollIntervalMs?: number;
  now?: () => number;
  onEvent(event: IslandSignalEvent): void;
  onError?(message: string): void;
}

/**
 * Event-driven incremental monitor for local agent session logs (DSH Desktop/CLI,
 * Claude Code, Codex, Pi). Uses OS-native recursive `fs.watch` (FSEvents on macOS,
 * ReadDirectoryChangesW on Windows) to tail only newly appended bytes of changed files
 * with ~60ms latency, plus a slow safety-net rescan for newly created root directories.
 */
export class LocalSessionActivityMonitor {
  private readonly files = new Map<string, TrackedFileState>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly pendingFileTimers = new Map<string, NodeJS.Timeout>();
  private readonly inFlightFiles = new Set<string>();
  private readonly dirtyFiles = new Map<string, { kind: WatchRootKind; emit: boolean }>();
  private timer: NodeJS.Timeout | null = null;
  private baselinePromise: Promise<void> | null = null;
  private overflowScanTimer: NodeJS.Timeout | null = null;
  private scanning = false;
  private initialized = false;
  private running = false;
  private stopped = false;

  constructor(private readonly options: LocalSessionActivityMonitorOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.ensureWatchers();
    this.baselinePromise = this.scanOnce().finally(() => {
      this.baselinePromise = null;
    });
    const fallbackMs = this.options.pollIntervalMs !== undefined
      ? Math.max(500, this.options.pollIntervalMs)
      : (this.supportsRecursiveWatch() ? DEFAULT_FALLBACK_POLL_MS : DEFAULT_LEGACY_POLL_MS);
    this.timer = setInterval(() => {
      this.ensureWatchers();
      void this.scanOnce();
    }, fallbackMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.overflowScanTimer) {
      clearTimeout(this.overflowScanTimer);
      this.overflowScanTimer = null;
    }
    for (const timer of this.pendingFileTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFileTimers.clear();
    this.dirtyFiles.clear();
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore already-closed OS watcher handles during teardown.
      }
    }
    this.watchers.clear();
  }

  async scanOnce(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    const emit = this.initialized;
    try {
      const nowMs = (this.options.now ?? Date.now)();
      const cutoff = nowMs - RECENT_FILE_WINDOW_MS;
      await Promise.all([
        this.scanDeepSeekFiles(cutoff, emit),
        this.scanClaudeFiles(cutoff, emit),
        this.scanCodexFiles(cutoff, emit),
        this.scanPiFiles(cutoff, emit),
      ]);
      this.initialized = true;
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.scanning = false;
    }
  }

  private supportsRecursiveWatch(): boolean {
    return process.platform === "darwin" || process.platform === "win32";
  }

  private watchRoots(): Array<{ kind: WatchRootKind; root: string }> {
    const dshHome = this.options.env?.DSH_HOME?.trim() || path.join(this.options.homeDir, DEEPSEEK_HARNESS_DIR);
    const claudeHome = this.options.env?.CLAUDE_CONFIG_DIR?.trim() || path.join(this.options.homeDir, ".claude");
    const codexHome = this.options.env?.CODEX_HOME?.trim() || path.join(this.options.homeDir, ".codex");
    const piRoot = this.options.env?.PI_CODING_AGENT_DIR?.trim() || path.join(this.options.homeDir, ".pi", "agent");
    return [
      { kind: "deepseek", root: path.join(dshHome, "sessions") },
      { kind: "claude", root: path.join(claudeHome, "projects") },
      { kind: "codex", root: path.join(codexHome, "sessions") },
      { kind: "pi", root: path.join(piRoot, "sessions") },
    ];
  }

  private ensureWatchers(): void {
    if (this.stopped || !this.supportsRecursiveWatch()) return;
    for (const { kind, root } of this.watchRoots()) {
      const key = `${kind}:${root}`;
      if (this.watchers.has(key)) continue;
      if (!fs.existsSync(root)) continue;
      try {
        const watcher = fs.watch(root, { recursive: true, persistent: false }, (_eventType, rawFilename) => {
          this.handleWatchEvent(kind, root, rawFilename);
        });
        watcher.on("error", () => {
          try {
            watcher.close();
          } catch {
            // Ignore double-close on errored watcher.
          }
          if (this.watchers.get(key) === watcher) {
            this.watchers.delete(key);
          }
        });
        this.watchers.set(key, watcher);
      } catch {
        // Missing permissions or unsupported filesystem; fallback safety-net scan continues covering this root.
      }
    }
  }

  private handleWatchEvent(kind: WatchRootKind, root: string, rawFilename: string | Buffer | null): void {
    if (this.stopped) return;
    const rel = typeof rawFilename === "string"
      ? rawFilename
      : (Buffer.isBuffer(rawFilename) ? rawFilename.toString("utf8") : "");
    if (!rel) {
      this.scheduleOverflowScan();
      return;
    }
    const fullPath = path.join(root, rel);
    if (!matchesWatchFile(kind, fullPath)) return;

    const existingTimer = this.pendingFileTimers.get(fullPath);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      this.pendingFileTimers.delete(fullPath);
      void this.flushWatchedFile(kind, fullPath);
    }, WATCH_DEBOUNCE_MS);
    timer.unref();
    this.pendingFileTimers.set(fullPath, timer);
  }

  private scheduleOverflowScan(): void {
    if (this.stopped || this.overflowScanTimer) return;
    this.overflowScanTimer = setTimeout(() => {
      this.overflowScanTimer = null;
      void this.scanOnce();
    }, 150);
    this.overflowScanTimer.unref();
  }

  private async flushWatchedFile(kind: WatchRootKind, filePath: string): Promise<void> {
    if (this.stopped) return;
    if (this.baselinePromise) {
      try {
        await this.baselinePromise;
      } catch {
        // Baseline error already reported by scanOnce; continue if initialized.
      }
    }
    if (this.stopped || !this.initialized) return;
    await this.processSingleFile(kind, filePath, true);
  }

  private async processSingleFile(
    kind: WatchRootKind,
    filePath: string,
    emit: boolean,
    knownStat?: { size: number; mtimeMs: number },
  ): Promise<void> {
    if (this.stopped) return;
    if (this.inFlightFiles.has(filePath)) {
      this.dirtyFiles.set(filePath, { kind, emit: emit || this.initialized });
      return;
    }
    this.inFlightFiles.add(filePath);
    try {
      const stat = knownStat ?? await safeStat(filePath);
      if (!stat) return;
      if (kind === "deepseek") {
        await this.processDeepSeekFile(filePath, stat.size, stat.mtimeMs, emit);
      } else if (kind === "claude") {
        await this.processClaudeFile(filePath, stat.size, stat.mtimeMs, emit);
      } else if (kind === "codex") {
        await this.processCodexFile(filePath, stat.size, stat.mtimeMs, emit);
      } else {
        await this.processPiFile(filePath, stat.size, stat.mtimeMs, emit);
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      this.inFlightFiles.delete(filePath);
      const rerun = this.dirtyFiles.get(filePath);
      if (rerun && !this.stopped) {
        this.dirtyFiles.delete(filePath);
        void this.processSingleFile(rerun.kind, filePath, rerun.emit || this.initialized);
      }
    }
  }

  private async scanDeepSeekFiles(cutoffMs: number, emit: boolean): Promise<void> {
    const dshHome = this.options.env?.DSH_HOME?.trim() || path.join(this.options.homeDir, DEEPSEEK_HARNESS_DIR);
    const sessionsRoot = path.join(dshHome, "sessions");
    const projectDirs = await listSubdirs(sessionsRoot);
    for (const projectDir of projectDirs) {
      const sessionDirs = await listSubdirs(projectDir);
      for (const sessionDir of sessionDirs) {
        const logFile = await pickDeepSeekLogFile(sessionDir);
        if (!logFile) continue;
        const stat = await safeStat(logFile);
        if (!stat || stat.mtimeMs < cutoffMs) continue;
        await this.processSingleFile("deepseek", logFile, emit, stat);
      }
    }
  }

  private async processDeepSeekFile(filePath: string, size: number, mtimeMs: number, emit: boolean): Promise<void> {
    let state = this.files.get(filePath);
    if (state && state.offset === size && state.mtimeMs === mtimeMs) return;
    if (state && size < state.offset) {
      // File was truncated or rewritten; reset cleanly.
      state = undefined;
    }

    const startOffset = state?.offset ?? 0;
    const slice = await readFileRange(filePath, startOffset, size);
    if (!slice || slice.length === 0) return;

    let frames: ReturnType<typeof scanDeepSeekZstdFrames>;
    try {
      frames = scanDeepSeekZstdFrames(slice);
    } catch {
      return;
    }
    if (frames.length === 0) return;

    let current: TrackedFileState = state ?? {
      offset: 0,
      mtimeMs,
      sessionId: path.basename(path.dirname(filePath)),
      projectPath: null,
      title: null,
      isSubagent: false,
    };

    const emitted: IslandSignalEvent[] = [];
    let advanced = 0;

    for (const frame of frames) {
      let text: string;
      try {
        text = decompressDeepSeekZstdFrame(slice, frame);
      } catch {
        break;
      }
      if (!text.endsWith("\n")) break;
      advanced = frame.end;

      for (const rawLine of text.split("\n")) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        let record: Record<string, unknown>;
        try {
          const parsed = JSON.parse(trimmed);
          if (!parsed || typeof parsed !== "object") continue;
          record = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = typeof record.type === "string" ? record.type : "";
        if (type === "session") {
          if (typeof record.id === "string" && record.id) current.sessionId = record.id;
          if (typeof record.cwd === "string" && record.cwd) current.projectPath = record.cwd;
          if (typeof record.parentSession === "string" && record.parentSession) current.isSubagent = true;
          continue;
        }
        const data = asRecord(record.data);
        const time = typeof record.time === "number" && Number.isFinite(record.time) ? record.time : mtimeMs;
        if (type === "session/title") {
          const title = typeof data?.title === "string" ? data.title.trim() : "";
          if (title) current.title = title;
          continue;
        }
        if (current.isSubagent || !emit) continue;

        if (type === "turn/start" || type === "step/start") {
          current.pendingReplyText = undefined;
          emitted.push({
            source: "deepseek-cli",
            sessionId: current.sessionId,
            status: "running",
            signalSource: "log",
            projectPath: current.projectPath,
            title: current.title,
            summary: "模型思考中…",
            timestamp: time,
          });
        } else if (type === "user/message") {
          const sourceKind = asRecord(data?.source)?.kind;
          if (sourceKind && sourceKind !== "user") continue;
          const promptText = extractDeepSeekText(data?.content);
          if (!current.title && promptText) current.title = compactText(promptText, 64);
          current.pendingReplyText = undefined;
          emitted.push({
            source: "deepseek-cli",
            sessionId: current.sessionId,
            status: "running",
            signalSource: "log",
            projectPath: current.projectPath,
            title: current.title,
            summary: promptText ? `处理中：${compactText(promptText, 80)}` : "模型思考中…",
            timestamp: time,
          });
        } else if (type === "tool/call") {
          const toolName = typeof data?.name === "string" && data.name ? data.name : "tool";
          emitted.push({
            source: "deepseek-cli",
            sessionId: current.sessionId,
            status: "running",
            signalSource: "log",
            projectPath: current.projectPath,
            title: current.title,
            activeTool: toolName,
            summary: `正在执行 ${toolName}`,
            timestamp: time,
          });
        } else if (type === "permission/request" || type === "approval/request" || type === "input/request") {
          const prompt = typeof data?.message === "string" ? data.message : (typeof data?.tool === "string" ? `等待确认：${data.tool}` : "等待你的确认");
          emitted.push({
            source: "deepseek-cli",
            sessionId: current.sessionId,
            status: "waiting_input",
            signalSource: "log",
            projectPath: current.projectPath,
            title: current.title,
            summary: prompt,
            timestamp: time,
          });
        } else if (type === "assistant/message") {
          const msg = asRecord(data?.message);
          const content = msg?.content;
          const parts = Array.isArray(content) ? content.map(asRecord) : [];
          const hasToolCall = parts.some((part) => part?.type === "tool-call");
          const replyText = extractDeepSeekText(content);
          const usage = extractDeepSeekTokens(data?.usage);
          const turnNumber = typeof data?.turn === "number" ? data.turn : undefined;
          if (!hasToolCall && replyText) {
            current.pendingReplyText = replyText;
            current.lastTurnCompleted = turnNumber;
            emitted.push({
              source: "deepseek-cli",
              sessionId: current.sessionId,
              status: "completed",
              signalSource: "log",
              projectPath: current.projectPath,
              title: current.title,
              summary: replyText,
              tokens: usage,
              timestamp: time,
            });
          }
        } else if (type === "turn/end") {
          const reason = asRecord(data?.reason);
          const kind = typeof reason?.kind === "string" ? reason.kind : "completed";
          const turnNumber = typeof data?.turn === "number" ? data.turn : undefined;
          if (kind === "error") {
            const errMsg = typeof asRecord(reason?.error)?.message === "string"
              ? String(asRecord(reason?.error)?.message)
              : "本轮执行出错";
            emitted.push({
              source: "deepseek-cli",
              sessionId: current.sessionId,
              status: "error",
              signalSource: "log",
              projectPath: current.projectPath,
              title: current.title,
              summary: errMsg,
              timestamp: time,
            });
          } else if (kind !== "cancelled" && kind !== "aborted") {
            if (turnNumber === undefined || current.lastTurnCompleted !== turnNumber) {
              current.lastTurnCompleted = turnNumber;
              emitted.push({
                source: "deepseek-cli",
                sessionId: current.sessionId,
                status: "completed",
                signalSource: "log",
                projectPath: current.projectPath,
                title: current.title,
                summary: current.pendingReplyText || "模型已回复完成",
                timestamp: time,
              });
            }
          }
        }
      }
    }

    current.offset = startOffset + advanced;
    current.mtimeMs = mtimeMs;
    this.files.set(filePath, current);
    if (emit && !current.isSubagent) {
      for (const item of coalesceEvents(emitted)) {
        this.options.onEvent(item);
      }
    }
  }

  private async scanClaudeFiles(cutoffMs: number, emit: boolean): Promise<void> {
    const claudeHome = this.options.env?.CLAUDE_CONFIG_DIR?.trim() || path.join(this.options.homeDir, ".claude");
    const projectsRoot = path.join(claudeHome, "projects");
    const projectDirs = await listSubdirs(projectsRoot);
    for (const dir of projectDirs) {
      const entries = await listFiles(dir, (name) => name.endsWith(".jsonl") && !name.startsWith("agent-"));
      for (const filePath of entries) {
        const stat = await safeStat(filePath);
        if (!stat || stat.mtimeMs < cutoffMs) continue;
        await this.processSingleFile("claude", filePath, emit, stat);
      }
    }
  }

  private async processClaudeFile(filePath: string, size: number, mtimeMs: number, emit: boolean): Promise<void> {
    const delta = await this.readJsonlDelta(filePath, size, mtimeMs, path.basename(filePath, ".jsonl"));
    if (!delta) return;
    const { state, lines } = delta;
    const emitted: IslandSignalEvent[] = [];

    for (const record of lines) {
      if (record.isSidechain === true) state.isSubagent = true;
      if (typeof record.sessionId === "string" && record.sessionId) state.sessionId = record.sessionId;
      if (typeof record.cwd === "string" && record.cwd) state.projectPath = record.cwd;
      if (state.isSubagent || !emit) continue;

      const type = typeof record.type === "string" ? record.type : "";
      const time = parseIsoTime(record.timestamp, mtimeMs);
      const message = asRecord(record.message);

      if (type === "user") {
        const content = message?.content;
        const isOnlyToolResults = Array.isArray(content) && content.length > 0 && content.every((item) => asRecord(item)?.type === "tool_result");
        if (isOnlyToolResults) continue;
        const prompt = extractTextFromBlocks(content);
        if (!state.title && prompt) state.title = compactText(prompt, 64);
        emitted.push({
          source: "claude-cli",
          sessionId: state.sessionId,
          status: "running",
          signalSource: "log",
          appKind: "terminal",
          projectPath: state.projectPath,
          title: state.title,
          summary: prompt ? `处理中：${compactText(prompt, 80)}` : "模型思考中…",
          timestamp: time,
        });
      } else if (type === "assistant" && message) {
        const content = message.content;
        const blocks = Array.isArray(content) ? content.map(asRecord) : [];
        const toolUse = blocks.find((block) => block?.type === "tool_use");
        const stopReason = typeof message.stop_reason === "string" ? message.stop_reason : "";
        const model = typeof message.model === "string" ? message.model : null;
        const usage = extractAnthropicTokens(message.usage);
        if (toolUse) {
          const toolName = typeof toolUse.name === "string" ? toolUse.name : "tool";
          emitted.push({
            source: "claude-cli",
            sessionId: state.sessionId,
            status: "running",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            activeTool: toolName,
            model,
            summary: `正在执行 ${toolName}`,
            timestamp: time,
          });
        } else if (stopReason === "end_turn" || (stopReason !== "tool_use" && extractTextFromBlocks(content))) {
          const text = extractTextFromBlocks(content) || "回复已完成";
          emitted.push({
            source: "claude-cli",
            sessionId: state.sessionId,
            status: "completed",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            model,
            summary: text,
            tokens: usage,
            timestamp: time,
          });
        }
      }
    }

    if (emit && !state.isSubagent) {
      for (const item of coalesceEvents(emitted)) this.options.onEvent(item);
    }
  }

  private async scanCodexFiles(cutoffMs: number, emit: boolean): Promise<void> {
    const codexHome = this.options.env?.CODEX_HOME?.trim() || path.join(this.options.homeDir, ".codex");
    const sessionsRoot = path.join(codexHome, "sessions");
    const files = await collectRecentJsonl(sessionsRoot, cutoffMs, 3);
    for (const { filePath, size, mtimeMs } of files) {
      await this.processSingleFile("codex", filePath, emit, { size, mtimeMs });
    }
  }

  private async processCodexFile(filePath: string, size: number, mtimeMs: number, emit: boolean): Promise<void> {
    const delta = await this.readJsonlDelta(filePath, size, mtimeMs, path.basename(filePath, ".jsonl"));
    if (!delta) return;
    const { state, lines } = delta;
    const emitted: IslandSignalEvent[] = [];

    for (const record of lines) {
      const type = typeof record.type === "string" ? record.type : "";
      const payload = asRecord(record.payload);
      const time = parseIsoTime(record.timestamp, mtimeMs);

      if (type === "session_meta" && payload) {
        if (typeof payload.id === "string" && payload.id) state.sessionId = payload.id;
        if (typeof payload.cwd === "string" && payload.cwd) state.projectPath = payload.cwd;
        if (asRecord(payload.source)?.subagent) state.isSubagent = true;
        continue;
      }
      if (state.isSubagent || !emit) continue;

      if (type === "event_msg" && payload) {
        const msgType = typeof payload.type === "string" ? payload.type : "";
        if (msgType === "task_started" || msgType === "user_message") {
          const text = typeof payload.message === "string" ? payload.message : "";
          if (!state.title && text) state.title = compactText(text, 64);
          emitted.push({
            source: "codex-cli",
            sessionId: state.sessionId,
            status: "running",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            summary: text ? `处理中：${compactText(text, 80)}` : "模型思考中…",
            timestamp: time,
          });
        } else if (msgType === "task_complete") {
          const reply = typeof payload.last_agent_message === "string" ? payload.last_agent_message : state.pendingReplyText;
          emitted.push({
            source: "codex-cli",
            sessionId: state.sessionId,
            status: "completed",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            summary: reply || "任务已完成",
            timestamp: time,
          });
        } else if (msgType === "error") {
          emitted.push({
            source: "codex-cli",
            sessionId: state.sessionId,
            status: "error",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            summary: typeof payload.message === "string" ? payload.message : "Codex 执行出错",
            timestamp: time,
          });
        }
      } else if (type === "response_item" && payload) {
        if (payload.type === "function_call" || payload.type === "custom_tool_call") {
          const toolName = typeof payload.name === "string" ? payload.name : "tool";
          emitted.push({
            source: "codex-cli",
            sessionId: state.sessionId,
            status: "running",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            activeTool: toolName,
            summary: `正在执行 ${toolName}`,
            timestamp: time,
          });
        } else if (payload.type === "message" && payload.role === "assistant") {
          const text = extractTextFromBlocks(payload.content);
          if (text) state.pendingReplyText = text;
        }
      }
    }

    if (emit && !state.isSubagent) {
      for (const item of coalesceEvents(emitted)) this.options.onEvent(item);
    }
  }

  private async scanPiFiles(cutoffMs: number, emit: boolean): Promise<void> {
    const piRoot = this.options.env?.PI_CODING_AGENT_DIR?.trim() || path.join(this.options.homeDir, ".pi", "agent");
    const sessionsRoot = path.join(piRoot, "sessions");
    const files = await collectRecentJsonl(sessionsRoot, cutoffMs, 3);
    for (const { filePath, size, mtimeMs } of files) {
      await this.processSingleFile("pi", filePath, emit, { size, mtimeMs });
    }
  }

  private async processPiFile(filePath: string, size: number, mtimeMs: number, emit: boolean): Promise<void> {
    const delta = await this.readJsonlDelta(filePath, size, mtimeMs, path.basename(filePath, ".jsonl"));
    if (!delta) return;
    const { state, lines } = delta;
    const emitted: IslandSignalEvent[] = [];

    for (const record of lines) {
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "session") {
        if (typeof record.id === "string" && record.id) state.sessionId = record.id;
        if (typeof record.cwd === "string" && record.cwd) state.projectPath = record.cwd;
        if (typeof record.parentSession === "string" && record.parentSession) state.isSubagent = true;
        continue;
      }
      if (state.isSubagent || !emit || type !== "message") continue;
      const message = asRecord(record.message);
      if (!message) continue;
      const time = parseIsoTime(record.timestamp, mtimeMs);
      if (message.role === "user") {
        const prompt = extractTextFromBlocks(message.content);
        if (!state.title && prompt) state.title = compactText(prompt, 64);
        emitted.push({
          source: "pi-cli",
          sessionId: state.sessionId,
          status: "running",
          signalSource: "log",
          appKind: "terminal",
          projectPath: state.projectPath,
          title: state.title,
          summary: prompt ? `处理中：${compactText(prompt, 80)}` : "模型思考中…",
          timestamp: time,
        });
      } else if (message.role === "assistant") {
        const blocks = Array.isArray(message.content) ? message.content.map(asRecord) : [];
        const toolCall = blocks.find((block) => block?.type === "toolCall");
        const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
        if (toolCall || stopReason === "toolUse") {
          const toolName = typeof toolCall?.name === "string" ? toolCall.name : "tool";
          emitted.push({
            source: "pi-cli",
            sessionId: state.sessionId,
            status: "running",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            activeTool: toolName,
            summary: `正在执行 ${toolName}`,
            timestamp: time,
          });
        } else if (stopReason === "error") {
          emitted.push({
            source: "pi-cli",
            sessionId: state.sessionId,
            status: "error",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            summary: typeof message.errorMessage === "string" ? message.errorMessage : "Pi 执行出错",
            timestamp: time,
          });
        } else {
          emitted.push({
            source: "pi-cli",
            sessionId: state.sessionId,
            status: "completed",
            signalSource: "log",
            appKind: "terminal",
            projectPath: state.projectPath,
            title: state.title,
            summary: extractTextFromBlocks(message.content) || "回复已完成",
            timestamp: time,
          });
        }
      }
    }

    if (emit && !state.isSubagent) {
      for (const item of coalesceEvents(emitted)) this.options.onEvent(item);
    }
  }

  private async readJsonlDelta(
    filePath: string,
    size: number,
    mtimeMs: number,
    fallbackSessionId: string,
  ): Promise<{ state: TrackedFileState; lines: Record<string, unknown>[] } | null> {
    let state = this.files.get(filePath);
    if (state && state.offset === size && state.mtimeMs === mtimeMs) return null;
    if (state && size < state.offset) state = undefined;

    const startOffset = state?.offset ?? 0;
    const slice = await readFileRange(filePath, startOffset, size);
    if (!slice || slice.length === 0) return null;
    const text = slice.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return null;

    const completeText = text.slice(0, lastNewline + 1);
    const byteAdvance = Buffer.byteLength(completeText, "utf8");
    const current: TrackedFileState = state ?? {
      offset: 0,
      mtimeMs,
      sessionId: fallbackSessionId,
      projectPath: null,
      title: null,
      isSubagent: false,
    };

    const lines: Record<string, unknown>[] = [];
    for (const raw of completeText.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") lines.push(parsed as Record<string, unknown>);
      } catch {
        // Ignore partially written or non-object JSONL rows.
      }
    }

    current.offset = startOffset + byteAdvance;
    current.mtimeMs = mtimeMs;
    this.files.set(filePath, current);
    return { state: current, lines };
  }
}

function coalesceEvents(events: IslandSignalEvent[]): IslandSignalEvent[] {
  if (events.length <= 1) return events;
  // Within one incremental scan tick, keep only the final state for each session
  // (preferring terminal completion/error if the turn both started and finished in one write).
  return [events[events.length - 1]];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractDeepSeekText(content: unknown): string {
  if (typeof content === "string") return compactText(content);
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      texts.push(block.text.trim());
    }
  }
  return compactText(texts.join(" "));
}

function extractTextFromBlocks(content: unknown): string {
  if (typeof content === "string") return compactText(content);
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block) continue;
    if ((block.type === "text" || block.type === "output_text" || block.type === "input_text") && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return compactText(texts.join(" "));
}

function extractDeepSeekTokens(value: unknown): IslandTaskTokens | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cached = num(usage.cacheReadTokens);
  if (input === 0 && output === 0 && cached === 0) return null;
  return { input, output, cached };
}

function extractAnthropicTokens(value: unknown): IslandTaskTokens | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cached = num(usage.cache_read_input_tokens);
  if (input === 0 && output === 0 && cached === 0) return null;
  return { input, output, cached };
}

function parseIsoTime(value: unknown, fallbackMs: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

async function safeStat(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function listSubdirs(root: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function listFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && predicate(entry.name)).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function pickDeepSeekLogFile(sessionDir: string): Promise<string | null> {
  for (const name of DEEPSEEK_HARNESS_LOG_NAMES) {
    const candidate = path.join(sessionDir, name);
    if (await safeStat(candidate)) return candidate;
  }
  return null;
}

async function collectRecentJsonl(
  root: string,
  cutoffMs: number,
  maxDepth: number,
): Promise<Array<{ filePath: string; size: number; mtimeMs: number }>> {
  const found: Array<{ filePath: string; size: number; mtimeMs: number }> = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await safeStat(full);
        if (stat && stat.mtimeMs >= cutoffMs) {
          found.push({ filePath: full, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  await walk(root, 0);
  return found;
}

async function readFileRange(filePath: string, start: number, end: number): Promise<Buffer | null> {
  const length = end - start;
  if (length <= 0) return null;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return bytesRead > 0 ? buffer.subarray(0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
