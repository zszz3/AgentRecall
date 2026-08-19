import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenVikingHookStateFlusher } from "./openviking-hook-state-flusher";

const roots: string[] = [];
const auth = {
  accountId: "agent-recall-v2",
  userId: "workspace_user",
  apiKey: "workspace-key",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function control() {
  return {
    upsertOpenVikingCommitRun: vi.fn(async (_run: unknown) => undefined),
    applyOpenVikingCommitResult: vi.fn(async (
      _input: unknown,
    ): Promise<Array<{ uri: string; content: string; title?: string }>> => []),
    recordOpenVikingOperationEvent: vi.fn(async (_event: unknown) => undefined),
    recordOpenVikingRecallTrace: vi.fn(async (_trace: unknown) => undefined),
  };
}

function client() {
  return {
    commitSession: vi.fn(async () => ({ taskId: "task-1" })),
    getTask: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    readSessionArtifact: vi.fn(async () => ""),
    writeMemoryContent: vi.fn(async () => undefined),
  };
}

describe("OpenVikingHookStateFlusher", () => {
  it("removes abandoned submitted prompts after their retention window", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-submitted-turns-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "submitted.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      pendingTokenEstimate: 0,
      submittedTurns: [
        {
          sourceTurnId: "stale-turn",
          prompts: ["STALE_PRIVATE_PROMPT"],
          submittedAt: "2026-08-03T00:00:00.000Z",
        },
        {
          sourceTurnId: "active-turn",
          prompts: ["Active prompt"],
          submittedAt: "2026-08-05T00:30:00.000Z",
        },
      ],
      updatedAt: "2026-08-05T00:30:00.000Z",
    }));
    const openViking = client();
    const onStateChanged = vi.fn();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: control(),
      credentials: { get: vi.fn(async () => auth) },
      onStateChanged,
    });

    await flusher.flushIdle(Date.parse("2026-08-05T01:00:00.000Z"));

    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("STALE_PRIVATE_PROMPT");
    expect(JSON.parse(persisted).submittedTurns).toEqual([{
      sourceTurnId: "active-turn",
      prompts: ["Active prompt"],
      submittedAt: "2026-08-05T00:30:00.000Z",
    }]);
    expect(openViking.commitSession).not.toHaveBeenCalled();
    expect(onStateChanged).toHaveBeenCalledOnce();
  });

  it("commits idle pending sessions while leaving active sessions alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-flusher-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const idlePath = path.join(stateDir, "idle.json");
    const activePath = path.join(stateDir, "active.json");
    await writeFile(idlePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-idle",
      agent: "codex",
      pendingTokenEstimate: 120,
      pendingEvidence: [
        { id: "turn-1:version-1", sourceTurnId: "turn-1", inputChars: 200, toolCount: 1 },
        { id: "turn-1:version-2", sourceTurnId: "turn-1", inputChars: 280, toolCount: 2 },
      ],
      updatedAt: "2026-07-30T00:00:00.000Z",
    }));
    await writeFile(activePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-active",
      pendingTokenEstimate: 80,
      updatedAt: "2026-07-30T00:02:30.000Z",
    }));
    const openViking = client();
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      idleMs: 120_000,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-07-30T00:03:00.000Z"));

    expect(openViking.commitSession).toHaveBeenCalledOnce();
    expect(openViking.commitSession).toHaveBeenCalledWith(auth, "session-idle");
    expect(JSON.parse(await readFile(idlePath, "utf8"))).toMatchObject({
      pendingTokenEstimate: 0,
      pendingEvidence: [],
      lastCommittedAt: "2026-07-30T00:03:00.000Z",
      commitTasks: [{
        taskId: "task-1",
        trigger: "idle",
        evidenceIds: ["turn-1:version-1", "turn-1:version-2"],
        sourceTurnIds: ["turn-1"],
        tokenEstimate: 120,
        inputChars: 480,
        toolCount: 3,
      }],
    });
    expect(JSON.parse(await readFile(activePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 80 });
    expect(memoryControl.upsertOpenVikingCommitRun).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1",
      state: "running",
      trigger: "idle",
      sourceTurnIds: ["turn-1"],
    }));
    expect(memoryControl.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "commit",
      details: expect.objectContaining({ inputChars: 480, toolCount: 3 }),
    }));
  });

  it("preserves turns captured while an idle Commit request is in flight", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-concurrent-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "pending.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agent: "codex",
      pendingTokenEstimate: 120,
      pendingEvidence: [{ id: "turn-1", tokenEstimate: 120, inputChars: 480, toolCount: 1 }],
      pendingSince: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.commitSession.mockImplementation(async () => {
      const current = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, JSON.stringify({
        ...current,
        pendingTokenEstimate: 200,
        pendingEvidence: [
          ...current.pendingEvidence,
          { id: "turn-2", tokenEstimate: 80, inputChars: 320, toolCount: 2 },
        ],
        updatedAt: "2026-08-05T00:03:01.000Z",
      }));
      return { taskId: "task-concurrent" };
    });
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      idleMs: 120_000,
      client: openViking,
      control: control(),
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:03:00.000Z"));

    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      pendingTokenEstimate: 80,
      pendingEvidence: [{ id: "turn-2", tokenEstimate: 80 }],
      commitTasks: [{
        taskId: "task-concurrent",
        sourceTurnIds: ["turn-1"],
        tokenEstimate: 120,
      }],
    });
  });

  it("keeps failed idle commits pending and retries them on the next sweep", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-retry-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "pending.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-retry",
      pendingTokenEstimate: 40,
      updatedAt: "2026-07-30T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.commitSession
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValueOnce({ taskId: "task-2" });
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      idleMs: 1,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-07-30T00:01:00.000Z"));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 40 });
    expect(memoryControl.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "commit",
      status: "failed",
    }));

    await flusher.flushIdle(Date.parse("2026-07-30T00:02:00.000Z"));
    expect(openViking.commitSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ pendingTokenEstimate: 0 });
  });

  it("polls completed commits, persists Memory Diff evidence and records pipeline phases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-complete-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "commit.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "agent-recall-synthetic-session",
      sourceSessionId: "session-1",
      agent: "codex",
      pendingTokenEstimate: 0,
      updatedAt: "2026-08-05T00:00:00.000Z",
      commitTasks: [{
        taskId: "task-9",
        trigger: "explicit-remember",
        sourceSessionId: "session-1",
        sourceTurnIds: ["turn-a", "turn-b"],
        tokenEstimate: 320,
        startedAt: "2026-08-05T00:00:00.000Z",
        acceptedAt: "2026-08-05T00:00:01.000Z",
      }],
    }));
    const openViking = client();
    openViking.getTask.mockResolvedValue({
      status: "completed",
      result: {
        archive_uri: "viking://user/workspace_user/sessions/session-1/history/archive_001",
        memory_diff_uri: "viking://user/workspace_user/sessions/session-1/history/archive_001/memory_diff.json",
        memories_extracted: { events: 1 },
        token_usage: { total: 421 },
        stage_timings: {
          summary: {
            started_at: "2026-08-05T00:00:02.000Z",
            completed_at: "2026-08-05T00:00:07.000Z",
            duration_ms: 5_000,
          },
        },
      },
    });
    openViking.readSessionArtifact.mockResolvedValue(JSON.stringify({
      operations: {
        adds: [{
          uri: "viking://user/workspace_user/memories/events/release.md",
          memory_type: "events",
          after: "Release requires one user-facing note.",
        }, {
          uri: "viking://user/memories/../secret.md",
          memory_type: "events",
          after: "Must be rejected.",
        }],
        updates: [],
        deletes: [],
      },
    }));
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
      snapshot: vi.fn(async () => ({
        modelSnapshot: {
          provider: "openai-codex",
          model: "gpt-5.6-terra",
          reasoningEffort: "medium",
        },
        policySnapshot: {
          runtimeVersion: "0.4.11-r4",
          recallTokenBudget: 1_200,
        },
      })),
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:01:00.000Z"));

    expect(memoryControl.applyOpenVikingCommitResult).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({
        taskId: "task-9",
        state: "completed",
        sessionId: "agent-recall-synthetic-session",
        sourceSessionId: "session-1",
        sourceTurnIds: ["turn-a", "turn-b"],
      }),
      changes: [{
        kind: "add",
        uri: "viking://user/memories/events/release.md",
        memoryType: "events",
        after: "Release requires one user-facing note.",
      }],
      memoryDiffUri: "viking://user/workspace_user/sessions/session-1/history/archive_001/memory_diff.json",
      modelSnapshot: expect.objectContaining({ model: "gpt-5.6-terra" }),
      policySnapshot: expect.objectContaining({
        trigger: "explicit-remember",
        runtimeVersion: "0.4.11-r4",
      }),
    }));
    expect(openViking.readSessionArtifact).toHaveBeenCalledWith(
      auth,
      "viking://user/workspace_user/sessions/session-1/history/archive_001/memory_diff.json",
    );
    const phases = memoryControl.recordOpenVikingOperationEvent.mock.calls
      .map(([event]) => (event as { phase: string }).phase);
    expect(phases).toEqual(expect.arrayContaining([
      "summary",
      "long-term-memory",
      "experience",
      "vectorize",
      "verify",
    ]));
    expect(memoryControl.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "summary",
      durationMs: 5_000,
      details: expect.objectContaining({ timingSource: "remote-task" }),
    }));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ commitTasks: [] });
  });

  it("completes a successful Commit even when OpenViking produced no Memory Diff", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-empty-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "commit.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-empty",
      commitTasks: [{
        taskId: "task-empty",
        trigger: "token-threshold",
        sourceTurnIds: ["turn-a"],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:00:00.000Z",
      }],
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.getTask.mockResolvedValue({
      status: "completed",
      result: { memories_extracted: {} },
    });
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:01:00.000Z"));

    expect(memoryControl.applyOpenVikingCommitResult).toHaveBeenCalledWith(expect.objectContaining({
      changes: [],
      run: expect.objectContaining({ taskId: "task-empty", state: "completed" }),
    }));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ commitTasks: [] });
  });

  it("keeps automatic recall blocked after a failed Commit until a later Commit succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-recall-block-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "commit.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      commitTasks: [{
        taskId: "task-failed",
        trigger: "token-threshold",
        sourceTurnIds: ["turn-a"],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:00:00.000Z",
      }],
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.getTask
      .mockResolvedValueOnce({ status: "failed", error: "model unavailable" })
      .mockResolvedValueOnce({ status: "completed", result: { memories_extracted: {} } });
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:01:00.000Z"));

    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      commitTasks: [],
      recallBlockedByTaskId: "task-failed",
    });

    const blocked = JSON.parse(await readFile(statePath, "utf8"));
    blocked.commitTasks = [{
      taskId: "task-success",
      trigger: "explicit-remember",
      sourceTurnIds: ["turn-b"],
      tokenEstimate: 80,
      startedAt: "2026-08-05T00:02:00.000Z",
    }];
    blocked.updatedAt = "2026-08-05T00:02:00.000Z";
    await writeFile(statePath, JSON.stringify(blocked));

    await flusher.flushIdle(Date.parse("2026-08-05T00:03:00.000Z"));

    const recovered = JSON.parse(await readFile(statePath, "utf8"));
    expect(recovered.commitTasks).toEqual([]);
    expect(recovered.recallBlockedByTaskId).toBeUndefined();
  });

  it("marks a completed task failed when its Memory Diff is permanently malformed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-invalid-diff-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    const statePath = path.join(stateDir, "commit.json");
    await writeFile(statePath, JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-invalid-diff",
      commitTasks: [{
        taskId: "task-invalid-diff",
        trigger: "token-threshold",
        sourceTurnIds: ["turn-a"],
        tokenEstimate: 100,
        startedAt: "2026-08-05T00:00:00.000Z",
      }],
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.getTask.mockResolvedValue({
      status: "completed",
      result: {
        memory_diff_uri: "viking://user/workspace_user/sessions/session-1/history/archive_001/memory_diff.json",
      },
    });
    openViking.readSessionArtifact.mockResolvedValue("{not-json");
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:01:00.000Z"));

    expect(memoryControl.applyOpenVikingCommitResult).not.toHaveBeenCalled();
    expect(memoryControl.upsertOpenVikingCommitRun).toHaveBeenLastCalledWith(expect.objectContaining({
      taskId: "task-invalid-diff",
      state: "failed",
      error: expect.stringContaining("Invalid OpenViking Memory Diff"),
    }));
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      commitTasks: [],
      recallBlockedByTaskId: "task-invalid-diff",
    });
  });

  it("restores a user-locked memory after automatic extraction tries to overwrite it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-lock-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    await mkdir(stateDir);
    await writeFile(path.join(stateDir, "commit.json"), JSON.stringify({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      commitTasks: [{
        taskId: "task-lock",
        trigger: "token-threshold",
        sourceTurnIds: ["turn-a"],
        tokenEstimate: 200,
        startedAt: "2026-08-05T00:00:00.000Z",
      }],
      updatedAt: "2026-08-05T00:00:00.000Z",
    }));
    const openViking = client();
    openViking.getTask.mockResolvedValue({
      status: "completed",
      result: {
        memory_diff_uri: "viking://user/workspace_user/sessions/session-1/history/archive_001/memory_diff.json",
      },
    });
    openViking.readSessionArtifact.mockResolvedValue(JSON.stringify({
      operations: {
        adds: [],
        updates: [{
          uri: "memory/user/workspace_user/manual/editor.md",
          memory_type: "manual",
          before: "Use verbose diffs.",
          after: "Use automatic formatting.",
        }],
        deletes: [],
      },
    }));
    const memoryControl = control();
    memoryControl.applyOpenVikingCommitResult.mockResolvedValue([{
      uri: "viking://user/memories/manual/editor.md",
      content: "Prefer concise diffs.",
      title: "Editor policy",
    }]);
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: openViking,
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle(Date.parse("2026-08-05T00:01:00.000Z"));

    expect(openViking.writeMemoryContent).toHaveBeenCalledWith(
      auth,
      "viking://user/memories/manual/editor.md",
      "Prefer concise diffs.",
      "Editor policy",
    );
    expect(memoryControl.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({
      phase: "verify",
      details: expect.objectContaining({ restoredLockedMemories: 1 }),
    }));
  });

  it("imports hook operation events and recall traces before deleting their artifact files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-recall-openviking-artifacts-"));
    roots.push(root);
    const stateDir = path.join(root, "hook-state");
    const eventDir = path.join(stateDir, "operation-events");
    const traceDir = path.join(stateDir, "recall-traces");
    await mkdir(eventDir, { recursive: true });
    await mkdir(traceDir, { recursive: true });
    await writeFile(path.join(eventDir, "event.json"), JSON.stringify({
      id: "event-1",
      workspaceId: "workspace-1",
      phase: "append",
      status: "completed",
      startedAt: "2026-08-05T00:00:00.000Z",
    }));
    await writeFile(path.join(traceDir, "trace.json"), JSON.stringify({
      id: "trace-1",
      workspaceId: "workspace-1",
      agent: "codex",
      query: "release",
      contextualQuery: "release",
      searchedScopes: ["workspace-1"],
      searchedTypes: ["events"],
      candidates: [],
      injectedUris: [],
      injectedTokenCount: 0,
      durationMs: 12,
      createdAt: "2026-08-05T00:00:00.000Z",
    }));
    const memoryControl = control();
    const flusher = new OpenVikingHookStateFlusher({
      stateDir,
      client: client(),
      control: memoryControl,
      credentials: { get: vi.fn(async () => auth) },
    });

    await flusher.flushIdle();

    expect(memoryControl.recordOpenVikingOperationEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "event-1" }));
    expect(memoryControl.recordOpenVikingRecallTrace).toHaveBeenCalledWith(expect.objectContaining({ id: "trace-1" }));
    expect(await readdir(eventDir)).toEqual([]);
    expect(await readdir(traceDir)).toEqual([]);
  });
});
