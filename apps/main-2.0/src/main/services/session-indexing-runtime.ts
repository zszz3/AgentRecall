import * as path from "node:path";
import { createIndexRunCoordinator } from "../../core/index-run-coordinator";
import type { IndexStatus } from "../../core/indexer";
import type { AppSettings } from "../../core/platform";
import { AUTO_INDEX_REFRESH_INTERVAL_MS } from "../../core/refresh-policy";
import { RemoteEnvironmentLifecycle } from "../../core/remote-environment-lifecycle";
import { runRemoteCommand } from "../../core/remote-process";
import { loadRemoteLiveSessions } from "../../core/remote-session-activity";
import { loadWslSessionDetailPayload } from "../../core/remote-session-loader";
import { fetchRemoteSessionFilePayload, syncRemoteEnvironment } from "../../core/remote-sync";
import { RemoteWatchManager } from "../../core/remote-watch";
import { createCachedLiveSessionSnapshotLoader, type LoadLiveSessionOptions } from "../../core/session-activity";
import {
  OPTIONAL_SESSION_SOURCE_DESCRIPTORS,
  sessionSourcesForOptionalSetting,
} from "../../core/session-sources";
import type { SessionStore } from "../../core/session-store";
import type { LiveSessionSnapshot, SessionEnvironment, SessionSource } from "../../core/types";
import { WslSessionIndexer } from "../../core/wsl-session-indexer";
import { createIndexProgressPublisher } from "../index-progress";
import type { DesktopSessionBackend } from "../session-backend-client";
import { LocalLiveSessionService } from "./local-live-session-service";
import type { SshCommandService } from "./ssh-command-service";
import type { SshCredentialService } from "./ssh-credential-service";

const OPTIONAL_SOURCE_SETTINGS = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((descriptor) => ({
  key: descriptor.optionalSetting,
  sources: sessionSourcesForOptionalSetting(descriptor.optionalSetting),
}));

export function enabledRemoteOptionalSources(settings: AppSettings): SessionSource[] {
  return OPTIONAL_SESSION_SOURCE_DESCRIPTORS
    .filter((descriptor) => descriptor.remoteCollectorOptional && settings[descriptor.optionalSetting])
    .map((descriptor) => descriptor.id);
}

export interface SessionIndexingRuntime {
  getIndexStatus(): IndexStatus;
  setIndexStatus(status: IndexStatus): void;
  pruneDisabledOptionalSources(settings: AppSettings): Promise<void>;
  emitEnvironmentsUpdated(environments?: SessionEnvironment[]): void;
  ensureRemoteEnvironmentLifecycle(): RemoteEnvironmentLifecycle;
  updateWslPollingInterval(intervalMs: number): void;
  runIndexSync(retryFailures?: boolean): Promise<IndexStatus>;
  startAutoIndexRefresh(): void;
  stopAutoIndexRefresh(): void;
  loadLocalLiveSessions(options?: LoadLiveSessionOptions): Promise<LiveSessionSnapshot>;
  loadAllLiveSessions(options?: LoadLiveSessionOptions): Promise<LiveSessionSnapshot>;
  stop(): void;
}

export function createSessionIndexingRuntime(deps: {
  mainDir: string;
  isQuitting: () => boolean;
  getStore: () => SessionStore;
  getSettings: () => AppSettings;
  getSessionBackend: () => DesktopSessionBackend | null;
  sshCommandService: SshCommandService;
  sshCredentialService: SshCredentialService;
  sendIndexStatus: (status: IndexStatus) => void;
  sendEnvironmentsUpdated: (environments: SessionEnvironment[]) => void;
  onIndexCompleted: () => void;
}): SessionIndexingRuntime {
  let indexStatus: IndexStatus = {
    running: false,
    indexed: 0,
    skipped: 0,
    total: 0,
    lastIndexedAt: null,
    error: null,
  };
  let retryIndexFailures = false;
  let autoIndexTimer: ReturnType<typeof setInterval> | null = null;
  let remoteWatchManager: RemoteWatchManager | null = null;
  let remoteEnvironmentLifecycle: RemoteEnvironmentLifecycle | null = null;
  let wslSessionIndexer: WslSessionIndexer | null = null;

  const pruneDisabledOptionalSources = async (settings: AppSettings): Promise<void> => {
    const disabledSources = OPTIONAL_SOURCE_SETTINGS.flatMap((item) => (settings[item.key] ? [] : item.sources));
    await deps.getStore().deleteSessionsBySource(disabledSources);
  };

  const indexRunCoordinator = createIndexRunCoordinator<IndexStatus>({
    afterRun: () => (deps.isQuitting() ? undefined : pruneDisabledOptionalSources(deps.getSettings())),
  });
  const indexProgressPublisher = createIndexProgressPublisher(
    (status) => deps.sendIndexStatus(status),
    { minIntervalMs: 200 },
  );

  const emitEnvironmentsUpdated = (environments?: SessionEnvironment[]): void => {
    if (environments) {
      deps.sendEnvironmentsUpdated(environments);
      return;
    }
    void deps.getStore().listEnvironments().then((next) => {
      deps.sendEnvironmentsUpdated(next);
    });
  };

  const ensureRemoteWatchManager = (): RemoteWatchManager => {
    if (!remoteWatchManager) {
      remoteWatchManager = new RemoteWatchManager({
        startWatcher: (environment, onEvent, onUnavailable) =>
          deps.sshCommandService.watch(environment, onEvent, onUnavailable),
        syncEnvironment: (environment) => ensureRemoteEnvironmentLifecycle().syncFromWatcher(environment),
        onSyncError: (environment, error) => {
          const store = deps.getStore();
          void store.updateEnvironmentSyncState(
            environment.id,
            "error",
            { lastError: error instanceof Error ? error.message : String(error) },
          ).then(() => store.listEnvironments())
            .then(emitEnvironmentsUpdated)
            .catch(() => undefined);
        },
        onModeChange: (environment, mode) => {
          if (environment.kind !== "wsl") return;
          const store = deps.getStore();
          void store.updateEnvironmentSyncState(
            environment.id,
            mode === "polling" ? "polling" : "watching",
            { lastError: null },
          ).then(() => store.listEnvironments())
            .then(emitEnvironmentsUpdated)
            .catch(() => undefined);
        },
        pollIntervalMs: deps.getSettings().wslPollingIntervalMs,
      });
    }
    return remoteWatchManager;
  };

  const ensureWslSessionIndexer = (): WslSessionIndexer => {
    if (!wslSessionIndexer) {
      wslSessionIndexer = new WslSessionIndexer({
        store: deps.getStore(),
        fetchSessionFile: (environment, session) => fetchRemoteSessionFilePayload(environment, session),
        loadSession: (environment, payload, summary) =>
          loadWslSessionDetailPayload(environment, payload, summary, { includeTraceEvents: true }),
        onComplete: (_environment, result) => {
          if (result.indexed > 0) emitEnvironmentsUpdated();
        },
        onSessionError: (session, error) => {
          const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
          console.warn(
            `Could not build the WSL search index for ${session.sessionKey}: ${error instanceof Error ? error.message : String(error)}`,
            cause instanceof Error ? cause.stack : undefined,
          );
        },
      });
    }
    return wslSessionIndexer;
  };

  const ensureRemoteEnvironmentLifecycle = (): RemoteEnvironmentLifecycle => {
    if (!remoteEnvironmentLifecycle) {
      remoteEnvironmentLifecycle = new RemoteEnvironmentLifecycle({
        store: deps.getStore(),
        syncEnvironment: async (environment) => {
          await syncRemoteEnvironment(deps.getStore(), environment, {
            ...(environment.kind === "ssh"
              ? { runSsh: (env, cmd) => deps.sshCommandService.run(env, cmd) }
              : {}),
            enabledOptionalSources: enabledRemoteOptionalSources(deps.getSettings()),
          });
          if (environment.kind === "wsl") {
            void ensureWslSessionIndexer().request(environment).catch((error) => {
              console.warn(`WSL full-text indexing failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        },
        watchManager: ensureRemoteWatchManager(),
        onEnvironmentSaved: (environment, input) => deps.sshCredentialService.saveForEnvironment(environment, input),
        onEnvironmentDeleted: (environmentId) => deps.sshCredentialService.deletePassword(environmentId),
        onEnvironmentsUpdated: emitEnvironmentsUpdated,
      });
    }
    return remoteEnvironmentLifecycle;
  };

  const runIndexSync = (retryFailures = false): Promise<IndexStatus> => {
    retryIndexFailures ||= retryFailures;
    return indexRunCoordinator.request(async () => {
      if (deps.isQuitting()) return indexStatus;
      const retryFailuresThisRun = retryIndexFailures;
      retryIndexFailures = false;
      await pruneDisabledOptionalSources(deps.getSettings());
      if (deps.isQuitting()) return indexStatus;
      indexStatus = { ...indexStatus, running: true, error: null };
      indexProgressPublisher.publish(indexStatus, true);
      const backend = deps.getSessionBackend();
      if (!backend) throw new Error("Session search backend is not ready.");
      return backend.refresh(retryFailuresThisRun, (status) => {
        if (deps.isQuitting()) return;
        indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
        indexProgressPublisher.publish(indexStatus);
      })
        .then((status) => {
          if (deps.isQuitting()) return status;
          indexStatus = status;
          indexProgressPublisher.publish(indexStatus, true);
          emitEnvironmentsUpdated();
          deps.onIndexCompleted();
          return indexStatus;
        })
        .catch((error) => {
          if (deps.isQuitting()) return indexStatus;
          indexStatus = {
            running: false,
            indexed: 0,
            skipped: 0,
            total: 0,
            lastIndexedAt: indexStatus.lastIndexedAt,
            error: String(error),
          };
          indexProgressPublisher.publish(indexStatus, true);
          return indexStatus;
        })
        .finally(() => {
          if (!deps.isQuitting()) void ensureRemoteEnvironmentLifecycle().startEnabledEnvironments();
        });
    });
  };

  // Live process detection and indexing have separate workers so a long index
  // cannot queue interactive live-session requests.
  const localLiveSessionService = new LocalLiveSessionService(path.join(deps.mainDir, "live-session-worker.js"));
  const loadLocalLiveSessions = createCachedLiveSessionSnapshotLoader({
    load: (options) => localLiveSessionService.load(options),
  });
  const loadAllLiveSessions = createCachedLiveSessionSnapshotLoader({
    load: async (options) => {
      const [snapshot, remoteSnapshot] = await Promise.all([
        loadLocalLiveSessions(options),
        Promise.resolve()
          .then(async () => loadRemoteLiveSessions(
            await deps.getStore().listEnvironments(),
            (environment, remoteCommand) => environment.kind === "wsl"
              ? runRemoteCommand(environment, remoteCommand, { maxBuffer: 512 * 1024, timeout: 10_000 })
              : deps.sshCommandService.run(environment, remoteCommand, { maxBuffer: 512 * 1024, timeout: 10_000 }),
            { includePasswordAuthenticated: options?.fresh === true },
          ))
          .then((sessions) => ({ sessions, error: null as string | null }))
          .catch((error) => ({
            sessions: [],
            error: error instanceof Error ? error.message : String(error),
          })),
      ]);
      return {
        ...snapshot,
        sessions: [...snapshot.sessions, ...remoteSnapshot.sessions],
        ...(snapshot.error || remoteSnapshot.error
          ? { error: snapshot.error ?? remoteSnapshot.error ?? undefined }
          : {}),
      };
    },
  });

  const stopAutoIndexRefresh = (): void => {
    if (!autoIndexTimer) return;
    clearInterval(autoIndexTimer);
    autoIndexTimer = null;
  };

  return {
    getIndexStatus: () => indexStatus,
    setIndexStatus: (status) => {
      indexStatus = status;
      deps.sendIndexStatus(status);
    },
    pruneDisabledOptionalSources,
    emitEnvironmentsUpdated,
    ensureRemoteEnvironmentLifecycle,
    updateWslPollingInterval: (intervalMs) => {
      remoteWatchManager?.updatePollingInterval(intervalMs);
    },
    runIndexSync,
    startAutoIndexRefresh: () => {
      if (autoIndexTimer) return;
      autoIndexTimer = setInterval(() => {
        void runIndexSync();
      }, AUTO_INDEX_REFRESH_INTERVAL_MS);
    },
    stopAutoIndexRefresh,
    loadLocalLiveSessions,
    loadAllLiveSessions,
    stop: () => {
      stopAutoIndexRefresh();
      localLiveSessionService.stop();
      remoteEnvironmentLifecycle?.stopAll();
    },
  };
}
