import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OPENVIKING_ACCOUNT_ID,
  type OpenVikingWorkspace,
} from "../../core/openviking-memory";
import type { OpenVikingMemoryControl } from "../../core/openviking-memory-control";
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
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  };
}

function harness(options: {
  initialWorkspaces?: OpenVikingWorkspace[];
  credentials?: Record<string, OpenVikingWorkspaceAuth>;
  addError?: Error;
} = {}) {
  const workspaces = [...(options.initialWorkspaces ?? [])];
  const storedCredentials = new Map(Object.entries(options.credentials ?? {}));
  const controls = new Map<string, OpenVikingMemoryControl>();
  const controlKey = (workspaceId: string, uri: string) => `${workspaceId}\0${uri}`;
  const store: OpenVikingMemoryStorePort = {
    listOpenVikingWorkspaces: vi.fn(async () => [...workspaces]),
    getOpenVikingWorkspace: vi.fn(async (id) => workspaces.find((item) => item.id === id) ?? null),
    findOpenVikingWorkspaceByRootPath: vi.fn(async (rootPath) =>
      workspaces.find((item) => item.rootPath === rootPath) ?? null),
    findOpenVikingWorkspaceByIdentity: vi.fn(async (identity) =>
      workspaces.find((item) => item.identity === identity) ?? null),
    addOpenVikingWorkspace: vi.fn(async (input) => {
      if (options.addError) throw options.addError;
      const added = workspace({
        id: input.id,
        userId: input.userId,
        rootPath: input.rootPath,
        identity: input.identity,
        displayName: input.displayName,
      });
      workspaces.push(added);
      return added;
    }),
    relinkOpenVikingWorkspace: vi.fn(async (id, rootPath, displayName) => {
      const current = workspaces.find((item) => item.id === id);
      if (!current) throw new Error("missing workspace");
      Object.assign(current, { rootPath, displayName });
      return { ...current };
    }),
    setOpenVikingWorkspaceManaged: vi.fn(async (id, managed) => {
      const current = workspaces.find((item) => item.id === id);
      if (!current) throw new Error("missing workspace");
      current.managed = managed;
      return { ...current };
    }),
    deleteOpenVikingWorkspace: vi.fn(async (id) => {
      const index = workspaces.findIndex((item) => item.id === id);
      if (index < 0) return false;
      workspaces.splice(index, 1);
      return true;
    }),
    listOpenVikingMemoryControls: vi.fn(async (workspaceId) => [...controls.values()]
      .filter((control) => control.workspaceId === workspaceId)),
    getOpenVikingMemoryControl: vi.fn(async (workspaceId, uri) =>
      controls.get(controlKey(workspaceId, uri)) ?? null),
    saveOpenVikingUserMemory: vi.fn(async (input) => {
      const now = "2026-08-05T00:00:00.000Z";
      const control: OpenVikingMemoryControl = {
        workspaceId: input.workspaceId,
        uri: input.uri,
        memoryType: input.uri.split("/").at(-2) ?? "other",
        authority: "user",
        lifecycle: "active",
        locked: true,
        evidenceStatus: "verified",
        source: input.source,
        title: input.title,
        lockedContent: input.content,
        evidenceCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      controls.set(controlKey(input.workspaceId, input.uri), control);
      return control;
    }),
    markOpenVikingMemoryDeleted: vi.fn(async (workspaceId, uri) => {
      const existing = controls.get(controlKey(workspaceId, uri));
      if (existing) controls.set(controlKey(workspaceId, uri), {
        ...existing,
        lifecycle: "deleted",
        evidenceStatus: "invalid",
        locked: false,
      });
    }),
    listOpenVikingMemoryEvidence: vi.fn(async () => []),
    listOpenVikingMemoryFeedback: vi.fn(async () => []),
    recordOpenVikingMemoryFeedback: vi.fn(async (input) => {
      const key = controlKey(input.workspaceId, input.memoryUri);
      const existing = controls.get(key) ?? {
        workspaceId: input.workspaceId,
        uri: input.memoryUri,
        memoryType: "events",
        authority: "model" as const,
        lifecycle: "active" as const,
        locked: false,
        evidenceStatus: "legacy" as const,
        source: "legacy" as const,
        evidenceCount: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      const next: OpenVikingMemoryControl = {
        ...existing,
        lifecycle: input.feedback === "helpful" ? "active" : input.feedback === "wrong" ? "invalidated" : "superseded",
        evidenceStatus: input.feedback === "helpful" ? existing.evidenceStatus : "invalid",
        updatedAt: input.createdAt,
      };
      controls.set(key, next);
      return next;
    }),
    recordOpenVikingOperationEvent: vi.fn(async () => undefined),
  };
  const auth: OpenVikingWorkspaceAuth = {
    accountId: OPENVIKING_ACCOUNT_ID,
    userId: "workspace_abcd",
    apiKey: "workspace-key",
  };
  const client = {
    health: vi.fn(async () => undefined),
    ensureWorkspaceUser: vi.fn(async ({ accountId, userId }) => ({
      accountId,
      userId,
      apiKey: "workspace-key",
    })),
    deleteWorkspaceUser: vi.fn(async () => undefined),
    appendMessages: vi.fn(async () => undefined),
    commitSession: vi.fn(async () => ({ taskId: "task-1" })),
    getTask: vi.fn(async () => null),
    searchMemories: vi.fn(async () => [{
      id: "viking://user/memories/events/note.md",
      workspaceId: "",
      title: "Note",
      content: "remembered",
    }]),
    readMemory: vi.fn(async () => "remembered"),
    readSessionArtifact: vi.fn(async () => "{}"),
    saveMemory: vi.fn(async (_workspaceAuth, input) => ({
      id: input.uri ?? "viking://user/memories/manual/note.md",
      workspaceId: "",
      title: input.title,
      content: input.content,
    })),
    writeMemoryContent: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
  } satisfies OpenVikingClientPort;
  const credentials = {
    get: vi.fn(async (workspaceId: string) => storedCredentials.get(workspaceId) ?? null),
    set: vi.fn(async (workspaceId: string, value: OpenVikingWorkspaceAuth) => {
      storedCredentials.set(workspaceId, value);
    }),
    delete: vi.fn(async (workspaceId: string) => {
      storedCredentials.delete(workspaceId);
    }),
  };
  const service = new OpenVikingMemoryService({
    store,
    client,
    credentials,
    inspectDirectory: async (rootPath) => rootPath,
    resolveIdentity: async () => "repo:github.com/acme/app",
    createId: () => "workspace-created",
  });
  return { service, store, client, credentials, workspaces, auth, controls };
}

describe("OpenVikingMemoryService", () => {
  it("previews and adds a directory without scanning or importing historical sessions", async () => {
    const h = harness();

    await expect(h.service.previewDirectory("/projects/app")).resolves.toEqual({
      rootPath: "/projects/app",
      displayName: "app",
      identity: "repo:github.com/acme/app",
      existingWorkspaceId: null,
      relinkWorkspaceId: null,
    });
    await expect(h.service.addWorkspace("/projects/app")).resolves.toMatchObject({
      id: "workspace-created",
      managed: true,
    });

    expect(h.client.ensureWorkspaceUser).toHaveBeenCalledWith({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: expect.stringMatching(/^workspace_[a-f0-9]{24}$/),
    });
    expect(h.store.addOpenVikingWorkspace).toHaveBeenCalledOnce();
    expect(h.client.appendMessages).not.toHaveBeenCalled();
    expect(h.client.commitSession).not.toHaveBeenCalled();
  });

  it("rejects a directory that is already being tracked", async () => {
    const h = harness({ initialWorkspaces: [workspace()] });

    await expect(h.service.addWorkspace("/projects/app")).rejects.toThrow("already managed");
    expect(h.client.ensureWorkspaceUser).not.toHaveBeenCalled();
  });

  it("serializes concurrent adds so a duplicate cannot delete the winning workspace user", async () => {
    const h = harness();
    const originalAdd = vi.mocked(h.store.addOpenVikingWorkspace).getMockImplementation();
    let finishAdd: () => void = () => undefined;
    vi.mocked(h.store.addOpenVikingWorkspace).mockImplementation(async (input) => {
      await new Promise<void>((resolve) => {
        finishAdd = resolve;
      });
      return originalAdd!(input);
    });

    const first = h.service.addWorkspace("/projects/app");
    await vi.waitFor(() => expect(h.store.addOpenVikingWorkspace).toHaveBeenCalledOnce());
    const duplicate = h.service.addWorkspace("/projects/app");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.client.ensureWorkspaceUser).toHaveBeenCalledOnce();
    finishAdd();
    await first;
    await expect(duplicate).rejects.toThrow("already managed");
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();
  });

  it("relinks a moved Git directory without creating a second OpenViking user", async () => {
    const retained = workspace({ rootPath: "/projects/old", managed: false });
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: {
        accountId: OPENVIKING_ACCOUNT_ID,
        userId: retained.userId,
        apiKey: "retained-key",
      } },
    });

    await expect(h.service.addWorkspace("/projects/new")).resolves.toMatchObject({
      id: retained.id,
      rootPath: "/projects/new",
      managed: true,
    });

    expect(h.store.relinkOpenVikingWorkspace).toHaveBeenCalledWith(
      retained.id,
      "/projects/new",
      "new",
    );
    expect(h.client.ensureWorkspaceUser).not.toHaveBeenCalled();
  });

  it("resumes tracking for a retained directory and repairs missing credentials", async () => {
    const retained = workspace({ managed: false });
    const h = harness({ initialWorkspaces: [retained] });

    await expect(h.service.addWorkspace(retained.rootPath)).resolves.toMatchObject({
      id: retained.id,
      managed: true,
    });

    expect(h.client.ensureWorkspaceUser).toHaveBeenCalledWith({
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: retained.userId,
    });
    expect(h.credentials.set).toHaveBeenCalledWith(retained.id, expect.objectContaining({
      userId: retained.userId,
    }));
  });

  it("cleans up the OpenViking user when local workspace persistence fails", async () => {
    const h = harness({ addError: new Error("database unavailable") });

    await expect(h.service.addWorkspace("/projects/app")).rejects.toThrow("database unavailable");

    expect(h.client.deleteWorkspaceUser).toHaveBeenCalledOnce();
    expect(h.credentials.delete).toHaveBeenCalledWith("workspace-created");
  });

  it("searches, reads, saves and deletes memory within the selected directory identity", async () => {
    const retained = workspace();
    const workspaceAuth = {
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: retained.userId,
      apiKey: "retained-key",
    };
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: workspaceAuth },
    });

    await expect(h.service.searchMemories(retained.id, "query", 20)).resolves.toEqual([
      expect.objectContaining({ workspaceId: retained.id, title: "Note" }),
    ]);
    await expect(h.service.readMemory(retained.id, "viking://user/memories/events/note.md"))
      .resolves.toBe("remembered");
    await expect(h.service.saveMemory(retained.id, { title: "Manual", content: "content" }))
      .resolves.toMatchObject({ workspaceId: retained.id, title: "Manual" });
    await h.service.deleteMemory(retained.id, "viking://user/memories/manual/note.md");

    expect(h.client.searchMemories).toHaveBeenCalledWith(workspaceAuth, "query", 20);
    expect(h.store.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "search",
      status: "completed",
      details: expect.objectContaining({
        source: "memory-page",
        userQuery: "query",
        contextualQuery: "query",
        searchedScopes: [retained.id],
        searchedTypes: ["events"],
        targetUri: "viking://user/memories",
        limit: 20,
        candidateCount: 1,
        returnedCount: 1,
      }),
    }));
    expect(h.client.deleteMemory).toHaveBeenCalledWith(
      workspaceAuth,
      "viking://user/memories/manual/note.md",
    );
  });

  it("reads a historical commit diff and returns its concrete memory changes", async () => {
    const retained = workspace();
    const workspaceAuth = {
      accountId: OPENVIKING_ACCOUNT_ID,
      userId: retained.userId,
      apiKey: "retained-key",
    };
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: workspaceAuth },
    });
    h.client.readSessionArtifact.mockResolvedValue(JSON.stringify({
      operations: {
        adds: [{
          uri: "viking://user/memories/preferences/editor.md",
          memory_type: "preferences",
          after: "Prefer concise diffs.",
        }],
        updates: [{
          uri: "viking://user/memories/events/release.md",
          before: "Release weekly.",
          after: "Release daily.",
        }],
        deletes: [],
      },
    }));
    const uri = `viking://user/${retained.userId}/sessions/session-1/history/archive-1/memory_diff.json`;

    await expect(h.service.readCommitChanges(retained.id, uri)).resolves.toEqual([{
      kind: "add",
      uri: "viking://user/memories/preferences/editor.md",
      memoryType: "preferences",
      after: "Prefer concise diffs.",
    }, {
      kind: "update",
      uri: "viking://user/memories/events/release.md",
      memoryType: "events",
      before: "Release weekly.",
      after: "Release daily.",
    }]);
    expect(h.client.readSessionArtifact).toHaveBeenCalledWith(workspaceAuth, uri);
  });

  it("turns every user edit into a locked authoritative version and reads it before OpenViking", async () => {
    const retained = workspace();
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: {
        accountId: OPENVIKING_ACCOUNT_ID,
        userId: retained.userId,
        apiKey: "retained-key",
      } },
    });
    const canonicalUri = "viking://user/memories/preferences/editor.md";
    const uri = `viking://user/${retained.userId}/memories/preferences/editor.md`;

    await expect(h.service.saveMemory(retained.id, {
      uri,
      title: "Editor",
      content: "Prefer concise diffs.",
    })).resolves.toMatchObject({
      authority: "user",
      locked: true,
      evidenceStatus: "verified",
    });
    h.client.searchMemories.mockResolvedValue([{
      id: canonicalUri,
      workspaceId: "",
      title: "generated filename",
      content: "model-generated replacement",
    }]);
    await expect(h.service.searchMemories(retained.id, "editor")).resolves.toEqual([
      expect.objectContaining({
        id: canonicalUri,
        title: "Editor",
        content: "Prefer concise diffs.",
        authority: "user",
        locked: true,
      }),
    ]);
    await expect(h.service.readMemory(retained.id, uri)).resolves.toBe("Prefer concise diffs.");

    expect(h.client.readMemory).not.toHaveBeenCalledWith(expect.anything(), canonicalUri);
    expect(h.store.saveOpenVikingUserMemory).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: retained.id,
      uri: canonicalUri,
      source: "user-edit",
    }));
  });

  it("records wrong or outdated feedback so later policy refreshes can stop automatic injection", async () => {
    const retained = workspace();
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: {
        accountId: OPENVIKING_ACCOUNT_ID,
        userId: retained.userId,
        apiKey: "retained-key",
      } },
    });
    const uri = "viking://user/memories/events/old.md";

    await expect(h.service.feedback(
      retained.id,
      uri,
      "wrong",
      "user",
      "contradicted by the repository",
    ))
      .resolves.toMatchObject({
        lifecycle: "invalidated",
        evidenceStatus: "invalid",
      });

    expect(h.store.recordOpenVikingMemoryFeedback).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: retained.id,
      memoryUri: uri,
      feedback: "wrong",
      actor: "user",
      note: "contradicted by the repository",
    }));
    expect(h.store.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "feedback",
      status: "completed",
    }));
  });

  it("stops tracking without deleting data, but purges remote data before local mapping", async () => {
    const retained = workspace();
    const h = harness({
      initialWorkspaces: [retained],
      credentials: { [retained.id]: {
        accountId: OPENVIKING_ACCOUNT_ID,
        userId: retained.userId,
        apiKey: "retained-key",
      } },
    });

    await expect(h.service.stopManaging(retained.id)).resolves.toMatchObject({ managed: false });
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();

    await h.service.deleteWorkspace(retained.id);

    expect(h.client.deleteWorkspaceUser).toHaveBeenCalledOnce();
    expect(h.store.deleteOpenVikingWorkspace).toHaveBeenCalledWith(retained.id);
    expect(h.credentials.delete).toHaveBeenCalledWith(retained.id);
  });

  it("treats deleting an already removed workspace as successful credential cleanup", async () => {
    const h = harness();

    await expect(h.service.deleteWorkspace("missing")).resolves.toBeUndefined();

    expect(h.credentials.delete).toHaveBeenCalledWith("missing");
    expect(h.client.deleteWorkspaceUser).not.toHaveBeenCalled();
  });
});

describe("OpenViking directory identity", () => {
  it("normalizes a Git SSH remote into a move-stable identity", async () => {
    await expect(resolveDirectoryIdentity("/projects/app", {
      runGit: async (_rootPath, args) => args[0] === "config"
        ? "git@github.com:Acme/App.git\n"
        : "",
    })).resolves.toBe("repo:github.com/Acme/App");
  });

  it("normalizes an HTTPS remote without treating its scheme as SCP syntax", async () => {
    await expect(resolveDirectoryIdentity("/projects/app", {
      runGit: async () => "https://GitHub.com/Acme/App.git\n",
    })).resolves.toBe("repo:github.com/Acme/App");
  });

  it("falls back to the first commit when a Git repository has no origin", async () => {
    await expect(resolveDirectoryIdentity("/projects/app", {
      runGit: async (_rootPath, args) => {
        if (args[0] === "config") throw new Error("origin is not configured");
        return "abc123\n";
      },
    })).resolves.toBe("repo-commit:abc123");
  });

  it("keeps a Windows filesystem remote as a path instead of a URL scheme", async () => {
    await expect(resolveDirectoryIdentity("C:\\projects\\app", {
      runGit: async () => "C:\\repos\\App.git\n",
    })).resolves.toBe("repo:C:/repos/App");
  });

  it("uses an AgentRecall UUID for an ordinary directory", async () => {
    await expect(resolveDirectoryIdentity("/notes", {
      runGit: async () => { throw new Error("not a git repository"); },
      createId: () => "directory-id",
    })).resolves.toBe("directory:directory-id");
  });
});

describe("OpenVikingWorkspaceCredentialStore", () => {
  it("persists credentials atomically and serializes overlapping updates", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openviking-credentials-"));
    tempRoots.push(root);
    await mkdir(root, { recursive: true });
    const credentials = new OpenVikingWorkspaceCredentialStore(root);
    const first = { accountId: "agent-recall-v2", userId: "workspace-one", apiKey: "key-one" };
    const second = { accountId: "agent-recall-v2", userId: "workspace-two", apiKey: "key-two" };

    await Promise.all([
      credentials.set("workspace-1", first),
      credentials.set("workspace-2", second),
    ]);
    await credentials.delete("workspace-1");

    const persisted = new OpenVikingWorkspaceCredentialStore(root);
    await expect(persisted.get("workspace-1")).resolves.toBeNull();
    await expect(persisted.get("workspace-2")).resolves.toEqual(second);
    const filePath = path.join(root, "workspace-credentials.json");
    expect(JSON.parse(await readFile(filePath, "utf8")))
      .toEqual({ "workspace-2": second });
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });
});
