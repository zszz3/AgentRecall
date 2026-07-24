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
  OpenVikingClientPort,
  OpenVikingWorkspaceAuth,
} from "./openviking-client";
import {
  OpenVikingMemoryService,
  OpenVikingWorkspaceCredentialStore,
  deterministicImportSessionId,
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
    pinned: false,
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
} = {}) {
  const workspaces = [...(options.initialWorkspaces ?? [])];
  const jobs = new Map<string, {
    state: OpenVikingImportState;
    importedTurns: number;
    totalTurns: number;
    cursorSessionKey: string | null;
    lastError: string | null;
  }>();
  const imported = new Set<string>();
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
    updateOpenVikingImportJob: vi.fn(async (workspaceId, update) => {
      jobs.set(workspaceId, update);
      const current = workspaces.find((item) => item.id === workspaceId);
      if (current) Object.assign(current, {
        importState: update.state,
        importedTurns: update.importedTurns,
        totalTurns: update.totalTurns,
        ...(update.lastError ? { lastError: update.lastError } : {}),
      });
      return { workspaceId, updatedAt: "2026-07-24T00:00:00.000Z", ...update };
    }),
    hasOpenVikingImportedTurn: vi.fn(async (workspaceId, sourceTurnId, fingerprint) =>
      imported.has(`${workspaceId}:${sourceTurnId}:${fingerprint}`)),
    recordOpenVikingImportedTurn: vi.fn(async (workspaceId, sourceTurnId, fingerprint) => {
      imported.add(`${workspaceId}:${sourceTurnId}:${fingerprint}`);
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
    sleep: async () => undefined,
  });
  return { service, store, client, credentials, workspaces, jobs, imported, events };
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
      deterministicImportSessionId("workspace-1", "codex:1"),
      [
        expect.objectContaining({ role: "user", content: "question" }),
        expect.objectContaining({ role: "assistant", content: "answer" }),
      ],
    );
    const secondBatch = vi.mocked(client.appendMessages).mock.calls[1][2];
    expect(secondBatch[1].content).toHaveLength(12_000);
    expect(store.recordOpenVikingImportedTurn).toHaveBeenCalledTimes(2);
    expect(client.commitSession).toHaveBeenCalledOnce();

    await service.importWorkspace("workspace-1");
    expect(client.appendMessages).toHaveBeenCalledTimes(2);
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
      state: "completed",
      importedTurns: 1,
    });
  });

  it("stops management without deleting data, but purges remote data before local mapping", async () => {
    const h = harness({ initialWorkspaces: [workspace()] });

    await h.service.stopManaging("workspace-1");
    expect(h.store.setOpenVikingWorkspaceManaged).toHaveBeenCalledWith("workspace-1", false);
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();

    await h.service.deleteWorkspace("workspace-1");
    expect(h.events).toEqual(["remote-delete", "local-delete"]);
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
      accountId: "agent-recall",
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
