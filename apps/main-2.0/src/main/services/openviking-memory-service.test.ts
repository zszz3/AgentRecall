import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENVIKING_ACCOUNT_ID,
  type OpenVikingImportState,
  type OpenVikingWorkspace,
} from "../../core/openviking-memory";
import type {
  SessionSearchResult,
  SessionTurnDetail,
  SessionTurnSummary,
} from "../../core/types";
import type {
  CreateOpenVikingImportTaskInput,
  OpenVikingImportTask,
} from "../../core/postgres/openviking-memory-repository";
import type {
  OpenVikingClientPort,
  OpenVikingWorkspaceAuth,
} from "./openviking-client";
import {
  OpenVikingMemoryService,
  OpenVikingWorkspaceCredentialStore,
  resolveDirectoryIdentity,
  type OpenVikingMemoryStorePort,
} from "./openviking-memory-service";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function workspace(overrides: Partial<OpenVikingWorkspace> = {}): OpenVikingWorkspace {
  return {
    id: "workspace-1",
    userId: "workspace_abcd",
    rootPath: "/projects/app",
    identity: "repo:github.com/acme/app",
    displayName: "app",
    managed: true,
    importState: "idle",
    importedTurns: 0,
    totalTurns: 0,
    completedTasks: 0,
    totalTasks: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function session(sessionKey: string, source: SessionSearchResult["source"] = "codex-cli"): SessionSearchResult {
  return {
    sessionKey,
    rawId: sessionKey,
    source,
    projectPath: "/projects/app",
    filePath: `/fixtures/${sessionKey}.jsonl`,
    originalTitle: sessionKey,
    firstQuestion: "question",
    timestamp: 1,
    fileMtimeMs: 1,
    fileSize: 1,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    displayTitle: sessionKey,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 1,
    messageCount: 2,
    aiSummary: null,
    aiSummaryStale: false,
  };
}

function turn(id: string, turnIndex: number): SessionTurnSummary {
  return {
    id,
    turnIndex,
    sourceMessageIndex: turnIndex * 2,
    synthetic: false,
    status: "completed",
    startedAt: "2026-07-24T00:00:00.000Z",
    endedAt: "2026-07-24T00:00:01.000Z",
    userPreview: "question",
    assistantPreview: "answer",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    toolNames: [],
    messageCount: 2,
    spanCount: 0,
  };
}

function detail(summary: SessionTurnSummary, user: string, assistant: string): SessionTurnDetail {
  return {
    ...summary,
    messages: [
      {
        messageIndex: 0,
        sourceMessageIndex: 0,
        role: "user",
        content: user,
        timestamp: "2026-07-24T00:00:00.000Z",
      },
      {
        messageIndex: 1,
        sourceMessageIndex: 1,
        role: "assistant",
        content: assistant,
        timestamp: "2026-07-24T00:00:01.000Z",
      },
    ],
    spans: [],
  };
}

function harness(options: {
  initialWorkspaces?: OpenVikingWorkspace[];
  sessions?: SessionSearchResult[];
  turns?: Record<string, SessionTurnSummary[]>;
  details?: Record<string, SessionTurnDetail>;
  sleep?: (durationMs: number) => Promise<void>;
} = {}) {
  const workspaces = [...(options.initialWorkspaces ?? [])];
  const jobs = new Map<string, {
    state: OpenVikingImportState;
    importedTurns: number;
    totalTurns: number;
    cursorSessionKey: string | null;
    selectedSessionKeys?: string[] | null;
    lastError: string | null;
  }>();
  const imported = new Set<string>();
  const importTasks = new Map<string, OpenVikingImportTask>();
  const sessionCheckpoints = new Map<string, {
    workspaceId: string;
    sessionKey: string;
    sourceRevision: string;
    importedTurns: number;
    updatedAt: string;
  }>();
  const events: string[] = [];
  const store: OpenVikingMemoryStorePort = {
    listOpenVikingWorkspaces: vi.fn(async () => [...workspaces]),
    getOpenVikingWorkspace: vi.fn(async (id) => workspaces.find((item) => item.id === id) ?? null),
    findOpenVikingWorkspaceByRootPath: vi.fn(async (rootPath) =>
      workspaces.find((item) => item.rootPath === rootPath) ?? null),
    findOpenVikingWorkspaceByIdentity: vi.fn(async (identity) =>
      workspaces.find((item) => item.identity === identity) ?? null),
    addOpenVikingWorkspace: vi.fn(async (input) => {
      const created = workspace({ ...input });
      workspaces.push(created);
      return created;
    }),
    relinkOpenVikingWorkspace: vi.fn(async (id, rootPath, displayName) => {
      const current = workspaces.find((item) => item.id === id);
      if (!current) throw new Error("missing");
      Object.assign(current, { rootPath, displayName });
      return current;
    }),
    setOpenVikingWorkspaceManaged: vi.fn(async (id, managed) => {
      const current = workspaces.find((item) => item.id === id);
      if (!current) throw new Error("missing");
      current.managed = managed;
      return current;
    }),
    deleteOpenVikingWorkspace: vi.fn(async (id) => {
      events.push("local-delete");
      const index = workspaces.findIndex((item) => item.id === id);
      if (index < 0) return false;
      workspaces.splice(index, 1);
      return true;
    }),
    searchSessions: vi.fn(async () => options.sessions ?? []),
    listSessionTurns: vi.fn(async (sessionKey) => options.turns?.[sessionKey] ?? []),
    getSessionTurn: vi.fn(async (_sessionKey, turnId) => options.details?.[turnId] ?? null),
    getOpenVikingImportJob: vi.fn(async (workspaceId) => {
      const job = jobs.get(workspaceId);
      return job ? { workspaceId, updatedAt: "2026-07-24T00:00:00.000Z", ...job } : null;
    }),
    setOpenVikingImportSelection: vi.fn(async (workspaceId, selectedSessionKeys) => {
      const current = jobs.get(workspaceId);
      if (!current) throw new Error("missing");
      const next = { ...current, selectedSessionKeys };
      jobs.set(workspaceId, next);
      return { workspaceId, updatedAt: "2026-07-24T00:00:00.000Z", ...next };
    }),
    updateOpenVikingImportJob: vi.fn(async (workspaceId, update) => {
      jobs.set(workspaceId, { ...jobs.get(workspaceId), ...update });
      const current = workspaces.find((item) => item.id === workspaceId);
      if (current) Object.assign(current, {
        importState: update.state,
        importedTurns: update.importedTurns,
        totalTurns: update.totalTurns,
        ...(update.lastError ? { lastError: update.lastError } : {}),
      });
      return {
        workspaceId,
        updatedAt: "2026-07-24T00:00:00.000Z",
        ...jobs.get(workspaceId)!,
      };
    }),
    hasOpenVikingImportedTurn: vi.fn(async (workspaceId, sourceTurnId, fingerprint) =>
      imported.has(`${workspaceId}:${sourceTurnId}:${fingerprint}`)),
    listOpenVikingImportedTurns: vi.fn(async (workspaceId) =>
      [...imported]
        .filter((entry) => entry.startsWith(`${workspaceId}:`))
        .map((entry) => {
          const value = entry.slice(workspaceId.length + 1);
          const separator = value.lastIndexOf(":");
          return {
            sourceTurnId: value.slice(0, separator),
            fingerprint: value.slice(separator + 1),
          };
        })),
    recordOpenVikingImportedTurn: vi.fn(async (workspaceId, sourceTurnId, fingerprint) => {
      imported.add(`${workspaceId}:${sourceTurnId}:${fingerprint}`);
    }),
    listOpenVikingSessionCheckpoints: vi.fn(async (workspaceId) =>
      [...sessionCheckpoints.values()].filter((entry) => entry.workspaceId === workspaceId)),
    recordOpenVikingSessionCheckpoint: vi.fn(async (
      workspaceId,
      sessionKey,
      sourceRevision,
      importedTurns,
    ) => {
      sessionCheckpoints.set(`${workspaceId}:${sessionKey}`, {
        workspaceId,
        sessionKey,
        sourceRevision,
        importedTurns,
        updatedAt: "2026-07-24T00:00:00.000Z",
      });
    }),
    syncOpenVikingImportTasks: vi.fn(async (
      workspaceId: string,
      inputs: CreateOpenVikingImportTaskInput[],
      activeRevisions: Array<{ sessionKey: string; sourceRevision: string }>,
    ) => {
      const active = new Set(activeRevisions.map(
        (entry) => `${entry.sessionKey}\0${entry.sourceRevision}`,
      ));
      const inputIds = new Set(inputs.map((input) => input.id));
      for (const task of [...importTasks.values()]) {
        const revision = `${task.sessionKey}\0${task.sourceRevision}`;
        if (!active.has(revision) || (task.state !== "completed" && !inputIds.has(task.id))) {
          importTasks.delete(task.id);
        }
      }
      for (const input of inputs) {
        if (importTasks.has(input.id)) continue;
        importTasks.set(input.id, {
          ...input,
          state: "queued",
          attemptCount: 0,
          remoteTaskId: null,
          lastError: null,
          createdAt: "2026-07-24T00:00:00.000Z",
          updatedAt: "2026-07-24T00:00:00.000Z",
        });
      }
      const current = workspaces.find((item) => item.id === workspaceId);
      if (current) {
        current.totalTasks = importTasks.size;
        current.completedTasks = [...importTasks.values()]
          .filter((task) => task.state === "completed").length;
      }
      return [...importTasks.values()];
    }),
    listOpenVikingImportTasks: vi.fn(async () => [...importTasks.values()]),
    beginOpenVikingImportTaskAttempt: vi.fn(async (taskId) => {
      const task = importTasks.get(taskId);
      if (!task) throw new Error("missing task");
      Object.assign(task, {
        state: "uploading",
        attemptCount: task.attemptCount + 1,
        remoteTaskId: null,
        lastError: null,
      });
      return task;
    }),
    waitForOpenVikingImportTask: vi.fn(async (taskId, remoteTaskId) => {
      const task = importTasks.get(taskId);
      if (!task) throw new Error("missing task");
      Object.assign(task, { state: "waiting", remoteTaskId });
    }),
    completeOpenVikingImportTask: vi.fn(async (taskId) => {
      const task = importTasks.get(taskId);
      if (!task) throw new Error("missing task");
      for (const turn of task.payload.primary) {
        imported.add(`${task.workspaceId}:${turn.sourceTurnId}:${turn.fingerprint}`);
      }
      task.state = "completed";
      const current = workspaces.find((item) => item.id === task.workspaceId);
      if (current) {
        current.completedTasks = [...importTasks.values()]
          .filter((entry) => entry.state === "completed").length;
      }
    }),
    failOpenVikingImportTask: vi.fn(async (taskId, error) => {
      const task = importTasks.get(taskId);
      if (!task) throw new Error("missing task");
      Object.assign(task, { state: "failed", lastError: error });
    }),
  };
  const auth: OpenVikingWorkspaceAuth = {
    accountId: OPENVIKING_ACCOUNT_ID,
    userId: "workspace_abcd",
    apiKey: "workspace-key",
  };
  const client: OpenVikingClientPort = {
    health: vi.fn(async () => undefined),
    ensureWorkspaceUser: vi.fn(async ({ accountId, userId }) => ({ ...auth, accountId, userId })),
    deleteWorkspaceUser: vi.fn(async () => {
      events.push("remote-delete");
    }),
    appendMessages: vi.fn(async () => undefined),
    commitSession: vi.fn(async () => ({ taskId: "task-1" })),
    getTask: vi.fn(async () => ({ id: "task-1", status: "completed" })),
    searchMemories: vi.fn(async () => []),
    readMemory: vi.fn(async () => ""),
    saveMemory: vi.fn(async (_auth, input) => ({
      id: "manual",
      workspaceId: "",
      title: input.title,
      content: input.content,
    })),
    deleteMemory: vi.fn(async () => undefined),
  };
  const keys = new Map<string, OpenVikingWorkspaceAuth>();
  const credentials = {
    get: vi.fn(async (workspaceId: string) => keys.get(workspaceId) ?? null),
    set: vi.fn(async (workspaceId: string, value: OpenVikingWorkspaceAuth) => {
      keys.set(workspaceId, value);
    }),
    delete: vi.fn(async (workspaceId: string) => {
      keys.delete(workspaceId);
    }),
  };
  if (options.initialWorkspaces?.[0]) keys.set(options.initialWorkspaces[0].id, auth);
  const service = new OpenVikingMemoryService({
    store,
    client,
    credentials,
    inspectDirectory: async (rootPath) => path.resolve(rootPath),
    resolveIdentity: async () => "repo:github.com/acme/app",
    createId: () => "workspace-1",
    sleep: options.sleep ?? (async () => undefined),
  });
  return {
    service,
    store,
    client,
    credentials,
    workspaces,
    jobs,
    importTasks,
    imported,
    sessionCheckpoints,
    events,
  };
}

describe("OpenVikingMemoryService", () => {
  it("previews and adds a directory, then rejects an exact duplicate", async () => {
    const sessions = [session("codex:1"), session("claude:2", "claude-cli")];
    const { service, client, store } = harness({ sessions });

    await expect(service.previewDirectory("/projects/app")).resolves.toMatchObject({
      rootPath: "/projects/app",
      displayName: "app",
      sessionCount: 2,
      existingWorkspaceId: null,
      relinkWorkspaceId: null,
    });
    await expect(service.addWorkspace("/projects/app")).resolves.toMatchObject({
      id: "workspace-1",
      userId: expect.stringMatching(/^workspace_/),
      rootPath: "/projects/app",
    });
    expect(client.ensureWorkspaceUser).toHaveBeenCalledWith({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: expect.stringMatching(/^workspace_/),
    });
    expect(store.addOpenVikingWorkspace).toHaveBeenCalledOnce();

    await expect(service.addWorkspace("/projects/app")).rejects.toThrow("already managed");
  });

  it("relinks a moved Git directory without creating a second OpenViking user", async () => {
    const current = workspace({ rootPath: "/projects/old" });
    const { service, client, store } = harness({ initialWorkspaces: [current] });

    await expect(service.previewDirectory("/projects/new")).resolves.toMatchObject({
      relinkWorkspaceId: "workspace-1",
    });
    await expect(service.addWorkspace("/projects/new")).resolves.toMatchObject({
      id: "workspace-1",
      rootPath: "/projects/new",
      userId: "workspace_abcd",
    });
    expect(store.relinkOpenVikingWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      "/projects/new",
      "new",
    );
    expect(client.ensureWorkspaceUser).not.toHaveBeenCalled();
  });

  it("resumes a retained workspace when its exact directory is selected again", async () => {
    const retained = workspace({ managed: false });
    const { service, client, store } = harness({ initialWorkspaces: [retained] });

    await expect(service.addWorkspace(retained.rootPath)).resolves.toMatchObject({
      id: retained.id,
      managed: true,
    });
    expect(store.setOpenVikingWorkspaceManaged).toHaveBeenCalledWith(retained.id, true);
    expect(store.addOpenVikingWorkspace).not.toHaveBeenCalled();
    expect(client.ensureWorkspaceUser).not.toHaveBeenCalled();
  });

  it("repairs missing workspace credentials before resuming retained memory", async () => {
    const retained = workspace({ managed: false });
    const { service, client, credentials } = harness({ initialWorkspaces: [retained] });
    await credentials.delete(retained.id);

    await expect(service.addWorkspace(retained.rootPath)).resolves.toMatchObject({
      id: retained.id,
      managed: true,
    });

    expect(client.ensureWorkspaceUser).toHaveBeenCalledWith({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: retained.userId,
    });
    expect(credentials.set).toHaveBeenCalledWith(retained.id, expect.objectContaining({
      userId: retained.userId,
    }));
  });

  it("imports useful turns with deterministic sessions, truncation and persisted dedupe", async () => {
    const first = turn("turn-1", 0);
    const empty = turn("turn-2", 1);
    const long = turn("turn-3", 2);
    const longAnswer = "a".repeat(20_000);
    const { service, client, store } = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [first, empty, long] },
      details: {
        "turn-1": detail(first, "question", "answer"),
        "turn-2": detail(empty, " ", "tool noise only"),
        "turn-3": detail(long, "long question", longAnswer),
      },
    });

    await expect(service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 2,
      totalTurns: 2,
    });
    expect(client.appendMessages).toHaveBeenCalledTimes(2);
    expect(client.appendMessages).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringMatching(/^agentrecall_[a-f0-9]{32}$/u),
      [
        expect.objectContaining({ role: "user", content: "question" }),
        expect.objectContaining({ role: "assistant", content: "answer" }),
      ],
    );
    const secondBatch = vi.mocked(client.appendMessages).mock.calls[1][2];
    expect(secondBatch[1].content).toHaveLength(12_000);
    expect(store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
    expect(client.commitSession).toHaveBeenCalledOnce();

    vi.mocked(store.listSessionTurns).mockClear();
    vi.mocked(store.getSessionTurn).mockClear();
    await service.importWorkspace("workspace-1");
    expect(client.appendMessages).toHaveBeenCalledTimes(2);
    expect(store.listSessionTurns).not.toHaveBeenCalled();
    expect(store.getSessionTurn).not.toHaveBeenCalled();
  });

  it("commits every Turn from one scanned Session in one OpenViking task", async () => {
    const summaries = Array.from({ length: 60 }, (_, index) => turn(`turn-${index + 1}`, index));
    const longContent = "x".repeat(1_000);
    const details = Object.fromEntries(summaries.map((summary, index) => [
      summary.id,
      detail(summary, `${longContent}${index}`, `${longContent}${index}`),
    ]));
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:large")],
      turns: { "codex:large": summaries },
      details,
    });

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 60,
      totalTurns: 60,
    });

    const plannedTasks = vi.mocked(h.store.syncOpenVikingImportTasks).mock.calls[0][1];
    expect(plannedTasks).toHaveLength(1);
    expect(plannedTasks[0].payload.primary).toHaveLength(60);
    const appendedSessionIds = vi.mocked(h.client.appendMessages).mock.calls.map((call) => call[1]);
    expect(new Set(appendedSessionIds)).toHaveLength(1);
    expect(h.client.appendMessages).toHaveBeenCalledTimes(60);
    expect(h.client.commitSession).toHaveBeenCalledOnce();
    expect(h.client.commitSession).toHaveBeenCalledWith(
      expect.anything(),
      appendedSessionIds[0],
      0,
    );
    expect(h.store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
  });

  it("imports only changed Turns without replaying artificial overlap", async () => {
    const sourceSession = session("codex:changed");
    const summaries = Array.from({ length: 41 }, (_, index) => turn(`turn-${index + 1}`, index));
    const details = Object.fromEntries(summaries.map((summary, index) => [
      summary.id,
      detail(summary, `question ${index + 1}`, `answer ${index + 1}`),
    ]));
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [sourceSession],
      turns: { "codex:changed": summaries },
      details,
    });
    await h.service.importWorkspace("workspace-1");
    const stableSessionId = vi.mocked(h.client.appendMessages).mock.calls[0][1];
    vi.mocked(h.client.appendMessages).mockClear();
    vi.mocked(h.client.commitSession).mockClear();
    vi.mocked(h.store.recordOpenVikingImportedTurn).mockClear();
    vi.mocked(h.store.completeOpenVikingImportTask).mockClear();

    details["turn-1"] = detail(summaries[0], "changed first question", "answer 1");
    details["turn-41"] = detail(summaries[40], "changed last question", "answer 41");
    sourceSession.fileSize += 1;

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 41,
      totalTurns: 41,
    });
    const appendedSessionIds = vi.mocked(h.client.appendMessages).mock.calls.map((call) => call[1]);
    expect(appendedSessionIds).toEqual([stableSessionId, stableSessionId]);
    expect(h.client.commitSession).toHaveBeenCalledWith(
      expect.anything(),
      stableSessionId,
      0,
    );
    expect(h.store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
  });

  it("repairs displayed progress from persisted turn checkpoints", async () => {
    const summary = turn("turn-1", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });

    await h.service.importWorkspace("workspace-1");
    h.jobs.set("workspace-1", {
      state: "failed",
      importedTurns: 0,
      totalTurns: 1,
      cursorSessionKey: "codex:1",
      lastError: "stale import failed",
    });

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 1,
      totalTurns: 1,
    });
    expect(h.client.appendMessages).toHaveBeenCalledOnce();
  });

  it("re-reads only the Session whose indexed source revision changed", async () => {
    const firstSession = session("codex:1");
    const secondSession = session("codex:2");
    const firstTurn = turn("turn-1", 0);
    const secondTurn = turn("turn-2", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [firstSession, secondSession],
      turns: {
        "codex:1": [firstTurn],
        "codex:2": [secondTurn],
      },
      details: {
        "turn-1": detail(firstTurn, "first question", "first answer"),
        "turn-2": detail(secondTurn, "second question", "second answer"),
      },
    });
    await h.service.importWorkspace("workspace-1");
    vi.mocked(h.store.listSessionTurns).mockClear();
    vi.mocked(h.store.getSessionTurn).mockClear();

    secondSession.fileSize += 1;
    await h.service.importWorkspace("workspace-1");

    expect(h.store.listSessionTurns).toHaveBeenCalledOnce();
    expect(h.store.listSessionTurns).toHaveBeenCalledWith("codex:2");
    expect(h.store.getSessionTurn).toHaveBeenCalledOnce();
    expect(h.store.getSessionTurn).toHaveBeenCalledWith("codex:2", "turn-2");
    expect(h.client.appendMessages).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent imports for the same workspace", async () => {
    const summary = turn("turn-1", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });
    let finishTask!: () => void;
    const taskFinished = new Promise<void>((resolve) => {
      finishTask = resolve;
    });
    vi.mocked(h.client.getTask).mockImplementation(async () => {
      await taskFinished;
      return { id: "task-1", status: "completed" };
    });

    const first = h.service.importWorkspace("workspace-1");
    await vi.waitFor(() => expect(h.client.commitSession).toHaveBeenCalledOnce());
    const second = h.service.importWorkspace("workspace-1");
    const coalesced = first === second;
    finishTask();
    await Promise.all([first, second]);

    expect(coalesced).toBe(true);
    expect(h.store.searchSessions).toHaveBeenCalledOnce();
    expect(h.client.appendMessages).toHaveBeenCalledOnce();
    expect(h.client.commitSession).toHaveBeenCalledOnce();
  });

  it("marks sessions already selected by an active import as importing", async () => {
    const h = harness({
      initialWorkspaces: [workspace({ importState: "running" })],
      sessions: [session("codex:1"), session("codex:2")],
    });
    h.jobs.set("workspace-1", {
      state: "running",
      importedTurns: 0,
      totalTurns: 1,
      cursorSessionKey: "codex:1",
      selectedSessionKeys: ["codex:1"],
      lastError: null,
    });

    await expect(h.service.listImportSessions("workspace-1")).resolves.toEqual([
      expect.objectContaining({ sessionKey: "codex:1", state: "importing" }),
      expect.objectContaining({ sessionKey: "codex:2", state: "new" }),
    ]);
  });

  it("imports newly selected sessions after the current import finishes", async () => {
    const firstTurn = turn("turn-1", 0);
    const secondTurn = turn("turn-2", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1"), session("codex:2")],
      turns: {
        "codex:1": [firstTurn],
        "codex:2": [secondTurn],
      },
      details: {
        "turn-1": detail(firstTurn, "first question", "first answer"),
        "turn-2": detail(secondTurn, "second question", "second answer"),
      },
    });
    h.jobs.set("workspace-1", {
      state: "idle",
      importedTurns: 0,
      totalTurns: 0,
      cursorSessionKey: null,
      selectedSessionKeys: null,
      lastError: null,
    });
    let finishFirstTask!: () => void;
    const firstTaskFinished = new Promise<void>((resolve) => {
      finishFirstTask = resolve;
    });
    vi.mocked(h.client.getTask)
      .mockImplementationOnce(async () => {
        await firstTaskFinished;
        return { id: "task-1", status: "completed" };
      })
      .mockResolvedValue({ id: "task-2", status: "completed" });

    const firstImport = h.service.importWorkspace("workspace-1", ["codex:1"]);
    await vi.waitFor(() => expect(h.client.commitSession).toHaveBeenCalledOnce());
    const additionalImport = h.service.importWorkspace("workspace-1", ["codex:2"]);
    finishFirstTask();
    await Promise.all([firstImport, additionalImport]);

    expect(h.client.appendMessages).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.client.appendMessages).mock.calls.map((call) => call[2][0]?.content))
      .toEqual(["first question", "second question"]);
    expect(h.jobs.get("workspace-1")?.selectedSessionKeys).toEqual(["codex:1", "codex:2"]);
  });

  it("pauses safely and resumes from persisted import checkpoints", async () => {
    const summary = turn("turn-1", 0);
    const h = harness({
      initialWorkspaces: [workspace({ importState: "paused" })],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });
    h.jobs.set("workspace-1", {
      state: "paused",
      importedTurns: 0,
      totalTurns: 1,
      cursorSessionKey: null,
      lastError: null,
    });

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({ state: "paused" });
    expect(h.client.appendMessages).not.toHaveBeenCalled();

    await expect(h.service.resumeImport("workspace-1")).resolves.toMatchObject({
      state: "queued",
      importedTurns: 0,
    });
    await vi.waitFor(() => expect(h.jobs.get("workspace-1")).toMatchObject({
      state: "completed",
      importedTurns: 1,
    }));
  });

  it("stops waiting for a queued OpenViking task when the import is paused", async () => {
    const summary = turn("turn-1", 0);
    let reportSleeping!: () => void;
    let resumeSleeping!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      reportSleeping = resolve;
    });
    const sleepBarrier = new Promise<void>((resolve) => {
      resumeSleeping = resolve;
    });
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
      sleep: async () => {
        reportSleeping();
        await sleepBarrier;
      },
    });
    vi.mocked(h.client.getTask)
      .mockResolvedValueOnce({ id: "task-1", status: "pending" })
      .mockResolvedValue({ id: "task-1", status: "completed" });

    const importing = h.service.importWorkspace("workspace-1");
    await sleeping;
    await h.service.pauseImport("workspace-1");
    const settling = h.service.waitForImportToSettle("workspace-1");
    resumeSleeping();

    await expect(settling).resolves.toBeUndefined();
    await expect(importing).resolves.toMatchObject({
      state: "paused",
      importedTurns: 0,
    });
    expect(h.client.getTask).toHaveBeenCalledOnce();
    expect(h.store.completeOpenVikingImportTask).not.toHaveBeenCalled();

    vi.mocked(h.client.appendMessages).mockClear();
    vi.mocked(h.client.commitSession).mockClear();
    await h.service.resumeImport("workspace-1");
    await vi.waitFor(() => expect(h.jobs.get("workspace-1")).toMatchObject({
      state: "completed",
      importedTurns: 1,
    }));
    expect(h.client.appendMessages).not.toHaveBeenCalled();
    expect(h.client.commitSession).not.toHaveBeenCalled();
    expect(h.store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
  });

  it("waits for the paused import loop to exit before queueing a resume", async () => {
    const summary = turn("turn-1", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });
    let reportTaskStarted!: () => void;
    let rejectStoppedRequest!: (error: Error) => void;
    const taskStarted = new Promise<void>((resolve) => {
      reportTaskStarted = resolve;
    });
    vi.mocked(h.client.getTask).mockImplementationOnce(async () => {
      reportTaskStarted();
      return new Promise((_, reject) => {
        rejectStoppedRequest = reject;
      });
    });

    const importing = h.service.importWorkspace("workspace-1");
    await taskStarted;
    await h.service.pauseImport("workspace-1");
    const resuming = h.service.resumeImport("workspace-1");
    await Promise.resolve();

    expect(h.jobs.get("workspace-1")?.state).toBe("paused");
    rejectStoppedRequest(new Error("OpenViking stopped while polling the task."));
    await expect(importing).resolves.toMatchObject({ state: "paused" });
    await expect(resuming).resolves.toMatchObject({ state: "queued" });
    await vi.waitFor(() => expect(h.jobs.get("workspace-1")?.state).toBe("completed"));
  });

  it("returns a resumed remote task to running state while it is still processing", async () => {
    let reportSleeping!: () => void;
    let resumeSleeping!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      reportSleeping = resolve;
    });
    const sleepBarrier = new Promise<void>((resolve) => {
      resumeSleeping = resolve;
    });
    const h = harness({
      initialWorkspaces: [workspace({ importState: "queued" })],
      sessions: [session("codex:1")],
      sleep: async () => {
        reportSleeping();
        await sleepBarrier;
      },
    });
    h.jobs.set("workspace-1", {
      state: "queued",
      importedTurns: 0,
      totalTurns: 1,
      cursorSessionKey: "codex:1",
      selectedSessionKeys: ["codex:1"],
      lastError: null,
    });
    h.importTasks.set("task-1", {
      id: "task-1",
      position: 0,
      workspaceId: "workspace-1",
      sessionKey: "codex:1",
      sourceRevision: "revision-1",
      sessionTitle: "Session 1",
      payload: { context: [], primary: [] },
      state: "waiting",
      attemptCount: 1,
      remoteTaskId: "remote-task-1",
      lastError: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    });
    vi.mocked(h.client.getTask).mockResolvedValue({ id: "remote-task-1", status: "running" });

    const importing = h.service.importWorkspace("workspace-1");
    await sleeping;

    expect(h.jobs.get("workspace-1")?.state).toBe("running");
    await h.service.pauseImport("workspace-1");
    resumeSleeping();
    await importing;
  });

  it("finishes dispatching the current batch before honoring pause", async () => {
    const summaries = [turn("turn-1", 0), turn("turn-2", 1)];
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": summaries },
      details: {
        "turn-1": detail(summaries[0], "question 1", "answer 1"),
        "turn-2": detail(summaries[1], "question 2", "answer 2"),
      },
    });
    vi.mocked(h.client.appendMessages).mockImplementationOnce(async () => {
      await h.service.pauseImport("workspace-1");
    });

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "paused",
      importedTurns: 0,
    });
    expect(h.client.appendMessages).toHaveBeenCalledTimes(2);
    expect(h.client.commitSession).toHaveBeenCalledOnce();
    expect(h.store.completeOpenVikingImportTask).not.toHaveBeenCalled();

    await h.service.resumeImport("workspace-1");
    await vi.waitFor(() => expect(h.jobs.get("workspace-1")).toMatchObject({
      state: "completed",
      importedTurns: 2,
    }));
    expect(h.client.appendMessages).toHaveBeenCalledTimes(2);
    expect(h.client.commitSession).toHaveBeenCalledOnce();
    expect(h.store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
  });

  it("settles a dispatched task before replanning a Session that changed while paused", async () => {
    const summary = turn("turn-1", 0);
    const sourceSession = session("codex:1");
    let reportSleeping!: () => void;
    let resumeSleeping!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      reportSleeping = resolve;
    });
    const sleepBarrier = new Promise<void>((resolve) => {
      resumeSleeping = resolve;
    });
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [sourceSession],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
      sleep: async () => {
        reportSleeping();
        await sleepBarrier;
      },
    });
    vi.mocked(h.client.getTask)
      .mockResolvedValueOnce({ id: "task-1", status: "pending" })
      .mockResolvedValue({ id: "task-1", status: "completed" });

    const importing = h.service.importWorkspace("workspace-1");
    await sleeping;
    await h.service.pauseImport("workspace-1");
    resumeSleeping();
    await importing;

    sourceSession.fileSize += 1;
    vi.mocked(h.client.appendMessages).mockClear();
    vi.mocked(h.client.commitSession).mockClear();
    await h.service.resumeImport("workspace-1");
    await vi.waitFor(() => expect(h.jobs.get("workspace-1")).toMatchObject({
      state: "completed",
      importedTurns: 1,
    }));

    expect(h.store.completeOpenVikingImportTask).toHaveBeenCalledOnce();
    expect(h.client.appendMessages).not.toHaveBeenCalled();
    expect(h.client.commitSession).not.toHaveBeenCalled();
  });

  it("plans every Session first, runs two Sessions concurrently, and keeps each Session sequential", async () => {
    const longContent = "x".repeat(12_000);
    const first = Array.from({ length: 4 }, (_, index) => turn(`first-${index + 1}`, index));
    const second = Array.from({ length: 4 }, (_, index) => turn(`second-${index + 1}`, index));
    const details = Object.fromEntries([...first, ...second].map((summary) => [
      summary.id,
      detail(summary, longContent, longContent),
    ]));
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:first"), session("codex:second")],
      turns: {
        "codex:first": first,
        "codex:second": second,
      },
      details,
    });
    let active = 0;
    let maximum = 0;
    const activeBySession = new Map<string, number>();
    const maximumBySession = new Map<string, number>();
    let releaseFirstWave!: () => void;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });
    let taskNumber = 0;
    vi.mocked(h.client.commitSession).mockImplementation(async (_auth, sessionId) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const sessionActive = (activeBySession.get(sessionId) ?? 0) + 1;
      activeBySession.set(sessionId, sessionActive);
      maximumBySession.set(sessionId, Math.max(
        maximumBySession.get(sessionId) ?? 0,
        sessionActive,
      ));
      if (active === 2) releaseFirstWave();
      await firstWave;
      active -= 1;
      activeBySession.set(sessionId, sessionActive - 1);
      return { taskId: `task-${++taskNumber}` };
    });

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 8,
    });
    const plannedTasks = vi.mocked(h.store.syncOpenVikingImportTasks).mock.calls[0][1];
    expect(plannedTasks).toHaveLength(2);
    expect(new Set(plannedTasks.map((task) => task.sessionKey))).toEqual(new Set([
      "codex:first",
      "codex:second",
    ]));
    expect(maximum).toBe(2);
    expect([...maximumBySession.values()]).toEqual([1, 1]);
    expect(h.client.commitSession).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting while OpenViking reports a queued commit task", async () => {
    const summary = turn("turn-1", 0);
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [session("codex:1")],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });
    let polls = 0;
    vi.mocked(h.client.getTask).mockImplementation(async () => ({
      id: "task-1",
      status: ++polls > 1_200 ? "completed" : "pending",
    }));

    await expect(h.service.importWorkspace("workspace-1")).resolves.toMatchObject({
      state: "completed",
      importedTurns: 1,
    });
    expect(h.client.getTask).toHaveBeenCalledTimes(1_201);
  });

  it("reports the current session and extraction phase while an import is active", async () => {
    const summary = turn("turn-1", 0);
    const currentSession = session("codex:1");
    currentSession.displayTitle = "Fix login timeout";
    const h = harness({
      initialWorkspaces: [workspace()],
      sessions: [currentSession],
      turns: { "codex:1": [summary] },
      details: { "turn-1": detail(summary, "question", "answer") },
    });
    let finishCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    vi.mocked(h.client.commitSession).mockImplementation(async () => {
      await commitBarrier;
      return { taskId: "task-1" };
    });

    const importing = h.service.importWorkspace("workspace-1");
    await vi.waitFor(() => expect(h.client.commitSession).toHaveBeenCalledOnce());

    await expect(h.service.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({
        importActivity: expect.objectContaining({
          phase: "extracting",
          sessionTitle: "Fix login timeout",
          currentSession: 1,
          totalSessions: 1,
          currentBatch: 1,
          totalBatches: 1,
        }),
      }),
    ]);

    finishCommit();
    await importing;
    await expect(h.service.listWorkspaces()).resolves.toEqual([
      expect.not.objectContaining({ importActivity: expect.anything() }),
    ]);
  });

  it("stops management without deleting data, but purges remote data before local mapping", async () => {
    const h = harness({ initialWorkspaces: [workspace()] });

    await h.service.stopManaging("workspace-1");
    expect(h.store.setOpenVikingWorkspaceManaged).toHaveBeenCalledWith("workspace-1", false);
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();

    await h.service.deleteWorkspace("workspace-1");
    expect(h.client.ensureWorkspaceUser).toHaveBeenCalledWith({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: "workspace_abcd",
    });
    expect(h.events).toEqual(["remote-delete", "local-delete"]);
    expect(h.credentials.delete).toHaveBeenCalledWith("workspace-1");
  });

  it("treats deleting an already removed workspace as successful cleanup", async () => {
    const h = harness();

    await expect(h.service.deleteWorkspace("workspace-1")).resolves.toBeUndefined();

    expect(h.client.ensureWorkspaceUser).not.toHaveBeenCalled();
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();
    expect(h.credentials.delete).toHaveBeenCalledWith("workspace-1");
  });
});

describe("OpenViking directory identity", () => {
  it("normalizes a Git SSH remote into a move-stable identity", async () => {
    await expect(resolveDirectoryIdentity("/projects/app", {
      runGit: async (_rootPath, args) => args.includes("remote.origin.url")
        ? "git@github.com:acme/app.git\n"
        : "/projects/app\n",
      createId: () => "not-used",
    })).resolves.toBe("repo:github.com/acme/app");
  });

  it("uses an AgentRecall UUID for an ordinary directory", async () => {
    await expect(resolveDirectoryIdentity("/notes", {
      runGit: async () => {
        throw new Error("not a git repository");
      },
      createId: () => "stable-uuid",
    })).resolves.toBe("directory:stable-uuid");
  });
});

describe("OpenVikingWorkspaceCredentialStore", () => {
  it("persists workspace keys in an app-owned mode-0600 file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-keys-"));
    tempRoots.push(root);
    await mkdir(root, { recursive: true });
    const credentials = new OpenVikingWorkspaceCredentialStore(root);
    const auth = {
      accountId: "agent-recall-v2",
      userId: "workspace_abcd",
      apiKey: "secret-key",
    };

    await credentials.set("workspace-1", auth);
    await expect(new OpenVikingWorkspaceCredentialStore(root).get("workspace-1")).resolves.toEqual(auth);
    expect(await readFile(path.join(root, "workspace-credentials.json"), "utf8")).toContain("secret-key");

    await credentials.delete("workspace-1");
    await expect(credentials.get("workspace-1")).resolves.toBeNull();
  });
});
