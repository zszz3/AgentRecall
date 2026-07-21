import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import {
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2NodeCacheFingerprint,
  type WorkflowV2PersistedRunState,
} from "../../../shared/workflow-v2/storage";
import { buildWorkflowV2Plan } from "./workflow-v2-planner";
import { transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";
import {
  buildWorkflowV2FinalReport,
  buildWorkflowV2RecoveryPlan,
  createWorkflowV2NodeCacheFingerprint,
  materializeWorkflowV2Recovery,
} from "./workflow-v2-recovery";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-recovery",
    graphVersion: 1,
    objective: "Recover completed and paused work",
    nodes: [
      { id: "first", kind: "worker", title: "First", execModel: "llm",
        executionMode: "one-shot", prompt: "First", outputFields: [{ key: "value", required: true }] },
      { id: "second", kind: "worker", title: "Second", execModel: "llm",
        executionMode: "one-shot", prompt: "Second", outputFields: [{ key: "value", required: true }] },
    ],
    edges: [{ fromNodeId: "first", toNodeId: "second" }],
  };
}

async function persisted(): Promise<WorkflowV2PersistedRunState> {
  const workflow = definition();
  const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
  let runState = createWorkflowV2RunState({ definition: workflow });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "first", status: "running", now: 1_100 });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "first", status: "completed", now: 1_200 });
  runState = transitionWorkflowV2NodeState(runState, { nodeId: "second", status: "running", now: 1_300 });
  runState = transitionWorkflowV2NodeState(runState, {
    nodeId: "second",
    status: "paused",
    now: 1_400,
    error: "Needs input",
  });
  return {
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: workflow.workflowId,
    runId: "run-1",
    graphVersion: workflow.graphVersion,
    savedAt: 1_500,
    eventCount: 2,
    plan,
    runState,
    workerOutputs: [{ nodeId: "first", summary: "done", outputs: { value: 1 }, proposals: [] }],
    nodeControl: {
      first: { extensionCount: 0 },
      second: { extensionCount: 1, checkpoint: "checkpoint-2", stopReason: "Needs input" },
    },
  };
}

function fingerprint(graphVersion = 1): WorkflowV2NodeCacheFingerprint {
  return {
    graphVersion,
    nodeDefinitionHash: "node",
    upstreamOutputHash: "upstream",
    modelProfile: "fast",
  };
}

describe("workflow-v2 recovery", () => {
  test("uses the terminal node Markdown output as the completed user report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [
      { nodeId: "first", summary: "Prepared", outputs: { value: "context" }, proposals: [] },
      { nodeId: "second", summary: "Answered", outputs: { answer_markdown: "# Final answer\n\nUseful result." }, proposals: [] },
    ], "completed");
    expect(report).toBe("# Final answer\n\nUseful result.");
    expect(report).not.toContain("Node outputs");
  });

  test("uses a terminal script output field as the completed user report", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const report = buildWorkflowV2FinalReport(plan, [
      { nodeId: "first", summary: "Prepared", outputs: { value: "context" }, proposals: [] },
      { nodeId: "second", summary: "Echoed", outputs: { output: "原样内容" }, proposals: [] },
    ], "completed");
    expect(report).toBe("原样内容");
  });

  test("reuses completed work and resumes a checkpoint under the same graph version", async () => {
    const state = await persisted();
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition: definition(),
      targetFingerprints: new Map(),
      cacheEntries: new Map(),
    });

    expect(recovery.decisions).toEqual([
      expect.objectContaining({ nodeId: "first", action: "reuse", cachedOutput: state.workerOutputs[0] }),
      expect.objectContaining({ nodeId: "second", action: "resume", checkpoint: "checkpoint-2" }),
    ]);
  });

  test("reuses changed-graph work only with an exact target fingerprint", async () => {
    const state = await persisted();
    const target = fingerprint(2);
    const targetDefinition = { ...definition(), graphVersion: 2 };
    const cache: WorkflowV2CacheEntryMetadata = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: state.workflowId,
      nodeId: "first",
      graphVersion: 2,
      fingerprint: target,
      output: { nodeId: "first", summary: "cached", outputs: { value: 2 }, proposals: [] },
      savedAt: 2_000,
    };
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map([["first", target]]),
      cacheEntries: new Map([["first", cache]]),
    });

    expect(recovery.decisions[0]).toMatchObject({ nodeId: "first", action: "reuse", cachedOutput: cache.output });
    expect(recovery.decisions[1]).toMatchObject({ nodeId: "second", action: "rerun" });
  });

  test("invalidates a node and its downstream nodes when a fingerprint changes", async () => {
    const state = await persisted();
    const targetDefinition = { ...definition(), graphVersion: 2 };
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map([["first", fingerprint(2)]]),
      cacheEntries: new Map([["first", {
        schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
        workflowId: state.workflowId,
        nodeId: "first",
        graphVersion: 2,
        fingerprint: { ...fingerprint(2), reviewerPolicyHash: "old" },
        output: { nodeId: "first", summary: "stale", outputs: { value: 1 }, proposals: [] },
        savedAt: 2_000,
      }]]),
    });

    expect(recovery.decisions).toEqual([
      expect.objectContaining({ nodeId: "first", action: "rerun" }),
      expect.objectContaining({ nodeId: "second", action: "rerun", reason: "An upstream node is not reusable." }),
    ]);
  });

  test("builds deterministic fingerprints from canonical object key order", async () => {
    const workflow = definition();
    const plan = await buildWorkflowV2Plan({ definition: workflow, approvedBy: "tester", now: 1_000 });
    const node = workflow.nodes[0]!;
    const planNode = plan.nodes[0]!;
    const left = createWorkflowV2NodeCacheFingerprint({
      graphVersion: 1,
      node,
      planNode,
      upstreamOutputs: [],
      executionEnvironment: { b: 2, a: 1 },
    });
    const right = createWorkflowV2NodeCacheFingerprint({
      graphVersion: 1,
      node,
      planNode,
      upstreamOutputs: [],
      executionEnvironment: { a: 1, b: 2 },
    });
    expect(left).toEqual(right);
  });

  test("materializes reusable outputs while leaving checkpoint work runnable", async () => {
    const state = await persisted();
    const targetDefinition = definition();
    const recovery = buildWorkflowV2RecoveryPlan({
      persisted: state,
      targetDefinition,
      targetFingerprints: new Map(),
      cacheEntries: new Map(),
    });

    const materialized = materializeWorkflowV2Recovery({ persisted: state, targetDefinition, recovery });

    expect(materialized.checkpoint.runState.nodes.first?.status).toBe("completed");
    expect(materialized.checkpoint.runState.nodes.second?.status).toBe("ready");
    expect(materialized.checkpoint.workerOutputs).toEqual(state.workerOutputs);
    expect(materialized.recoveryCheckpoints.get("second")).toBe("checkpoint-2");
  });
});
