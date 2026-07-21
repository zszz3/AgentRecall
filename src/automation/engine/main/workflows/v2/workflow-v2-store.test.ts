import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { WORKFLOW_V2_STORAGE_SCHEMA_VERSION, type WorkflowV2PersistedRunState } from "../../../shared/workflow-v2/storage";
import { buildWorkflowV2Plan } from "./workflow-v2-planner";
import { WorkflowV2FileStore } from "./workflow-v2-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function persistedState(): Promise<WorkflowV2PersistedRunState> {
  const definition = {
    workflowId: "workflow-1",
    graphVersion: 1,
    objective: "Persist the run",
    nodes: [{
      id: "node-1",
      kind: "worker",
      title: "Worker",
      execModel: "llm" as const,
      executionMode: "one-shot" as const,
      prompt: "Work",
      outputFields: [{ key: "result", required: true }],
    }],
    edges: [],
  };
  const plan = await buildWorkflowV2Plan({ definition, approvedBy: "tester", now: 1_000 });
  return {
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: definition.workflowId,
    runId: "run-1",
    graphVersion: definition.graphVersion,
    savedAt: 2_000,
    eventCount: 0,
    plan,
    runState: createWorkflowV2RunState({ definition }),
    workerOutputs: [],
    nodeControl: { "node-1": { extensionCount: 0 } },
  };
}

describe("workflow-v2 file store", () => {
  test("atomically writes and reloads authoritative run state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-store-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.nodeControl["node-1"]!.interventionResolution = {
      action: "continue",
      reason: "Approved by the operator.",
      resolvedAt: 1_900,
    };

    await store.persistRunState(state);

    expect(await store.readRunState("workflow-1", "run-1")).toEqual(state);
    expect(state.runState.maxParallelNodes).toBe(Number.MAX_SAFE_INTEGER);
    const layout = store.layout("workflow-1", "run-1");
    expect((await readdir(layout.runDir)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("serializes concurrent event appends in sequence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-events-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);

    await Promise.all([
      store.appendEvents({
        workflowId: "workflow-1",
        runId: "run-1",
        events: [{ sequence: 0, workflowId: "workflow-1", runId: "run-1", type: "started", at: 1 }],
      }),
      store.appendEvents({
        workflowId: "workflow-1",
        runId: "run-1",
        events: [{ sequence: 1, workflowId: "workflow-1", runId: "run-1", type: "paused", at: 2 }],
      }),
    ]);

    expect(await store.readEvents("workflow-1", "run-1")).toEqual([
      { sequence: 0, workflowId: "workflow-1", runId: "run-1", type: "started", at: 1 },
      { sequence: 1, workflowId: "workflow-1", runId: "run-1", type: "paused", at: 2 },
    ]);
  });

  test("rejects traversal identifiers before touching the filesystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-safe-path-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    expect(() => store.layout("../escape", "run-1")).toThrow("safe path segment");
    expect(() => store.layout("workflow-1", "../../escape")).toThrow("safe path segment");
  });

  test("fails closed on malformed state JSON", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-invalid-state-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const layout = store.layout("workflow-1", "run-1");
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.runStatePath, "{broken", "utf8");

    await expect(store.readRunState("workflow-1", "run-1")).rejects.toThrow("not valid JSON");
  });

  test("rejects non-finite durable numbers instead of silently writing null", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-non-finite-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    const state = await persistedState();
    state.plan.frozenAt = Number.POSITIVE_INFINITY;

    await expect(store.persistRunState(state)).rejects.toThrow("malformed");
  });

  test("writes cache entries outside run control state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-cache-"));
    temporaryDirectories.push(root);
    const store = new WorkflowV2FileStore(root);
    await store.persistCacheEntry({
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: "workflow-1",
      nodeId: "node-1",
      graphVersion: 1,
      fingerprint: {
        graphVersion: 1,
        nodeDefinitionHash: "node",
        upstreamOutputHash: "upstream",
        modelProfile: "fast",
      },
      output: { nodeId: "node-1", summary: "done", outputs: { result: true }, proposals: [] },
      savedAt: 3_000,
    });

    const cachePath = path.join(root, "workflows", "workflow-1", "cache", "graph-1", "node-1.json");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ nodeId: "node-1", graphVersion: 1 });
    expect(await store.readCacheEntry("workflow-1", 1, "node-1")).toMatchObject({
      nodeId: "node-1",
      graphVersion: 1,
      output: { nodeId: "node-1" },
    });
  });
});
