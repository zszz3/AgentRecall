// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  appNavigation: vi.fn((_props: unknown) => null),
  workbenchPage: vi.fn((_props: unknown) => null),
  workflowFeaturePage: vi.fn((_props: unknown) => null),
  getWorkflowWorkbench: vi.fn(),
  listMcpServers: vi.fn(async () => []),
  selectWorkflow: vi.fn(),
  createWorkflowDraft: vi.fn(),
  setSnapshot: vi.fn(),
  ensureDetailsLoaded: vi.fn(async () => undefined),
  loadCatalog: vi.fn(async () => undefined),
  setSelectedKey: vi.fn(),
  openLocalSession: vi.fn(),
  loadWorkbenchSessions: vi.fn(async () => undefined),
  loadStats: vi.fn(async () => undefined),
  automationError: null as string | null,
  automationSnapshot: {
    workflowStore: {
      workflows: [{
        workflowId: "legacy-workflow",
        title: "Legacy workflow",
        definition: { nodes: [] },
        status: "draft",
        updatedAt: 10,
      }],
      runs: [],
    },
    runtimes: [],
    channels: [],
  },
  workflowSidebar: {
    workflows: [{
      workflowId: "legacy-sidebar-workflow",
      title: "Legacy sidebar workflow",
      nodeCount: 0,
      status: "draft",
      updatedAt: 5,
    }],
  },
  skillsSnapshot: { skills: [] },
}));

vi.mock("./components/app-navigation", () => ({
  AppNavigation: harness.appNavigation,
}));
vi.mock("./features/workbench/workbench-page", () => ({
  WorkbenchPage: harness.workbenchPage,
}));
vi.mock("./features/automation/workflow-feature-page", () => ({
  WorkflowFeaturePage: harness.workflowFeaturePage,
}));
vi.mock("./features/sessions/sessions-page", () => ({ SessionsPage: () => null }));
vi.mock("./features/sessions/session-details", () => ({ SessionDetails: () => null }));
vi.mock("./features/remote-sessions/remote-sessions-dialog", () => ({
  RemoteSessionsDialog: () => null,
}));
vi.mock("./features/search/use-main-search-shortcut", () => ({
  useMainSearchShortcut: () => undefined,
}));

vi.mock("./features/sessions/use-session-detail", () => ({
  useSessionDetail: () => ({
    detail: null,
    remoteDetail: null,
    turns: [],
    turnsLoading: false,
    matchedTurnId: null,
    matchedMessageIndex: null,
    openLocal: harness.openLocalSession,
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
    sortBy: "recent",
    setSortBy: vi.fn(),
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
    searchAllMatching: vi.fn(async () => []),
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
    error: harness.automationError,
    api: harness,
    ensureDetailsLoaded: harness.ensureDetailsLoaded,
    setSnapshot: harness.setSnapshot,
  }),
}));

const firstWorkbenchSnapshot = {
  workflows: [{
    workflow: {
      workflowId: "core-workflow",
      title: "Core workflow",
    },
    nodeCount: 2,
    status: "waiting_for_user",
    updatedAt: 200,
  }],
  totalCount: 7,
  activeCount: 3,
};

interface WorkbenchProps {
  workflows: typeof firstWorkbenchSnapshot.workflows;
  workflowsLoading: boolean;
  workflowsError: string | null;
  workflowTotalCount: number;
  activeWorkflowCount: number;
  onOpenWorkflow: (workflowId: string) => void;
  onNewWorkflow: () => void;
  onShowWorkflows: () => void;
}

interface NavigationProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

interface WorkflowFeatureProps {
  initialRequest?: { workflowId: string } | { createNew: true };
}

describe("App workflow workbench wiring", () => {
  let App: typeof import("./App").App;
  let root: Root | undefined;
  let container: HTMLDivElement;

  const latestWorkbenchProps = (): WorkbenchProps =>
    harness.workbenchPage.mock.calls.at(-1)?.[0] as WorkbenchProps;
  const latestNavigationProps = (): NavigationProps =>
    harness.appNavigation.mock.calls.at(-1)?.[0] as NavigationProps;
  const latestWorkflowFeatureProps = (): WorkflowFeatureProps =>
    harness.workflowFeaturePage.mock.calls.at(-1)?.[0] as WorkflowFeatureProps;

  async function renderApp(): Promise<void> {
    root = createRoot(container);
    await act(async () => root?.render(createElement(App)));
  }

  async function waitForApp(assertion: () => void): Promise<void> {
    await act(async () => {
      await vi.waitFor(assertion);
    });
  }

  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Reflect.set(window, "sessionSearch", {
      platform: "win32",
      onOpenSession: () => vi.fn(),
      onIndexStatus: () => vi.fn(),
      onFocusSearch: () => vi.fn(),
      onOpenSettings: () => vi.fn(),
      onAppUpdateStatus: () => vi.fn(),
      onAppUpdateProgress: () => vi.fn(),
      onEnvironmentsUpdated: () => vi.fn(),
      onMigrationProgress: () => vi.fn(),
      getIndexStatus: vi.fn(async () => ({
        running: false,
        indexed: 0,
        skipped: 0,
        total: 0,
        lastIndexedAt: null,
        error: null,
      })),
      getAppUpdateStatus: vi.fn(async () => null),
      getSettings: vi.fn(async () => null),
      setInterfaceZoomFactor: vi.fn(async () => undefined),
      getSessionSyncHookStatus: vi.fn(async () => null),
      getSkillEvalFindingCounts: vi.fn(async () => []),
      listTags: vi.fn(async () => []),
      listProjects: vi.fn(async () => []),
      listEnvironments: vi.fn(async () => []),
      listTagsByProject: vi.fn(async () => []),
      listSkills: vi.fn(async () => ({ skills: [] })),
      getOpenVikingMemorySnapshot: vi.fn(async () => null),
      getSession: vi.fn(async () => null),
      getLiveSessions: vi.fn(async () => ({ sessions: [], error: null })),
      previewBulkDelete: vi.fn(),
      bulkDeleteSessions: vi.fn(),
      setOpenSession: vi.fn(),
    });
    ({ App } = await import("./App"));
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    harness.automationError = null;
    harness.getWorkflowWorkbench.mockResolvedValue(firstWorkbenchSnapshot);
    harness.selectWorkflow.mockResolvedValue(harness.automationSnapshot);
    harness.createWorkflowDraft.mockResolvedValue(harness.automationSnapshot);
    harness.ensureDetailsLoaded.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  it("loads the real workflow workbench snapshot and refreshes it when returning", async () => {
    await renderApp();

    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));
    expect(harness.getWorkflowWorkbench).toHaveBeenCalledWith();
    expect(latestWorkbenchProps()).toMatchObject({
      workflows: firstWorkbenchSnapshot.workflows,
      workflowsLoading: false,
      workflowsError: null,
      workflowTotalCount: 7,
      activeWorkflowCount: 3,
    });
    expect(latestWorkbenchProps().workflows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ workflow: expect.objectContaining({ workflowId: "legacy-workflow" }) }),
      expect.objectContaining({ workflow: expect.objectContaining({ workflowId: "legacy-sidebar-workflow" }) }),
    ]));

    harness.getWorkflowWorkbench.mockResolvedValue({
      workflows: [{
        ...firstWorkbenchSnapshot.workflows[0],
        workflow: {
          workflowId: "core-workflow",
          title: "Renamed core workflow",
        },
        updatedAt: 300,
      }],
      totalCount: 8,
      activeCount: 1,
    });

    await act(async () => latestWorkbenchProps().onShowWorkflows());
    await waitForApp(() => expect(latestNavigationProps().activePage).toBe("workflows"));
    await act(async () => latestNavigationProps().onNavigate("workbench"));

    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(2));
    await waitForApp(() => expect(latestWorkbenchProps()).toMatchObject({
      workflows: [expect.objectContaining({
        workflow: {
          workflowId: "core-workflow",
          title: "Renamed core workflow",
        },
        updatedAt: 300,
      })],
      workflowsLoading: false,
      workflowsError: null,
      workflowTotalCount: 8,
      activeWorkflowCount: 1,
    }));
  });

  it("reports workbench snapshot failures independently from the legacy automation snapshot", async () => {
    harness.automationError = "legacy automation error";
    harness.getWorkflowWorkbench.mockRejectedValue(new Error("workflow workbench unavailable"));

    await renderApp();

    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));
    await waitForApp(() => expect(latestWorkbenchProps()).toMatchObject({
      workflows: [],
      workflowsLoading: false,
      workflowsError: "workflow workbench unavailable",
      workflowTotalCount: 0,
      activeWorkflowCount: 0,
    }));
  });

  it("opens a workbench workflow through the feature page request without selecting a legacy workflow", async () => {
    let finishLoadingDetails: (() => void) | undefined;
    const detailsLoaded = new Promise<undefined>((resolve) => {
      finishLoadingDetails = () => resolve(undefined);
    });
    harness.ensureDetailsLoaded.mockReturnValue(detailsLoaded);
    await renderApp();
    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));

    await act(async () => latestWorkbenchProps().onOpenWorkflow("core-workflow"));

    await waitForApp(() => expect(harness.ensureDetailsLoaded).toHaveBeenCalledTimes(1));
    expect(harness.workflowFeaturePage).not.toHaveBeenCalled();
    await act(async () => {
      finishLoadingDetails?.();
      await detailsLoaded;
    });
    await waitForApp(() => expect(harness.workflowFeaturePage).toHaveBeenCalled());
    expect(latestWorkflowFeatureProps().initialRequest).toEqual({ workflowId: "core-workflow" });
    expect(harness.selectWorkflow).not.toHaveBeenCalled();
    expect(harness.createWorkflowDraft).not.toHaveBeenCalled();
    expect(harness.setSnapshot).not.toHaveBeenCalled();
  });

  it("starts a new workflow through the feature page request without creating a legacy draft", async () => {
    let finishLoadingDetails: (() => void) | undefined;
    const detailsLoaded = new Promise<undefined>((resolve) => {
      finishLoadingDetails = () => resolve(undefined);
    });
    harness.ensureDetailsLoaded.mockReturnValue(detailsLoaded);
    await renderApp();
    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));

    await act(async () => latestWorkbenchProps().onNewWorkflow());

    await waitForApp(() => expect(harness.ensureDetailsLoaded).toHaveBeenCalledTimes(1));
    expect(harness.workflowFeaturePage).not.toHaveBeenCalled();
    await act(async () => {
      finishLoadingDetails?.();
      await detailsLoaded;
    });
    await waitForApp(() => expect(harness.workflowFeaturePage).toHaveBeenCalled());
    expect(latestWorkflowFeatureProps().initialRequest).toEqual({ createNew: true });
    expect(harness.createWorkflowDraft).not.toHaveBeenCalled();
    expect(harness.selectWorkflow).not.toHaveBeenCalled();
    expect(harness.setSnapshot).not.toHaveBeenCalled();
  });

  it("drops a pending new-workflow request when the user navigates away during detail loading", async () => {
    let finishLoadingDetails: (() => void) | undefined;
    const detailsLoaded = new Promise<undefined>((resolve) => {
      finishLoadingDetails = () => resolve(undefined);
    });
    harness.ensureDetailsLoaded.mockReturnValue(detailsLoaded);
    await renderApp();
    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));

    await act(async () => latestWorkbenchProps().onNewWorkflow());
    await waitForApp(() => expect(harness.ensureDetailsLoaded).toHaveBeenCalledTimes(1));

    await act(async () => latestNavigationProps().onNavigate("workflows"));
    await waitForApp(() => expect(latestNavigationProps().activePage).toBe("workflows"));
    expect(latestWorkflowFeatureProps().initialRequest).toBeUndefined();

    await act(async () => {
      finishLoadingDetails?.();
      await detailsLoaded;
    });
    await act(async () => latestNavigationProps().onNavigate("workbench"));
    await waitForApp(() => expect(latestNavigationProps().activePage).toBe("workbench"));
    await act(async () => latestNavigationProps().onNavigate("workflows"));
    await waitForApp(() => expect(latestNavigationProps().activePage).toBe("workflows"));

    expect(latestWorkflowFeatureProps().initialRequest).toBeUndefined();
    expect(harness.createWorkflowDraft).not.toHaveBeenCalled();
  });

  it("loads automation details before showing all workflows", async () => {
    let finishLoadingDetails: (() => void) | undefined;
    const detailsLoaded = new Promise<undefined>((resolve) => {
      finishLoadingDetails = () => resolve(undefined);
    });
    harness.ensureDetailsLoaded.mockReturnValue(detailsLoaded);
    await renderApp();
    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));

    await act(async () => latestWorkbenchProps().onShowWorkflows());

    await waitForApp(() => expect(harness.ensureDetailsLoaded).toHaveBeenCalledTimes(1));
    expect(harness.workflowFeaturePage).not.toHaveBeenCalled();
    await act(async () => {
      finishLoadingDetails?.();
      await detailsLoaded;
    });
    await waitForApp(() => expect(harness.workflowFeaturePage).toHaveBeenCalled());
    expect(latestWorkflowFeatureProps().initialRequest).toBeUndefined();
  });

  it("reports automation detail load failures without leaving the workbench", async () => {
    harness.ensureDetailsLoaded.mockRejectedValue(new Error("automation details unavailable"));
    await renderApp();
    await waitForApp(() => expect(harness.getWorkflowWorkbench).toHaveBeenCalledTimes(1));

    await act(async () => latestWorkbenchProps().onOpenWorkflow("core-workflow"));

    await waitForApp(() => {
      expect(container.querySelector('[role="status"]')?.textContent).toContain("automation details unavailable");
    });
    expect(latestNavigationProps().activePage).toBe("workbench");
    expect(harness.workflowFeaturePage).not.toHaveBeenCalled();
    expect(harness.selectWorkflow).not.toHaveBeenCalled();
    expect(harness.createWorkflowDraft).not.toHaveBeenCalled();
    expect(harness.setSnapshot).not.toHaveBeenCalled();
  });
});
