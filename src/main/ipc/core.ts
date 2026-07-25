import type { AppSettings } from "../../core/platform";
import type { ResumeRouteResult } from "../../core/resume-router";
import type { SessionStore } from "../../core/session-store";
import type { CoreSettings, CoreSettingsUpdate } from "../../shared/core-api";
import { CORE_IPC } from "../../shared/ipc/core";
import {
  CORE_SESSION_SOURCES,
  isCoreSessionSource,
} from "../../shared/product-profile";
import { registerAppUpdateIpc, type AppUpdateIpcService } from "./app-update";
import {
  combineIpcDisposers,
  registerIpcHandler,
  type IpcMainRegistrar,
} from "./register-ipc-handler";
import type {
  LiveSessionSnapshot,
  ProjectQueryOptions,
  SearchOptions,
  SessionSearchResult,
  TagListOptions,
} from "../../core/types";
import type { IndexStatus } from "../../core/indexer";

export interface CoreIpcDependencies {
  getStore(): SessionStore;
  getAppSettings(): AppSettings;
  getCoreSettings(): CoreSettings;
  setCoreSettings(update: CoreSettingsUpdate): Promise<CoreSettings>;
  getIndexStatus(): IndexStatus;
  refreshIndex(): Promise<IndexStatus>;
  getLiveSessions(): Promise<LiveSessionSnapshot>;
  resumeSession(sessionKey: string): Promise<ResumeRouteResult>;
  appUpdateService: AppUpdateIpcService;
}

export function registerCoreIpc(
  ipc: IpcMainRegistrar,
  dependencies: CoreIpcDependencies,
): () => void {
  const disposers = [
    registerIpcHandler(ipc, CORE_IPC.searchSessionPage, (_event, options) =>
      dependencies.getStore().searchSessionPage(coreSearchOptions(options, dependencies.getAppSettings()))),
    registerIpcHandler(ipc, CORE_IPC.getSession, (_event, sessionKey) => {
      const store = dependencies.getStore();
      const session = getCoreSession(store, sessionKey);
      if (session) store.markOpened(sessionKey);
      return session;
    }),
    registerIpcHandler(ipc, CORE_IPC.getMessages, (_event, sessionKey, offset, limit) => {
      const store = dependencies.getStore();
      if (!getCoreSession(store, sessionKey)) return [];
      return store.getMessages(sessionKey, offset ?? 0, limit ?? 120);
    }),
    registerIpcHandler(ipc, CORE_IPC.getTraceEvents, (_event, sessionKey, options) => {
      const store = dependencies.getStore();
      if (!getCoreSession(store, sessionKey)) return [];
      return store
        .getTraceEvents(sessionKey, options)
        .filter((event) => event.source === "claude" || event.source === "codex");
    }),
    registerIpcHandler(ipc, CORE_IPC.getLiveSessions, async () => {
      const snapshot = await dependencies.getLiveSessions();
      return {
        ...snapshot,
        sessions: snapshot.sessions.filter(
          (session) => session.family === "claude" || session.family === "codex",
        ),
      };
    }),
    registerIpcHandler(ipc, CORE_IPC.listTags, (_event, options) =>
      dependencies.getStore().listTags(coreTagOptions(options, dependencies.getAppSettings()))),
    registerIpcHandler(ipc, CORE_IPC.listProjects, (_event, options) =>
      dependencies.getStore().listProjects(coreProjectOptions(options, dependencies.getAppSettings()))),
    registerIpcHandler(ipc, CORE_IPC.listTagsByProject, () =>
      dependencies.getStore().listTagsByProject({
        environmentId: "local",
        excludeSubagents: dependencies.getAppSettings().hideSubagentSessions,
        allowedSources: CORE_SESSION_SOURCES,
      })),
    registerIpcHandler(ipc, CORE_IPC.listEnvironments, () =>
      dependencies
        .getStore()
        .listEnvironments()
        .filter(
          (environment) =>
            environment.id === "local" && environment.kind === "local",
        )),
    registerIpcHandler(ipc, CORE_IPC.setCustomTitle, (_event, sessionKey, title) => {
      const store = dependencies.getStore();
      if (!getCoreSession(store, sessionKey)) return;
      store.setCustomTitle(sessionKey, title);
    }),
    registerIpcHandler(ipc, CORE_IPC.setFavorited, (_event, sessionKey, favorited) => {
      const store = dependencies.getStore();
      if (!getCoreSession(store, sessionKey)) return;
      store.setFavorited(sessionKey, favorited);
    }),
    registerIpcHandler(ipc, CORE_IPC.refreshIndex, () =>
      dependencies.refreshIndex()),
    registerIpcHandler(ipc, CORE_IPC.getIndexStatus, () =>
      dependencies.getIndexStatus()),
    registerIpcHandler(ipc, CORE_IPC.getSettings, () =>
      dependencies.getCoreSettings()),
    registerIpcHandler(ipc, CORE_IPC.setSettings, (_event, update) =>
      dependencies.setCoreSettings(update)),
    registerIpcHandler(ipc, CORE_IPC.resumeSession, (_event, sessionKey) => {
      if (!getCoreSession(dependencies.getStore(), sessionKey)) {
        return { route: "resume" as const };
      }
      return dependencies.resumeSession(sessionKey);
    }),
    registerAppUpdateIpc(ipc, dependencies.appUpdateService),
  ];
  return combineIpcDisposers(disposers);
}

function getCoreSession(
  store: SessionStore,
  sessionKey: string,
): SessionSearchResult | null {
  const session = store.getSession(sessionKey);
  if (
    !session ||
    session.environmentId !== "local" ||
    session.environmentKind !== "local" ||
    !isCoreSessionSource(session.source)
  ) {
    return null;
  }
  return session;
}

function coreSearchOptions(
  options: SearchOptions,
  settings: AppSettings,
): SearchOptions {
  return {
    ...options,
    environmentId: "local",
    excludeSubagents: settings.hideSubagentSessions,
    allowedSources: CORE_SESSION_SOURCES,
  };
}

function coreTagOptions(
  options: TagListOptions | undefined,
  settings: AppSettings,
): TagListOptions {
  return {
    ...options,
    environmentId: "local",
    projectEnvironmentId: "local",
    excludeSubagents: settings.hideSubagentSessions,
    allowedSources: CORE_SESSION_SOURCES,
  };
}

function coreProjectOptions(
  options: ProjectQueryOptions | undefined,
  settings: AppSettings,
): ProjectQueryOptions {
  return {
    ...options,
    environmentId: "local",
    excludeSubagents: settings.hideSubagentSessions,
    allowedSources: CORE_SESSION_SOURCES,
  };
}
