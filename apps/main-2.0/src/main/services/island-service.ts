import {
  activateDesktopAppForSource,
  getFrontmostApplication,
  isSourceFrontmost,
  playIslandNotificationSound,
  type FrontmostApp,
} from "../../core/app-focus";
import {
  IslandTaskStore,
  LocalSessionActivityMonitor,
  type IslandSignalEvent,
  type IslandStoreConfig,
} from "../../core/island-monitor";
import { focusLiveSessionTerminal, liveSessionPidForSession } from "../../core/session-focus";
import type { LiveSessionSnapshot, SessionSearchResult } from "../../core/types";
import type { IslandFocusResult, IslandSnapshot, IslandTask } from "../../shared/ipc/island";

export interface IslandOverlayWindowPort {
  ensureCreated(): void;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  setInteractive(interactive: boolean): void;
  sendSnapshot(snapshot: IslandSnapshot): void;
}

export interface IslandServiceDependencies {
  homeDir: string;
  env?: NodeJS.ProcessEnv;
  getConfig(): IslandStoreConfig;
  window: IslandOverlayWindowPort;
  broadcastSnapshot(snapshot: IslandSnapshot): void;
  findSessionByRawId(rawId: string): Promise<SessionSearchResult | null>;
  refreshIndex?: () => Promise<unknown>;
  loadLiveSessions(): Promise<LiveSessionSnapshot>;
  openSessionInMain(sessionKey: string): void;
  shareSessionToTeamInMain(sessionKey: string): void;
  openSessionsPageInMain(): void;
  getFrontmostApp?: () => Promise<FrontmostApp | null>;
  activateDesktopApp?: typeof activateDesktopAppForSource;
  focusTerminal?: typeof focusLiveSessionTerminal;
  playSound?: typeof playIslandNotificationSound;
  pollIntervalMs?: number;
  now?: () => number;
  logError?(message: string): void;
}

export class IslandService {
  private readonly store: IslandTaskStore;
  private readonly monitor: LocalSessionActivityMonitor;
  private collapseTimer: NodeJS.Timeout | null = null;
  private hovering = false;
  private started = false;
  private stopped = false;

  constructor(private readonly deps: IslandServiceDependencies) {
    this.store = new IslandTaskStore(deps.getConfig(), deps.now);
    this.monitor = new LocalSessionActivityMonitor({
      homeDir: deps.homeDir,
      env: deps.env,
      pollIntervalMs: deps.pollIntervalMs,
      now: deps.now,
      onEvent: (event) => {
        void this.ingestEvent(event);
      },
      onError: (message) => deps.logError?.(`Dynamic Island monitor: ${message}`),
    });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const config = this.deps.getConfig();
    this.store.updateConfig(config);
    if (config.enabled) {
      this.deps.window.ensureCreated();
      this.monitor.start();
    }
    this.syncOverlay(this.store.snapshot());
  }

  stop(): void {
    this.stopped = true;
    this.clearCollapseTimer();
    this.monitor.stop();
    this.deps.window.destroy();
  }

  applyConfig(config: IslandStoreConfig): IslandSnapshot {
    const snapshot = this.store.updateConfig(config);
    if (this.started && !this.stopped) {
      if (config.enabled) {
        this.deps.window.ensureCreated();
        this.monitor.start();
      } else {
        this.clearCollapseTimer();
        this.monitor.stop();
        this.deps.window.hide();
      }
    }
    this.publish(snapshot);
    return snapshot;
  }

  getSnapshot(): IslandSnapshot {
    return this.store.snapshot();
  }

  async ingestEvent(event: IslandSignalEvent): Promise<IslandSnapshot> {
    if (this.stopped) return this.store.snapshot();
    const config = this.deps.getConfig();
    let suppressAlert = false;
    const isAlertStatus = event.status === "completed" || event.status === "waiting_input" || event.status === "error";
    if (isAlertStatus && config.enabled && config.suppressWhenFocused) {
      const frontmost = await (this.deps.getFrontmostApp ?? getFrontmostApplication)();
      if (isSourceFrontmost(event.source, frontmost)) {
        suppressAlert = true;
      }
    }

    const result = this.store.ingest(event, { suppressAlert });
    if (!result.changed) return result.snapshot;

    if (result.alertedTask) {
      if (!this.hovering) {
        this.scheduleAutoCollapse(result.snapshot.highlightVersion, config.autoCollapseSeconds);
      }
      if (config.soundEnabled && result.alertedTask.status !== "running") {
        void (this.deps.playSound ?? playIslandNotificationSound)(result.alertedTask.status);
      }
    }

    this.publish(result.snapshot);
    return result.snapshot;
  }

  async focusTask(taskId: string): Promise<IslandFocusResult> {
    const task = this.store.getTask(taskId);
    if (!task) return { focused: false, error: "任务记录已清除。" };

    const snapshot = this.store.markRead(taskId);
    this.publish(snapshot);

    // 1. If the task is linked to a running terminal PID, focus that exact terminal tab.
    let pid = task.pid;
    if (!pid && task.sessionId) {
      try {
        const [session, live] = await Promise.all([
          this.deps.findSessionByRawId(task.sessionId),
          this.deps.loadLiveSessions(),
        ]);
        if (session) {
          this.store.attachSessionKey(taskId, session.sessionKey);
          pid = liveSessionPidForSession(session, live.sessions);
        }
      } catch {
        // Fall through to desktop app activation.
      }
    }

    if (pid) {
      try {
        await (this.deps.focusTerminal ?? focusLiveSessionTerminal)(pid, {
          title: task.title,
          projectPath: task.projectPath ?? undefined,
          sessionId: task.sessionId,
        });
        return { focused: true, targetLabel: task.agentLabel };
      } catch {
        // Fall back to desktop app activation below.
      }
    }

    // 2. Otherwise activate the desktop application (e.g. DeepSeek Harness Desktop, Claude, Codex, Cursor, ZCode).
    const activated = await (this.deps.activateDesktopApp ?? activateDesktopAppForSource)(task.source);
    if (activated.activated) {
      return { focused: true, targetLabel: activated.targetLabel ?? task.agentLabel };
    }

    // 3. Final fallback: open the session in AgentRecall itself.
    await this.openTrajectory(taskId);
    return { focused: true, targetLabel: "AgentRecall" };
  }

  async openTrajectory(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) {
      this.deps.openSessionsPageInMain();
      return;
    }
    const snapshot = this.store.markRead(taskId);
    this.publish(snapshot);

    const sessionKey = await this.resolveSessionKey(task);
    if (sessionKey) this.deps.openSessionInMain(sessionKey);
    else this.deps.openSessionsPageInMain();
  }

  async shareToTeam(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const snapshot = this.store.markRead(taskId);
    this.publish(snapshot);

    const sessionKey = await this.resolveSessionKey(task);
    if (sessionKey) this.deps.shareSessionToTeamInMain(sessionKey);
    else this.deps.openSessionsPageInMain();
  }

  dismissTask(taskId: string): IslandSnapshot {
    const snapshot = this.store.dismiss(taskId);
    this.publish(snapshot);
    return snapshot;
  }

  clearCompleted(): IslandSnapshot {
    const snapshot = this.store.clearCompleted();
    this.publish(snapshot);
    return snapshot;
  }

  setMuted(muted: boolean): IslandSnapshot {
    const snapshot = this.store.setMuted(muted);
    this.publish(snapshot);
    return snapshot;
  }

  setInteractive(interactive: boolean): void {
    if (this.stopped) return;
    this.hovering = interactive;
    this.deps.window.setInteractive(interactive);
    if (interactive) {
      // Pause auto-collapse while the user hovers over the Dynamic Island to read or click actions.
      this.clearCollapseTimer();
    } else {
      const snapshot = this.store.snapshot();
      if (snapshot.highlightedTaskId) {
        this.scheduleAutoCollapse(snapshot.highlightVersion, 2.5);
      }
    }
  }

  private async resolveSessionKey(task: IslandTask): Promise<string | null> {
    if (!task.sessionId || task.sessionId.startsWith("gw-")) {
      return task.sessionKey;
    }
    try {
      let found = await this.deps.findSessionByRawId(task.sessionId);
      const isStale = !found || (task.updatedAt > 0 && found.lastActivityAt < task.updatedAt - 1000);
      if (isStale && this.deps.refreshIndex) {
        try {
          await this.deps.refreshIndex();
          found = await this.deps.findSessionByRawId(task.sessionId);
        } catch {
          // Keep whatever index result was available if incremental refresh fails.
        }
      }
      if (found) {
        this.store.attachSessionKey(task.id, found.sessionKey);
        return found.sessionKey;
      }
    } catch {
      // Fall back to Sessions page when the index hasn't caught up yet.
    }
    return task.sessionKey;
  }

  private scheduleAutoCollapse(version: number, seconds: number): void {
    this.clearCollapseTimer();
    const delayMs = Math.max(2000, Math.min(30_000, Math.round(seconds * 1000)));
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null;
      if (this.hovering) return;
      const snapshot = this.store.clearHighlight(version);
      this.publish(snapshot);
    }, delayMs);
    this.collapseTimer.unref();
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
  }

  private publish(snapshot: IslandSnapshot): void {
    this.syncOverlay(snapshot);
    this.deps.broadcastSnapshot(snapshot);
  }

  private syncOverlay(snapshot: IslandSnapshot): void {
    if (this.stopped) return;
    if (!snapshot.enabled) {
      this.deps.window.hide();
      return;
    }
    this.deps.window.ensureCreated();
    this.deps.window.sendSnapshot(snapshot);
    this.deps.window.showInactive();
  }
}
