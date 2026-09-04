// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionBulkDeletePreview,
} from "../../core/session-bulk-delete";
import type {
  RuntimeInvocationSummary,
  SessionMigrationProgress,
  SessionMigrationResult,
  SessionSearchResult,
} from "../../core/types";

const harness = vi.hoisted(() => ({
  detail: null as SessionSearchResult | null,
  listener: null as ((sessionKey: string) => void) | null,
  migrationListener: null as ((progress: SessionMigrationProgress) => void) | null,
  getSession: vi.fn(),
  getLiveSessions: vi.fn(),
  previewBulkDelete: vi.fn(),
  bulkDeleteSessions: vi.fn(),
  setOpenSession: vi.fn(),
  searchAllMatching: vi.fn(async () => [] as SessionSearchResult[]),
  openLocal: vi.fn(),
  setSelectedKey: vi.fn(),
  workbenchPage: vi.fn((_props: unknown) => null),
  sessionsPage: vi.fn((_props: unknown) => null),
  sessionDetails: vi.fn((_props: unknown) => null),
  skillsPage: vi.fn((_props: unknown) => null),
  runtimeFeaturePage: vi.fn((_props: unknown) => null),
  remoteSessionsDialog: vi.fn((_props: unknown) => null),
  loadCatalog: vi.fn(async () => undefined),
  loadWorkbenchSessions: vi.fn(async () => undefined),
  loadStats: vi.fn(async () => undefined),
  automationApi: { listMcpServers: vi.fn(async () => []) },
  automationSnapshot: {
    workflowStore: { workflows: [], runs: [] },
    channels: [],
  },
  workflowSidebar: { workflows: [] },
  skillsSnapshot: { skills: [] },
}));

vi.mock("./components/app-navigation", () => ({ AppNavigation: () => null }));
vi.mock("./features/workbench/workbench-page", () => ({ WorkbenchPage: harness.workbenchPage }));
vi.mock("./features/sessions/sessions-page", () => ({ SessionsPage: harness.sessionsPage }));
vi.mock("./features/sessions/session-details", () => ({ SessionDetails: harness.sessionDetails }));
vi.mock("./features/skills/skills-page", () => ({ SkillsPage: harness.skillsPage }));
vi.mock("./features/automation/runtime-feature-page", () => ({ RuntimeFeaturePage: harness.runtimeFeaturePage }));
vi.mock("./features/remote-sessions/remote-sessions-dialog", () => ({
  RemoteSessionsDialog: harness.remoteSessionsDialog,
}));
vi.mock("./features/search/use-main-search-shortcut", () => ({ useMainSearchShortcut: () => undefined }));

vi.mock("./features/sessions/use-session-detail", () => ({
  useSessionDetail: () => ({
    detail: harness.detail,
    remoteDetail: null,
    turns: [],
    turnsLoading: false,
    matchedTurnId: null,
    matchedMessageIndex: null,
    openLocal: harness.openLocal,
    closeLocal: vi.fn(),
    openRemote: vi.fn(),
    closeRemote: vi.fn(),
    refreshLocal: vi.fn(),
    applyUpdatedLocal: vi.fn(),
  }),
}));

vi.mock("./features/sessions/use-session-catalog", () => ({
  useSessionCatalog: () => ({
    query: "",
    setQuery: vi.fn(),
    source: "all",
    setSource: vi.fn(),
    environmentId: "all",
    setEnvironmentId: vi.fn(),
    tag: undefined,
    setTag: vi.fn(),
    projectPath: "",
    projectEnvironmentId: null,
    visibility: "visible",
    setVisibility: vi.fn(),
    dateRange: "30d",
    setDateRange: vi.fn(),
    customDateRange: null,
    setCustomDateRange: vi.fn(),
    liveStatus: "all",
    setLiveStatus: vi.fn(),
    sessionTotalCount: 0,
    displayedResults: [],
    selectedKey: null,
    setSelectedKey: harness.setSelectedKey,
    selected: null,
    searchRef: { current: null },
    liveSessionKeys: new Set<string>(),
    liveDetectionFailed: false,
    load: harness.loadCatalog,
    currentPage: 1,
    totalPages: 1,
    goToPage: vi.fn(),
    searchAllMatching: harness.searchAllMatching,
    clearProjectFilter: vi.fn(),
    clearProjectScopeFilter: vi.fn(),
    clearEnvironmentScopeFilter: vi.fn(),
    selectEnvironment: vi.fn(),
    selectProject: vi.fn(),
  }),
}));

vi.mock("./features/workbench/use-workbench-overview", () => ({
  useWorkbenchOverview: () => ({
    query: "",
    setQuery: vi.fn(),
    sessions: [],
    stats: null,
    statsPeriod: "30d",
    setStatsPeriod: vi.fn(),
    statsRefreshing: false,
    statsFeedback: null,
    quotas: [],
    quotaLoading: false,
    quotaFeedback: null,
    liveSessions: null,
    loadSessions: harness.loadWorkbenchSessions,
    loadStats: harness.loadStats,
    refreshStats: vi.fn(),
    loadQuotas: vi.fn(),
    refreshLiveSessions: vi.fn(async () => undefined),
  }),
}));

vi.mock("./features/remote-sessions/use-remote-sessions-cache", () => ({
  useRemoteSessionsCache: () => ({
    cache: {
      status: null,
      items: [],
      initialized: true,
      loading: false,
      refreshing: false,
      error: null,
      uploadTasks: {},
      uploadBatch: null,
      deleteTasks: {},
      deleteBatch: null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    invalidate: vi.fn(),
    queueUploads: vi.fn(),
    queueDeletions: vi.fn(),
  }),
}));

vi.mock("./features/skills/use-skills-controller", () => ({
  useSkillsController: () => ({
    snapshot: harness.skillsSnapshot,
    loading: false,
    feedback: null,
    load: vi.fn(),
    ensureLoaded: vi.fn(),
    copySetupSql: vi.fn(),
    fetchVersion: vi.fn(),
    installRemote: vi.fn(),
    deleteSkill: vi.fn(),
    upload: vi.fn(),
    uploadSelected: vi.fn(),
    syncSnapshot: vi.fn(),
  }),
}));

vi.mock("./features/automation/automation-provider", () => ({
  useAutomation: () => ({
    detailsLoaded: true,
    snapshot: harness.automationSnapshot,
    workflowSidebar: harness.workflowSidebar,
    workflowSidebarLoading: false,
    loading: false,
    error: null,
    api: harness.automationApi,
    ensureDetailsLoaded: vi.fn(async () => undefined),
    setSnapshot: vi.fn(),
  }),
}));

describe("external session opening", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function finishRemoteRestore(result: SessionMigrationResult): Promise<void> {
    const sessionsProps = harness.sessionsPage.mock.calls.at(-1)?.[0] as {
      actions: { openRemoteSessions: () => void };
    };
    await act(async () => sessionsProps.actions.openRemoteSessions());
    const remoteProps = harness.remoteSessionsDialog.mock.calls.at(-1)?.[0] as {
      onRestored: (result: SessionMigrationResult) => void;
    };
    await act(async () => {
      remoteProps.onRestored(result);
      harness.migrationListener?.({
        sessionKey: "codex:restored-session",
        target: "codex",
        stage: "launching",
      });
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const sessionSearch = {
      platform: "win32",
      onOpenSession: (listener: (sessionKey: string) => void) => {
        harness.listener = listener;
        return () => {
          if (harness.listener === listener) harness.listener = null;
        };
      },
      onIndexStatus: () => vi.fn(),
      onFocusSearch: () => vi.fn(),
      onOpenSettings: () => vi.fn(),
      onAppUpdateStatus: () => vi.fn(),
      onAppUpdateProgress: () => vi.fn(),
      onEnvironmentsUpdated: () => vi.fn(),
      onMigrationProgress: (listener: (progress: SessionMigrationProgress) => void) => {
        harness.migrationListener = listener;
        return () => {
          if (harness.migrationListener === listener) harness.migrationListener = null;
        };
      },
      getIndexStatus: vi.fn(async () => ({ running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null })),
      getAppUpdateStatus: vi.fn(async () => null),
      getSettings: vi.fn(async () => null),
      setInterfaceZoomFactor: vi.fn(async () => undefined),
      getSessionSyncHookStatus: vi.fn(async () => null),
      getSkillEvalFindingCounts: vi.fn(async () => ({})),
      listTags: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      listEnvironments: vi.fn(async () => []),
      listTagsByProject: vi.fn(async () => []),
      listSkills: vi.fn(async () => ({ skills: [] })),
      getOpenVikingMemorySnapshot: vi.fn(async () => null),
      getSession: harness.getSession,
      getLiveSessions: harness.getLiveSessions,
      previewBulkDelete: harness.previewBulkDelete,
      bulkDeleteSessions: harness.bulkDeleteSessions,
      setOpenSession: harness.setOpenSession,
      teamChat: { listRooms: vi.fn(async () => []) },
    };
    Reflect.set(window, "sessionSearch", sessionSearch);
    const { App } = await import("./App");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(App)));
  });

  afterAll(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("switches to Session, selects the requested key, and opens its detail", async () => {
    const session = {
      sessionKey: "codex:quick-search-result",
      source: "codex-cli",
      displayTitle: "Quick search result",
    } as SessionSearchResult;
    harness.getSession.mockResolvedValue(session);

    await act(async () => {
      harness.listener?.(session.sessionKey);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.sessionsPage).toHaveBeenCalled();
    expect(harness.setSelectedKey).toHaveBeenCalledWith(session.sessionKey);
    expect(harness.getSession).toHaveBeenCalledWith(session.sessionKey);
    expect(harness.openLocal).toHaveBeenCalledWith(session);
  });

  it("rechecks the currently open session before final bulk deletion", async () => {
    const session = {
      sessionKey: "codex:bulk-delete-target",
      source: "codex-cli",
      displayTitle: "Bulk delete target",
    } as SessionSearchResult;
    const preview = (includesOpenSession: boolean): SessionBulkDeletePreview => ({
      requestedCount: 1,
      matchedCount: 1,
      expandedCount: 1,
      deletableCount: 1,
      hasRelatedSessions: false,
      includesOpenSession,
      liveSessionCheckFailed: false,
      confirmationFingerprint: `preview:${includesOpenSession}`,
      sourceCounts: [{ source: "codex-cli", count: 1 }],
      skipped: [],
    });

    harness.detail = null;
    harness.getSession.mockResolvedValue(session);
    harness.getLiveSessions.mockResolvedValue({ sessions: [], error: null });
    harness.searchAllMatching.mockResolvedValue([session]);
    harness.previewBulkDelete
      .mockResolvedValueOnce(preview(false))
      .mockResolvedValueOnce(preview(true));
    harness.bulkDeleteSessions.mockRejectedValueOnce(
      new Error(
        `Error invoking remote method 'session:bulk-delete': Error: ${SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE}`,
      ),
    );
    harness.openLocal.mockImplementation(async (nextSession: SessionSearchResult) => {
      harness.detail = nextSession;
    });

    await act(async () => root.render(createElement((await import("./App")).App)));
    let sessionsProps = harness.sessionsPage.mock.calls.at(-1)?.[0] as {
      actions: {
        toggleBulkSession: (sessionKey: string) => void;
        deleteSelected: () => void;
      };
    };
    await act(async () => sessionsProps.actions.toggleBulkSession(session.sessionKey));
    sessionsProps = harness.sessionsPage.mock.calls.at(-1)?.[0] as typeof sessionsProps;
    await act(async () => {
      sessionsProps.actions.deleteSelected();
      await vi.waitFor(() => expect(harness.previewBulkDelete).toHaveBeenCalledTimes(1));
    });

    expect(container.querySelector(".bulk-delete-dialog input")).toBeNull();

    await act(async () => {
      harness.listener?.(session.sessionKey);
      await vi.waitFor(() => expect(harness.openLocal).toHaveBeenCalledWith(session));
      root.render(createElement((await import("./App")).App));
    });

    const confirmButton = container.querySelector<HTMLButtonElement>(".bulk-delete-dialog .danger-action");
    expect(confirmButton?.textContent).toMatch(/Confirm|确认/);
    await act(async () => {
      confirmButton?.click();
      await vi.waitFor(() => expect(harness.previewBulkDelete).toHaveBeenCalledTimes(2));
    });

    expect(harness.bulkDeleteSessions).toHaveBeenCalledWith(expect.objectContaining({
      sessionKeys: [session.sessionKey],
      confirmed: false,
      openSessionKey: session.sessionKey,
    }));
    expect(harness.previewBulkDelete).toHaveBeenLastCalledWith(expect.objectContaining({
      openSessionKey: session.sessionKey,
    }));
    expect(container.querySelector(".bulk-delete-dialog input")).not.toBeNull();
  });

  it("finishes a remote restore after a delayed launching progress event", async () => {
    vi.useFakeTimers();
    try {
      await finishRemoteRestore({
        target: "codex",
        targetSessionId: "restored-session",
        targetFilePath: "C:\\Codex\\restored-session.jsonl",
        strategy: "complete",
        resumeCommand: "codex resume restored-session",
        indexed: true,
        launched: true,
      });

      expect(container.querySelector(".action-toast.running")).toBeNull();
      expect(container.querySelector(".action-toast.success")?.textContent).toContain("Codex");

      await act(async () => vi.advanceTimersByTimeAsync(1800));
      expect(container.querySelector(".action-toast")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a remote restore launch failure after delayed progress", async () => {
    vi.useFakeTimers();
    try {
      const warning = "Codex could not be opened.";

      await finishRemoteRestore({
        target: "codex",
        targetSessionId: "restored-session",
        targetFilePath: "C:\\Codex\\restored-session.jsonl",
        strategy: "complete",
        resumeCommand: "codex resume restored-session",
        indexed: true,
        launched: false,
        warning,
      });

      expect(container.querySelector(".action-toast.running")).toBeNull();
      expect(container.querySelector(".action-toast.error")?.textContent).toContain(warning);

      await act(async () => vi.advanceTimersByTimeAsync(1800));
      expect(container.querySelector(".action-toast.error")?.textContent).toContain(warning);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns Agent and Skill invocation history to their exact product surfaces", async () => {
    harness.detail = {
      sessionKey: "codex:runtime-owner",
      source: "codex-cli",
      displayTitle: "Runtime owner",
    } as SessionSearchResult;
    await act(async () => root.render(createElement((await import("./App")).App)));
    const detailsProps = harness.sessionDetails.mock.calls.at(-1)?.[0] as {
      actions: { openInvocationOwner: (invocation: RuntimeInvocationSummary) => void };
    };

    await act(async () => {
      detailsProps.actions.openInvocationOwner({
        invocationId: "agent-invocation",
        surface: "agent",
        role: "chat",
        ownerReference: { chatId: "chat-1", agentId: "agent-1" },
        runtimeId: "codex",
        channelId: "codex-default",
        environmentId: "local",
        status: "completed",
        startedAt: 1,
        finishedAt: 2,
        relation: "created",
        runtimeSessionId: "session-1",
        runtimeTurnId: null,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(harness.runtimeFeaturePage).toHaveBeenCalled());
    expect(harness.runtimeFeaturePage.mock.calls.at(-1)?.[0]).toMatchObject({
      initialAgentId: "agent-1",
    });

    await act(async () => {
      detailsProps.actions.openInvocationOwner({
        invocationId: "skill-invocation",
        surface: "skill",
        role: "discovery",
        ownerReference: { channelId: "codex-default" },
        runtimeId: "codex",
        channelId: "codex-default",
        environmentId: "local",
        status: "completed",
        startedAt: 3,
        finishedAt: 4,
        relation: "created",
        runtimeSessionId: "session-2",
        runtimeTurnId: null,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(harness.skillsPage).toHaveBeenCalled());
    expect(harness.skillsPage.mock.calls.at(-1)?.[0]).toMatchObject({
      initialDiscoveryOpen: true,
    });

    const skillPageCalls = harness.skillsPage.mock.calls.length;
    harness.workbenchPage.mockClear();
    await act(async () => {
      detailsProps.actions.openInvocationOwner({
        invocationId: "future-invocation",
        surface: "future_surface",
        role: null,
        ownerReference: { futureId: "future-1" },
        runtimeId: "codex",
        channelId: "codex-default",
        environmentId: "local",
        status: "completed",
        startedAt: 5,
        finishedAt: 6,
        relation: "created",
        runtimeSessionId: "session-3",
        runtimeTurnId: null,
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(harness.workbenchPage).toHaveBeenCalled());
    expect(harness.skillsPage).toHaveBeenCalledTimes(skillPageCalls);
  });
});
