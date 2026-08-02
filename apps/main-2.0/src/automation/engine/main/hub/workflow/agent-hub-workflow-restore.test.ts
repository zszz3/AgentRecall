import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { WorkflowDraftState, WorkflowRunState } from "../../../shared/types";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import {
  isWorkflowV2PersistedRunState,
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
  type WorkflowV2PersistedRunState,
} from "../../../shared/workflow-v2/storage";
import { buildWorkflowV2Plan } from "../../workflows/v2/workflow-v2-planner";
import { buildWorkflowV2RecoveryPreview } from "../../workflows/v2/workflow-v2-recovery";
import { transitionWorkflowV2NodeState } from "../../workflows/v2/workflow-v2-scheduler";
import { WorkflowV2FileStore } from "../../workflows/v2/workflow-v2-store";
import { AgentHub } from "../agent-hub";
import { createWorkflowV2InlineScriptSpec } from "../../../shared/workflow-v2/definition";
import { reconcileWorkflowV2RunFromDurableState, restoreWorkflowDraft, restoreWorkflowRun, restoreWorkflowStoreCollections } from "./agent-hub-workflow-restore";

const TEST_AGENT_ID = "runtime-agent:codex-openai";

function definition(workflowId = "workflow-recovery"): WorkflowV2Definition {
  return {
    workflowId,
    graphVersion: 2,
    objective: "Recover the durable Workflow V2 projection",
    nodes: [
      {
        id: "draft",
        kind: "implementation",
        title: "Draft",
        execModel: "llm",
        executionMode: "one-shot",
        configuredAgentId: TEST_AGENT_ID,
        prompt: "Draft the change.",
        outputFields: [{ key: "draft", required: true }],
      },
      {
        id: "verify",
        kind: "verification",
        title: "Verify",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "true", timeoutMs: 1_000 }),
        outputFields: [{ key: "verified", required: true }],
      },
    ],
    edges: [{ fromNodeId: "draft", toNodeId: "verify" }],
  };
}

async function fixture(): Promise<{
  workflow: WorkflowDraftState;
  run: WorkflowRunState;
  persisted: WorkflowV2PersistedRunState;
}> {
  const workflowDefinition = definition();
  const plan = await buildWorkflowV2Plan({ definition: workflowDefinition, approvedBy: "restore-test", now: 1_000 });
  const workflow: WorkflowDraftState = {
    workflowId: workflowDefinition.workflowId,
    title: "Recovery workflow",
    status: "running",
    revision: 1,
    configuredAgentId: "agent-a",
    modelId: "model-a",
    reviewerConfiguredAgentId: "agent-a",
    reviewerModelId: "model-a",
    objective: workflowDefinition.objective,
    definition: workflowDefinition,
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "# Run context",
    contextDocument: "# Workflow context",
    workflowV2Plan: plan,
    runIds: ["run-recovery"],
    createdAt: 900,
    updatedAt: 1_000,
  };
  const run: WorkflowRunState = {
    runId: "run-recovery",
    workflowId: workflow.workflowId,
    status: "running",
    workflowV2Plan: plan,
    progress: [{ nodeId: "draft", title: "Draft", status: "running" }],
    events: [],
    contextDocument: "# Run context",
    startedAt: 1_000,
    finishedAt: undefined,
    lastError: undefined,
  };
  const persisted: WorkflowV2PersistedRunState = {
    schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
    workflowId: workflow.workflowId,
    runId: run.runId,
    graphVersion: workflowDefinition.graphVersion,
    savedAt: 1_500,
    eventCount: 2,
    plan,
    runState: createWorkflowV2RunState({ definition: workflowDefinition, maxParallelNodes: 4 }),
    workerOutputs: [],
    nodeControl: { draft: { extensionCount: 0 }, verify: { extensionCount: 0 } },
  };
  return { workflow, run, persisted };
}

describe("Workflow V2 AgentHub durable restore", () => {
  test("compatibly reads legacy runs without inventing transaction evidence", async () => {
    const input = await fixture();
    const restored = restoreWorkflowRun(input.run);

    expect(restored).toBeDefined();
    expect(restored?.transaction).toBeUndefined();
    expect(restored?.operations).toBeUndefined();
    expect(restored?.recovery).toBeUndefined();
    expect(restored?.recoveryDecisions).toBeUndefined();
  });

  test("restores an unfinished planning conversation with an empty DAG", () => {
    const workflowId = "planning-workflow";
    const restored = restoreWorkflowDraft({
      workflowId,
      sourceType: "official",
      topologyLocked: true,
      title: "Untitled workflow",
      status: "draft",
      revision: 4,
      configuredAgentId: "default-agent",
      modelId: "default",
      objective: "Plan a workflow",
      definition: { workflowId, graphVersion: 1, objective: "", nodes: [], edges: [] },
      messages: [
        { id: "message-1", role: "user", content: "Plan a workflow" },
        {
          id: "message-2",
          role: "assistant",
          content: "Waiting for approval",
          events: [{
            id: "approval-1",
            type: "approval_request",
            content: "Allow workflow_create?",
            timestamp: 1,
            requestId: "runtime-approval:1",
            requestState: "live",
          }],
        },
      ],
      reply: "",
      runProgress: [],
      runContextDocument: "",
      contextDocument: "",
      runIds: [],
      createdAt: 1,
      updatedAt: 2,
    }, {
      restoreRuntimeConversation: () => undefined,
      cloneWorkflowDraft: (draft) => structuredClone(draft),
    });

    expect(restored).toMatchObject({
      workflowId,
      sourceType: "official",
      topologyLocked: true,
      status: "draft",
      objective: "Plan a workflow",
    });
    expect(restored?.messages).toHaveLength(2);
    expect(restored?.messages[1]?.events).toEqual([
      expect.objectContaining({
        type: "approval_request",
        requestId: "runtime-approval:1",
        requestState: "expired",
      }),
    ]);
  });

  test("skips one invalid workflow without clearing valid workflow history", () => {
    const valid = {
      workflowId: "valid-workflow",
      title: "Valid",
      status: "draft",
      revision: 1,
      configuredAgentId: "agent",
      modelId: "model",
      objective: "Valid workflow",
      definition: definition("valid-workflow"),
      messages: [], reply: "", runProgress: [], runContextDocument: "", contextDocument: "", runIds: [], createdAt: 1, updatedAt: 2,
    };
    const restored = restoreWorkflowStoreCollections({
      activeWorkflowId: "broken-workflow",
      workflows: [valid, { workflowId: "broken-workflow", definition: { workflowId: "mismatch", graphVersion: 1, objective: "", nodes: [], edges: [] } }],
      runs: [{ runId: "orphan-run", workflowId: "broken-workflow" }],
    }, {
      restoreWorkflowDraft: (raw) => restoreWorkflowDraft(raw, { restoreRuntimeConversation: () => undefined, cloneWorkflowDraft: (draft) => structuredClone(draft) }),
      restoreWorkflowRun: () => undefined,
    });

    expect(restored?.workflows.map((workflow) => workflow.workflowId)).toEqual(["valid-workflow"]);
    expect(restored?.activeWorkflowId).toBe("valid-workflow");
    expect(restored?.runs).toEqual([]);
  });

  test("projects a paused durable run as waiting and resumable without losing completed work", async () => {
    const input = await fixture();
    let state = transitionWorkflowV2NodeState(input.persisted.runState, { nodeId: "draft", status: "running", now: 1_100 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "draft", status: "completed", now: 1_200 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "verify", status: "running", now: 1_300 });
    state = transitionWorkflowV2NodeState(state, {
      nodeId: "verify",
      status: "paused",
      now: 1_400,
      intervention: {
        nodeId: "verify",
        source: "supervision_pause",
        reason: "Checkpoint captured before restart.",
        allowedActions: ["continue", "skip"],
        requestedAt: 1_400,
      },
    });
    input.persisted.runState = state;
    input.persisted.workerOutputs = [{
      nodeId: "draft",
      summary: "Draft persisted",
      outputs: { draft: "const durable = true;" },
      proposals: [],
    }];

    const restored = reconcileWorkflowV2RunFromDurableState({ ...input, updateWorkflowProjection: true });

    expect(restored?.run).toMatchObject({
      status: "waiting_for_user",
      finishedAt: undefined,
      lastError: undefined,
      progress: [
        { nodeId: "draft", status: "completed", detail: "Draft persisted" },
        {
          nodeId: "verify",
          status: "paused",
          detail: "Checkpoint captured before restart.",
          intervention: expect.objectContaining({ allowedActions: ["continue", "skip"] }),
        },
      ],
      events: [expect.objectContaining({ type: "node_paused", nodeId: "verify" })],
    });
    expect(restored?.workflow).toMatchObject({ status: "waiting_for_user", error: undefined });
    expect(restored?.run.finalReport).toBeUndefined();
  });

  test("restores a paused script input request as typed awaiting input", async () => {
    const input = await fixture();
    const textParameter = {
      key: "text",
      label: "Text",
      location: "stdin" as const,
      valueType: "string" as const,
      source: "user" as const,
      required: true,
    };
    const verifyNode = input.persisted.plan.definition.nodes.find((node) => node.id === "verify");
    if (!verifyNode || verifyNode.execModel !== "script") throw new Error("Script fixture node is missing.");
    verifyNode.script.parameters = [textParameter];
    input.persisted.nodeControl.verify = {
      extensionCount: 0,
      scriptInput: {
        requestedParameters: [textParameter],
        submittedValues: {},
        auditValues: {},
        requestedAt: 1_400,
      },
    };
    let state = transitionWorkflowV2NodeState(input.persisted.runState, { nodeId: "draft", status: "running", now: 1_100 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "draft", status: "completed", now: 1_200 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "verify", status: "running", now: 1_300 });
    state = transitionWorkflowV2NodeState(state, {
      nodeId: "verify",
      status: "paused",
      now: 1_400,
      intervention: {
        nodeId: "verify",
        source: "supervision_pause",
        reason: "Script node is waiting for required typed input.",
        allowedActions: ["continue"],
        requestedAt: 1_400,
      },
    });
    input.persisted.runState = state;

    const restored = reconcileWorkflowV2RunFromDurableState({ ...input, updateWorkflowProjection: true });

    expect(restored?.run.progress.find((item) => item.nodeId === "verify")).toMatchObject({
      status: "awaiting_input",
      detail: "Waiting for Text",
      inputRequest: { kind: "script_parameters", parameters: [textParameter] },
    });
    expect(restored?.workflow.runProgress.find((item) => item.nodeId === "verify")?.inputRequest).toEqual({
      kind: "script_parameters",
      parameters: [textParameter],
    });
  });

  test("repairs a missed public completion from the authoritative durable checkpoint", async () => {
    const input = await fixture();
    let state = transitionWorkflowV2NodeState(input.persisted.runState, { nodeId: "draft", status: "running", now: 1_100 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "draft", status: "completed", now: 1_200 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "verify", status: "running", now: 1_300 });
    state = transitionWorkflowV2NodeState(state, { nodeId: "verify", status: "completed", now: 1_400 });
    input.persisted.runState = state;
    input.persisted.workerOutputs = [
      { nodeId: "draft", summary: "Draft persisted", outputs: { draft: "done" }, proposals: [] },
      { nodeId: "verify", summary: "Verification persisted", outputs: { verified: true }, proposals: [] },
    ];
    input.persisted.finalReport = "# Durable final report\n\n- Exact transaction diff retained.";

    const restored = reconcileWorkflowV2RunFromDurableState({ ...input, updateWorkflowProjection: true });

    expect(restored?.run.status).toBe("completed");
    expect(restored?.run.finishedAt).toBe(1_500);
    expect(restored?.run.finalReport).toBe(input.persisted.finalReport);
    expect(restored?.workflow).toMatchObject({ status: "completed", finalReport: input.persisted.finalReport });
  });

  test("rejects durable state that does not belong to the public run", async () => {
    const input = await fixture();
    input.persisted.runId = "another-run";

    expect(reconcileWorkflowV2RunFromDurableState({ ...input, updateWorkflowProjection: true })).toBeUndefined();
  });

  test("reconciles and persists a recoverable durable run during AgentHub startup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "workflow-v2-hub-restore-"));
    const storagePath = path.join(rootDir, "state.json");
    const hub = new AgentHub();
    await hub.loadPersistedState(storagePath);
    const workflowDefinition = definition("startup-recovery-placeholder");
    const workflowId = hub.createWorkflowDraft({ reviewerConfiguredAgentId: TEST_AGENT_ID }).workflowDraft!.workflowId;
    const created = hub.materializeWorkflowDraft(workflowId, {
      title: "Startup recovery",
      objective: "Reconcile durable state",
      definition: workflowDefinition,
    });
    expect(created).toMatchObject({ ok: true, workflowId: expect.any(String) });
    const reviewRoute = hub.snapshot().workflowDraft!;
    hub.patchWorkflowDraft({ workflowId, generationReview: { status: "approved", reviewerConfiguredAgentId: reviewRoute.reviewerConfiguredAgentId, reviewerModelId: reviewRoute.reviewerModelId, reviewedRevision: reviewRoute.revision, result: { verdict: "approve", reviewedRevision: reviewRoute.revision, summary: "Approved for restore test", findings: [], scriptRisks: { verify: { level: "safe", rationale: "No external side effects." } }, suggestions: [] }, updatedAt: 1 } });
    hub.confirmWorkflow({ workflowId, expectedRevision: reviewRoute.revision });
    const createdWorkflow = hub.snapshot().workflowStore.workflows.find((item) => item.workflowId === workflowId)!;
    const frozenDefinition = createdWorkflow.workflowV2Plan!.definition;
    const started = hub.startWorkflowRun({ workflowId });
    expect(started).toMatchObject({ ok: true, runId: expect.any(String) });
    const runId = started.runId!;
    await hub.stopWorkflowRun({ workflowId, runId });
    await hub.shutdown();

    let durableRunState = createWorkflowV2RunState({ definition: frozenDefinition, maxParallelNodes: 4 });
    durableRunState = transitionWorkflowV2NodeState(durableRunState, { nodeId: "draft", status: "running", now: 2_000 });
    durableRunState = transitionWorkflowV2NodeState(durableRunState, { nodeId: "draft", status: "completed", now: 2_100 });
    durableRunState = transitionWorkflowV2NodeState(durableRunState, { nodeId: "verify", status: "running", now: 2_200 });
    durableRunState = transitionWorkflowV2NodeState(durableRunState, {
      nodeId: "verify",
      status: "paused",
      now: 2_300,
      error: "Paused before restart",
    });
    const transaction = {
      transactionId: "transaction-startup-recovery",
      mode: "strict_atomic" as const,
      status: "recovery_required" as const,
      baselineId: "baseline-startup-recovery",
      operationCount: 0,
      unknownOperationCount: 0,
      irreversibleOperationCount: 0,
      startedAt: 2_000,
      updatedAt: 2_400,
      retentionUntil: Date.now() + 604_800_000,
    };
    const durableStore = new WorkflowV2FileStore(rootDir);
    const sourceDir = path.join(rootDir, "governed-source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "restart-change.txt"), "baseline file", "utf8");
    const workspace = await durableStore.prepareWorkspaceTransaction({ workflowId, runId, sourceDir, baselineId: transaction.baselineId, now: 2_000 });
    await writeFile(path.join(workspace.workspaceDir, "restart-change.txt"), "recoverable workflow change", "utf8");
    await writeFile(path.join(sourceDir, "restart-change.txt"), "concurrent user change one", "utf8");
    const workspaceDiff = await durableStore.inspectWorkspaceTransaction({ workflowId, runId });
    const conflictDetails = await durableStore.inspectWorkspaceConflicts({ workflowId, runId, paths: ["restart-change.txt"] });
    const rulesRecovery = buildWorkflowV2RecoveryPreview({
      transaction,
      operations: [],
      runState: durableRunState,
      nodeControl: {
        draft: { extensionCount: 0 },
        verify: { extensionCount: 0, checkpoint: "verify-checkpoint" },
      },
      canRollbackSavepoint: false,
      canRollbackWorkspace: true,
      canCompensate: false,
      compensableOperationIds: [],
      workspaceDiff: { ...workspaceDiff, conflicts: conflictDetails.map((detail) => detail.path) },
      conflictDetails,
      now: 2_400,
    });
    const durableState = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId,
      runId,
      graphVersion: workflowDefinition.graphVersion,
      savedAt: 2_400,
      eventCount: 4,
      plan: createdWorkflow.workflowV2Plan!,
      runState: durableRunState,
      workerOutputs: [{
        nodeId: "draft",
        summary: "Durable draft",
        outputs: { draft: "const durable = true;" },
        proposals: [],
      }],
      nodeControl: {
        draft: { extensionCount: 0 },
        verify: { extensionCount: 0, checkpoint: "verify-checkpoint" },
      },
      transaction,
      recovery: {
        ...rulesRecovery,
        managerRecommendation: {
          ...rulesRecovery.managerRecommendation,
          source: "agent" as const,
          rationale: "The Manager Agent reviewed the durable evidence before restart.",
        },
      },
    } satisfies WorkflowV2PersistedRunState;
    expect(isWorkflowV2PersistedRunState(durableState)).toBe(true);
    await durableStore.persistRunState(durableState);
    expect((await durableStore.readRunState(workflowId, runId))?.recovery?.managerRecommendation.source).toBe("agent");

    const restoredHub = new AgentHub();
    await restoredHub.loadPersistedState(storagePath);
    expect((await durableStore.readRunState(workflowId, runId))?.transaction?.status).toBe("recovery_required");
    const restored = restoredHub.snapshot();
    const restoredRun = restored.workflowStore.runs.find((run) => run.runId === runId);
    const restoredWorkflow = restored.workflowStore.workflows.find((workflow) => workflow.workflowId === workflowId);

    expect(restoredRun).toMatchObject({
      status: "waiting_for_user",
      progress: [
        { nodeId: "draft", status: "completed", detail: "Durable draft" },
        { nodeId: "verify", status: "paused", detail: "Paused before restart" },
      ],
    });
    expect(restoredWorkflow).toMatchObject({ status: "waiting_for_user" });
    const { generatedAt: _restoredGeneratedAt, managerRecommendation: _restoredManagerRecommendation, ...restoredFacts } = restoredRun!.recovery!;
    const { generatedAt: _durableGeneratedAt, managerRecommendation: _durableManagerRecommendation, ...durableFacts } = durableState.recovery;
    expect(restoredFacts).toEqual(durableFacts);
    expect(restoredRun?.recovery?.managerRecommendation).toMatchObject({
      source: "agent",
      rationale: "The Manager Agent reviewed the durable evidence before restart.",
    });
    expect(restoredRun?.recovery?.availableActions).toContain("compensate_all");
    const persistedPublicState = JSON.parse(await readFile(storagePath, "utf8")) as {
      workflowStore: { runs: Array<{ runId: string; status: string }> };
    };
    expect(persistedPublicState.workflowStore.runs.find((run) => run.runId === runId)?.status).toBe("waiting_for_user");
    await restoredHub.shutdown();

    const previousCurrentDigest = restoredRun?.recovery?.conflictDetails[0]?.current.sha256;
    await writeFile(path.join(sourceDir, "restart-change.txt"), "concurrent user change two", "utf8");
    const changedEvidenceHub = new AgentHub();
    await changedEvidenceHub.loadPersistedState(storagePath);
    const changedEvidenceRun = changedEvidenceHub.snapshot().workflowStore.runs.find((run) => run.runId === runId);

    expect(changedEvidenceRun?.recovery?.conflictDetails[0]?.current.sha256).not.toBe(previousCurrentDigest);
    expect(changedEvidenceRun?.recovery?.managerRecommendation.source).toBe("rules");
    expect(changedEvidenceRun?.recovery?.managerRecommendation.rationale).not.toContain("reviewed the durable evidence before restart");
    await changedEvidenceHub.shutdown();

    await writeFile(path.join(sourceDir, "restart-change.txt"), "baseline file", "utf8");
    await writeFile(durableStore.layout(workflowId, runId).operationLogPath, "{ malformed operation ledger", "utf8");
    const malformedLedgerHub = new AgentHub();
    await malformedLedgerHub.loadPersistedState(storagePath);
    const malformedLedgerRun = malformedLedgerHub.snapshot().workflowStore.runs.find((run) => run.runId === runId);

    expect(malformedLedgerRun?.recovery?.conflicts).toEqual([]);
    expect(malformedLedgerRun?.recovery?.blockers).toEqual(expect.arrayContaining([expect.stringContaining("operation ledger is unavailable")]));
    expect(malformedLedgerRun?.recovery?.availableActions).not.toContain("continue");
    await malformedLedgerHub.shutdown();
  });
});
