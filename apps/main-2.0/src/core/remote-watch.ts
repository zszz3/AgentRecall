import { spawn } from "node:child_process";
import { buildRemoteSyncSshArgs } from "./remote-sync";
import { spawnRemoteCommand } from "./remote-process";
import type { SessionEnvironment } from "./types";

export interface WatchHandle {
  stop: () => void;
}

export interface RemoteWatchManagerOptions {
  startWatcher?: (environment: SessionEnvironment, onEvent: () => void, onUnavailable?: () => void) => WatchHandle;
  syncEnvironment: (environment: SessionEnvironment) => Promise<void>;
  onSyncError?: (environment: SessionEnvironment, error: unknown) => void;
  onModeChange?: (environment: SessionEnvironment, mode: "event" | "polling") => void;
  debounceMs?: number;
  pollIntervalMs?: number;
  pollRecoveryMs?: number;
  /** Maximum number of polling-to-event recovery attempts per watcher lifetime. */
  maxRecoveryAttempts?: number;
  /** Exponential factor applied after each failed recovery attempt. */
  recoveryBackoffFactor?: number;
  /** Optional bounded jitter to avoid all WSL distributions reconnecting together. */
  recoveryJitterMs?: number;
  random?: () => number;
}

export class RemoteWatchManager {
  private nextToken = 1;
  private readonly activeTokens = new Map<string, number>();
  private readonly handles = new Map<string, WatchHandle>();
  private readonly inFlightEnvironmentTokens = new Map<string, number>();
  private readonly pendingSyncEnvironmentTokens = new Map<string, number>();
  private readonly pollingEnvironmentIds = new Set<string>();
  private readonly pollRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly recoveryAttempts = new Map<string, number>();
  private readonly pollingEnvironments = new Map<string, { environment: SessionEnvironment; token: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly options: Required<RemoteWatchManagerOptions>;

  constructor(options: RemoteWatchManagerOptions) {
    this.options = {
      startWatcher: options.startWatcher ?? startSystemWatcher,
      syncEnvironment: options.syncEnvironment,
      onSyncError: options.onSyncError ?? (() => undefined),
      onModeChange: options.onModeChange ?? (() => undefined),
      debounceMs: options.debounceMs ?? 600,
      pollIntervalMs: options.pollIntervalMs ?? 60_000,
      pollRecoveryMs: options.pollRecoveryMs ?? 300_000,
      maxRecoveryAttempts: Math.max(1, Math.floor(options.maxRecoveryAttempts ?? 6)),
      recoveryBackoffFactor: Math.max(1, options.recoveryBackoffFactor ?? 2),
      recoveryJitterMs: Math.max(0, options.recoveryJitterMs ?? 0),
      random: options.random ?? Math.random,
    };
  }

  start(environment: SessionEnvironment): void {
    if (this.handles.has(environment.id) || !environment.enabled || (environment.kind !== "ssh" && environment.kind !== "wsl")) return;
    const token = this.nextToken;
    this.nextToken += 1;
    this.activeTokens.set(environment.id, token);
    try {
      let handle: WatchHandle | null = null;
      handle = this.options.startWatcher(
        environment,
        () => {
          if (this.isActive(environment.id, token) && !this.pollingEnvironmentIds.has(environment.id)) {
            this.recoveryAttempts.delete(environment.id);
            this.scheduleSync(environment, token);
          }
        },
        () => {
          if (this.isActive(environment.id, token)) this.startPolling(environment, token, handle ?? undefined);
        },
      );
      if (!this.isActive(environment.id, token) || this.pollingEnvironmentIds.has(environment.id)) handle.stop();
      else {
        this.handles.set(environment.id, handle);
        this.options.onModeChange(environment, "event");
      }
    } catch {
      if (this.isActive(environment.id, token)) this.startPolling(environment, token);
    }
  }

  stop(environmentId: string): void {
    this.clearSyncTimer(environmentId);
    this.handles.get(environmentId)?.stop();
    this.handles.delete(environmentId);
    this.inFlightEnvironmentTokens.delete(environmentId);
    this.pollingEnvironmentIds.delete(environmentId);
    this.pollingEnvironments.delete(environmentId);
    const recovery = this.pollRecoveryTimers.get(environmentId);
    if (recovery) clearTimeout(recovery);
    this.pollRecoveryTimers.delete(environmentId);
    this.recoveryAttempts.delete(environmentId);
    this.pendingSyncEnvironmentTokens.delete(environmentId);
    this.activeTokens.delete(environmentId);
  }

  stopAll(): void {
    for (const id of [...this.handles.keys()]) this.stop(id);
  }

  /** Apply a settings change to already-running polling watchers. */
  updatePollingInterval(pollIntervalMs: number): void {
    this.options.pollIntervalMs = Math.max(1_000, Math.round(pollIntervalMs));
    for (const [environmentId, state] of this.pollingEnvironments) {
      if (!this.isActive(environmentId, state.token) || !this.pollingEnvironmentIds.has(environmentId)) continue;
      this.handles.get(environmentId)?.stop();
      const timer = setInterval(() => this.runSync(state.environment, state.token), this.options.pollIntervalMs);
      this.handles.set(environmentId, { stop: () => clearInterval(timer) });
    }
  }

  private scheduleSync(environment: SessionEnvironment, token: number): void {
    const existing = this.timers.get(environment.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.timers.get(environment.id) === timer) {
        this.timers.delete(environment.id);
      }
      if (this.isActive(environment.id, token) && !this.pollingEnvironmentIds.has(environment.id)) this.runSync(environment, token);
    }, this.options.debounceMs);
    this.timers.set(environment.id, timer);
  }

  private startPolling(environment: SessionEnvironment, token: number, fallbackHandle?: WatchHandle): void {
    if (!this.isActive(environment.id, token)) return;
    if (this.pollingEnvironmentIds.has(environment.id)) return;
    this.clearSyncTimer(environment.id);
    const existing = this.handles.get(environment.id);
    existing?.stop();
    if (fallbackHandle && fallbackHandle !== existing) fallbackHandle.stop();
    this.handles.delete(environment.id);
    const timer = setInterval(() => {
      this.runSync(environment, token);
    }, this.options.pollIntervalMs);
    this.handles.set(environment.id, { stop: () => clearInterval(timer) });
    this.pollingEnvironmentIds.add(environment.id);
    this.pollingEnvironments.set(environment.id, { environment, token });
    this.options.onModeChange(environment, "polling");
    const attempt = this.recoveryAttempts.get(environment.id) ?? 0;
    if (attempt >= this.options.maxRecoveryAttempts) return;
    this.recoveryAttempts.set(environment.id, attempt + 1);
    const backoff = this.options.pollRecoveryMs * this.options.recoveryBackoffFactor ** attempt;
    const jitter = this.options.recoveryJitterMs > 0
      ? Math.floor(this.options.random() * (this.options.recoveryJitterMs + 1))
      : 0;
    const recovery = setTimeout(() => {
      this.pollRecoveryTimers.delete(environment.id);
      if (!this.isActive(environment.id, token) || !this.pollingEnvironmentIds.has(environment.id)) return;
      this.handles.get(environment.id)?.stop();
      this.handles.delete(environment.id);
      this.pollingEnvironmentIds.delete(environment.id);
      this.start(environment);
    }, backoff + jitter);
    this.pollRecoveryTimers.set(environment.id, recovery);
  }

  private runSync(environment: SessionEnvironment, token: number): void {
    if (!this.isActive(environment.id, token)) return;
    if (this.inFlightEnvironmentTokens.has(environment.id)) {
      if (this.inFlightEnvironmentTokens.get(environment.id) === token) {
        this.pendingSyncEnvironmentTokens.set(environment.id, token);
      }
      return;
    }
    this.inFlightEnvironmentTokens.set(environment.id, token);
    void Promise.resolve()
      .then(() => this.options.syncEnvironment(environment))
      .catch((error: unknown) => {
        if (this.isActive(environment.id, token)) this.reportSyncError(environment, error);
      })
      .finally(() => {
        if (this.inFlightEnvironmentTokens.get(environment.id) === token) {
          this.inFlightEnvironmentTokens.delete(environment.id);
        }
        if (this.pendingSyncEnvironmentTokens.get(environment.id) === token) {
          this.pendingSyncEnvironmentTokens.delete(environment.id);
          if (this.isActive(environment.id, token)) this.runSync(environment, token);
        }
      });
  }

  private reportSyncError(environment: SessionEnvironment, error: unknown): void {
    try {
      this.options.onSyncError(environment, error);
    } catch {
      // Error reporters are best-effort; never re-open the handled sync rejection chain.
    }
  }

  private clearSyncTimer(environmentId: string): void {
    const timer = this.timers.get(environmentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(environmentId);
  }

  private isActive(environmentId: string, token: number): boolean {
    return this.activeTokens.get(environmentId) === token;
  }
}

export function buildRemoteWatchSshArgs(environment: SessionEnvironment, remoteCommand: string): string[] {
  return buildRemoteSyncSshArgs(environment, remoteCommand);
}

export function buildRemoteWatchCommand(): string {
  return String.raw`sh -lc 'set --; for path in "$HOME/.codex/sessions" "$HOME/.codex/session_index.jsonl" "$HOME/.claude/projects" "$HOME/.claude/sessions" "$HOME/.tclaude/projects" "$HOME/.tcodex/sessions" "$HOME/.tcodex/session_index.jsonl" "$HOME/.codebuddy/projects" "$HOME/.qoder/cache/projects" "$HOME/.local/share/codewiz/opencode.db" "$HOME/.local/share/opencode/opencode.db"; do if [ -e "$path" ]; then set -- "$@" "$path"; fi; done; [ "$#" -gt 0 ] || exit 86; if command -v inotifywait >/dev/null 2>&1; then inotifywait -m -r -e create,modify,move,delete "$@" 2>/dev/null; elif command -v fswatch >/dev/null 2>&1; then fswatch -0 "$@"; else exit 86; fi'`;
}

export function startSystemWatcher(environment: SessionEnvironment, onEvent: () => void, onUnavailable?: () => void): WatchHandle {
  if (environment.kind === "wsl") return startWslWatcher(environment, onEvent, onUnavailable);
  const remoteCommand = buildRemoteWatchCommand();
  let reportedUnavailable = false;
  const reportUnavailable = (): void => {
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    onUnavailable?.();
  };
  const child = spawn("ssh", buildRemoteWatchSshArgs(environment, remoteCommand), { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", onEvent);
  child.stderr.on("data", () => undefined);
  child.once("error", reportUnavailable);
  child.once("exit", reportUnavailable);
  return {
    stop: () => child.kill(),
  };
}

function startWslWatcher(environment: SessionEnvironment, onEvent: () => void, onUnavailable?: () => void): WatchHandle {
  const remoteCommand = buildWslWatchCommand();
  let reportedUnavailable = false;
  const reportUnavailable = (): void => {
    if (reportedUnavailable) return;
    reportedUnavailable = true;
    onUnavailable?.();
  };
  const child = spawnRemoteCommand(environment, remoteCommand);
  child.stdout?.on("data", onEvent);
  child.stderr?.on("data", () => undefined);
  child.once("error", reportUnavailable);
  child.once("exit", reportUnavailable);
  return {
    stop: () => child.kill(),
  };
}

function buildWslWatchCommand(): string {
  return String.raw`sh -lc 'set --; for path in "$HOME/.codex/sessions" "$HOME/.codex/session_index.jsonl" "$HOME/.claude/projects" "$HOME/.claude/sessions" "$HOME/.tclaude/projects" "$HOME/.tcodex/sessions" "$HOME/.tcodex/session_index.jsonl" "$HOME/.codebuddy/projects" "$HOME/.qoder/cache/projects" "$HOME/.local/share/codewiz/opencode.db" "$HOME/.local/share/opencode/opencode.db"; do if [ -e "$path" ]; then set -- "$@" "$path"; fi; done; [ "$#" -gt 0 ] || exit 86; if command -v inotifywait >/dev/null 2>&1; then inotifywait -m -r -e create,modify,move,delete "$@" 2>/dev/null; elif command -v fswatch >/dev/null 2>&1; then fswatch -0 "$@"; else exit 86; fi'`;
}
