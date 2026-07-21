import type {
  AnswerWorkflowGateRequest,
  PauseWorkflowNodeRequest,
  ResolveWorkflowV2InterventionRequest,
  RunWorkflowRequest,
  StartWorkflowNodeRequest,
  StopWorkflowRunRequest,
  SubmitWorkflowScriptInputRequest,
  WorkflowOperationResult,
} from "../../shared/workflow/commands";
import type { WorkflowV2InterventionAction } from "../../shared/workflow-v2/review";
import type { RuntimeConversation } from "../../shared/runtime/conversation";
import type { WorkflowDraftState } from "../../shared/workflow/draft";
import { isWorkflowRunTerminalStatus, type WorkflowRunState } from "../../shared/workflow/run";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import type { WorkflowV2Plan } from "../../shared/workflow-v2/planning";
import path from "node:path";
import { workflowStoragePlanDocument, workflowStoragePlanFor } from "../../shared/workflow-v2/runtime-utils";
import { WorkflowRunRegistry, type ActiveWorkflowRun } from "./workflow-run-registry";
import { WorkflowV2RunExecutor } from "./v2/workflow-v2-run-executor";
import type { WorkflowV2RecoveryOverride } from "./v2/workflow-v2-execution-contract";
import type {
  ExecuteWorkflowV2ScriptRequest,
  WorkflowRuntimeDependencies,
  WorkflowRunStateUpdate,
  WorkflowV2StorePort,
} from "./workflow-runtime-ports";
export type {
  ExecuteWorkflowV2ScriptRequest,
  WorkflowRunStateUpdate,
  WorkflowV2StorePort,
} from "./workflow-runtime-ports";
import { isWorkflowV2InterventionAction } from "../../shared/workflow-v2/review";
import { startWorkflowRun } from "./workflow-run-starter";
import { resolveWorkflowV2ScriptInput } from "./v2/workflow-v2-script-input";
import {
  configuredAgentModelId,
  resolveWorkflowNodeAgent,
  workflowV2ExecutionEnvironment,
  workflowV2InterventionResolutionReason,
  workflowV2LlmNodePrompt,
  workflowV2ReviewerPolicy,
} from "./v2/workflow-v2-node-policy";
export {
  resolveWorkflowNodeAgent,
  workflowV2LlmNodePrompt,
  type WorkflowV2LlmNodeMessages,
} from "./v2/workflow-v2-node-policy";
export { parseWorkflowV2WorkerArtifact } from "./v2/workflow-v2-output-parser";
import {
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2DurableEvent,
  type WorkflowV2NodeCacheFingerprint,
} from "../../shared/workflow-v2/storage";
import {
  buildWorkflowV2RecoveryPlan,
  createWorkflowV2NodeCacheFingerprint,
  materializeWorkflowV2Recovery,
} from "./v2/workflow-v2-recovery";
import { transitionWorkflowV2NodeState } from "./v2/workflow-v2-scheduler";
import { createWorkflowV2ScriptApprovalOverride, rejectWorkflowV2ScriptApproval, WorkflowV2ScriptApprovalCoordinator } from "./v2/workflow-v2-script-approval";


export class WorkflowRuntime {
  private readonly runRegistry = new WorkflowRunRegistry();
  private readonly runExecutor: WorkflowV2RunExecutor;
  private readonly scriptApprovalCoordinator = new WorkflowV2ScriptApprovalCoordinator();

  constructor(private readonly deps: WorkflowRuntimeDependencies) {
    this.runExecutor = new WorkflowV2RunExecutor(deps, this.runRegistry);
  }

  runWorkflow(input: RunWorkflowRequest): WorkflowOperationResult {
    return startWorkflowRun({ request: input, deps: this.deps, registry: this.runRegistry, executor: this.runExecutor });
  }

  async stopWorkflowRun(input: StopWorkflowRunRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    if (!run) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow run ${input.runId} was not found.` };
    if (isWorkflowRunTerminalStatus(run.status)) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Only an active workflow can be stopped." };

    const activeRun = this.runRegistry.requestStop(input.runId);
    for (const controller of activeRun?.abortControllerByNodeId?.values() ?? []) controller.abort(new Error("Workflow stopped by user."));
    const activeProgress = run.progress.filter((item) => item.status === "running" || item.status === "awaiting_input");
    const activeNodeIds = new Set(activeProgress.map((item) => item.nodeId));
    const taskIds = new Set<string>([
      ...[...(activeRun?.taskIdByNodeId.entries() ?? [])]
        .filter(([nodeId]) => activeNodeIds.has(nodeId))
        .map(([, taskId]) => taskId),
      ...activeProgress.map((item) => item.taskId).filter((taskId): taskId is string => Boolean(taskId)),
    ]);
    await Promise.all([...taskIds].map((taskId) => this.deps.stopTask(taskId).catch(() => undefined)));
    await this.deps.stopWorkflowNodeConversations(input.workflowId, input.runId);
    const progress = run.progress.map((item) => activeNodeIds.has(item.nodeId)
      ? { ...item, status: "paused" as const, detail: "Workflow stopped by user" }
      : item);
    this.deps.finishWorkflowRun({
      workflowId: input.workflowId,
      runId: input.runId,
      status: "stopped",
      progress,
      appendEvents: progress.filter((item) => activeNodeIds.has(item.nodeId)).map((item) => ({ type: "node_paused" as const, nodeId: item.nodeId, at: Date.now(), detail: "Workflow stopped by user" })),
      contextDocument: run.contextDocument,
      ...(run.finalReport ? { finalReport: run.finalReport } : {}),
    });
    this.runRegistry.release(input.runId);
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  isRunning(runId: string): boolean {
    return this.runRegistry.has(runId);
  }

  async pauseWorkflowNode(input: PauseWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!run) return { ok: false, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      return this.pauseWorkflowV2Node({ run, nodeId: input.nodeId });
    }
    if (run.status !== "running") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is not running." };
    const progressItem = run.progress.find((item) => item.nodeId === input.nodeId);
    if (!progressItem) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow node ${input.nodeId} was not found in this run.` };
    if (progressItem.status !== "running") {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow node ${progressItem.title} is not running.` };
    }

    const activeRun = this.runRegistry.get(input.runId) ?? {
      workflowId: input.workflowId,
      runId: input.runId,
      pausedNodeIds: new Set<string>(),
      pausedTaskIds: new Set<string>(),
      gatedNodeIds: new Set<string>(),
      taskIdByNodeId: new Map<string, string>(),
    };
    this.runRegistry.register(activeRun);
    activeRun.pausedNodeIds.add(input.nodeId);

    const taskId = activeRun.taskIdByNodeId.get(input.nodeId) ?? progressItem.taskId;
    if (taskId) activeRun.pausedTaskIds.add(taskId);
    const nextProgress = run.progress.map((item) =>
      item.nodeId === input.nodeId
        ? {
            ...item,
            status: "paused" as const,
            detail: "Paused",
            ...(taskId ? { taskId } : {}),
          }
        : item,
    );
    this.deps.updateWorkflowRunState({
      workflowId: input.workflowId,
      runId: input.runId,
      status: "running",
      progress: nextProgress,
      appendEvents: [{ type: "node_paused", nodeId: input.nodeId, at: Date.now(), ...(taskId ? { taskId } : {}) }],
      contextDocument: run.contextDocument,
      ...(run.finalReport ? { finalReport: run.finalReport } : {}),
    });

    if (taskId) await this.deps.stopTask(taskId);

    // A paused node remains part of the same non-terminal run until the user resumes or stops it.
    const stillRunning = nextProgress.some((item) => item.status === "running");
    if (!stillRunning) {
      this.deps.updateWorkflowRunState({
        workflowId: input.workflowId,
        runId: input.runId,
        status: "waiting_for_user",
        progress: nextProgress,
        contextDocument: run.contextDocument,
        ...(run.finalReport ? { finalReport: run.finalReport } : {}),
      });
    }
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  private async pauseWorkflowV2Node(input: {
    run: WorkflowRunState;
    nodeId: string;
  }): Promise<WorkflowOperationResult> {
    if (input.run.status !== "running") {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: "Workflow run is not running.",
      };
    }
    const progressItem = input.run.progress.find((item) => item.nodeId === input.nodeId);
    if (!progressItem) {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} was not found in this run.`,
      };
    }
    if (progressItem.status !== "running") {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${progressItem.title} is not running.`,
      };
    }
    const activeRun = this.runRegistry.get(input.run.runId);
    if (!activeRun) {
      return {
        ok: false,
        workflowId: input.run.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 run is not active in this process.",
      };
    }

    const reason = "Paused by user through the unified Workflow V2 intervention boundary.";
    activeRun.manualPauseReasonByNodeId ??= new Map();
    activeRun.manualPauseReasonByNodeId.set(input.nodeId, reason);
    const taskId = activeRun.taskIdByNodeId.get(input.nodeId) ?? progressItem.taskId;
    const nextProgress = input.run.progress.map((item) => item.nodeId === input.nodeId
      ? { ...item, status: "paused" as const, detail: "Paused by user", ...(taskId ? { taskId } : {}) }
      : item);
    const stillRunning = nextProgress.some((item) => item.status === "running");
    const update = {
      workflowId: input.run.workflowId,
      runId: input.run.runId,
      progress: nextProgress,
      contextDocument: input.run.contextDocument,
      appendEvents: [{ type: "node_paused" as const, nodeId: input.nodeId, at: Date.now(), detail: reason, ...(taskId ? { taskId } : {}) }],
      ...(input.run.finalReport ? { finalReport: input.run.finalReport } : {}),
    };
    this.deps.updateWorkflowRunState({ ...update, status: stillRunning ? "running" : "waiting_for_user" });
    if (taskId) await this.deps.stopTask(taskId);
    activeRun.abortControllerByNodeId?.get(input.nodeId)?.abort(new Error(reason));
    const store = this.deps.createWorkflowV2Store?.();
    if (store?.readRunState) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await store.readRunState(input.run.workflowId, input.run.runId))?.runState.nodes[input.nodeId]?.status === "paused") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { ok: true, workflowId: input.run.workflowId, runId: input.run.runId };
  }

  async startWorkflowNode(input: StartWorkflowNodeRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      return this.resumeWorkflowV2Node({ workflow, run, nodeId: input.nodeId, action: "continue" });
    }
    return {
      ok: false,
      workflowId: input.workflowId,
      runId: input.runId,
      error: "Workflow V2 plan is required. Legacy workflow execution is no longer supported.",
    };
  }

  async resolveWorkflowV2Intervention(
    input: ResolveWorkflowV2InterventionRequest,
  ): Promise<WorkflowOperationResult> {
    if (!isWorkflowV2InterventionAction(input.action)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 intervention action is invalid." };
    }
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.trim().length > 2_000)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 intervention reason is invalid." };
    }
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (!run.workflowV2Plan) {
      return {
        ok: false,
        workflowId: input.workflowId,
        runId: input.runId,
        error: "Unified intervention actions are available only for Workflow V2 runs.",
      };
    }
    return this.resumeWorkflowV2Node({
      workflow,
      run,
      nodeId: input.nodeId,
      action: input.action,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    });
  }

  async completeInteractiveNode(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    output: WorkflowV2WorkerOutput;
  }): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    const store = this.deps.createWorkflowV2Store?.();
    if (!workflow?.workflowV2Plan || !run || !store?.readRunState) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 interactive run state is unavailable." };
    }
    const persisted = await store.readRunState(input.workflowId, input.runId);
    if (!persisted) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 durable run state was not found." };
    const nodeState = persisted.runState.nodes[input.nodeId];
    if (nodeState?.status !== "paused") {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not awaiting interactive confirmation.` };
    }
    const runState = transitionWorkflowV2NodeState(persisted.runState, { nodeId: input.nodeId, status: "completed", now: Date.now() });
    const workerOutputs = [...persisted.workerOutputs.filter((output) => output.nodeId !== input.nodeId), structuredClone(input.output)];
    const checkpoint = { runState, workerOutputs };
    await store.persistRunState({ ...persisted, runState, workerOutputs });
    this.runRegistry.register({
      workflowId: input.workflowId,
      runId: input.runId,
      pausedNodeIds: new Set(),
      pausedTaskIds: new Set(),
      gatedNodeIds: new Set(),
      taskIdByNodeId: new Map(),
      manualPauseReasonByNodeId: new Map(),
      abortControllerByNodeId: new Map(),
    });
    this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, status: "running", contextDocument: run.contextDocument });
    const storagePlan = workflowStoragePlanFor(input.workflowId, input.runId);
    void this.runExecutor.execute({
      workflow,
      plan: workflow.workflowV2Plan,
      runId: input.runId,
      baseWorkflowContextDocument: run.contextDocument,
      storagePlanDocument: workflowStoragePlanDocument(storagePlan),
      initialCheckpoint: checkpoint,
      initialNodeControl: persisted.nodeControl,
      initialDurableEventCount: persisted.eventCount,
    }).finally(() => this.runRegistry.release(input.runId));
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }

  private async resumeWorkflowV2Node(input: {
    workflow: WorkflowDraftState;
    run: WorkflowRunState;
    nodeId: string;
    action: WorkflowV2InterventionAction;
    reason?: string;
  }): Promise<WorkflowOperationResult> {
    return this.scriptApprovalCoordinator.run({ workflowId: input.workflow.workflowId, runId: input.run.runId, nodeId: input.nodeId, action: input.action }, () => this.resumeWorkflowV2NodeUnlocked(input));
  }

  private async resumeWorkflowV2NodeUnlocked(input: {
    workflow: WorkflowDraftState;
    run: WorkflowRunState;
    nodeId: string;
    action: WorkflowV2InterventionAction;
    reason?: string;
  }): Promise<WorkflowOperationResult> {
    if (input.run.status !== "waiting_for_user" && input.run.status !== "stopped" && input.run.status !== "failed") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow run is not resumable.",
      };
    }
    if (this.runRegistry.has(input.run.runId)) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow run is already active.",
      };
    }
    const store = this.deps.createWorkflowV2Store?.();
    if (!store?.readRunState) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable state is unavailable.",
      };
    }
    const persisted = await store.readRunState(input.workflow.workflowId, input.run.runId);
    if (!persisted) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable run state was not found.",
      };
    }
    if (persisted.workflowId !== input.workflow.workflowId || persisted.runId !== input.run.runId) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: "Workflow V2 durable run state identity does not match the requested run.",
      };
    }
    const plan = input.workflow.workflowV2Plan;
    if (!plan) {
      return { ok: false, workflowId: input.workflow.workflowId, runId: input.run.runId, error: "Workflow V2 plan was not found." };
    }
    const targetNode = plan.definition.nodes.find((node) => node.id === input.nodeId);
    if (!targetNode) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} was not found.`,
      };
    }
    const persistedNode = persisted.runState.nodes[input.nodeId];
    const intervention = persistedNode?.intervention;
    if (input.action !== "continue" && !intervention) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} has no pending human intervention.`,
      };
    }
    if (intervention && !intervention.allowedActions.includes(input.action)) {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 intervention does not allow action ${input.action}.`,
      };
    }
    if ((input.action === "approve_once" || input.action === "reject") && intervention?.source !== "script_permission") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 action ${input.action} requires a pending script permission request.`,
      };
    }
    if ((input.action === "escalate" || input.action === "increase_review_strength") && targetNode.execModel !== "llm") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 action ${input.action} requires an llm node.`,
      };
    }
    const resolvedAt = Date.now();
    const resolutionReason = workflowV2InterventionResolutionReason(input.action, targetNode.title, input.reason);
    const initialNodeControl = structuredClone(persisted.nodeControl);
    initialNodeControl[input.nodeId] = {
      ...(initialNodeControl[input.nodeId] ?? { extensionCount: 0 }),
      interventionResolution: {
        action: input.action,
        reason: resolutionReason,
        resolvedAt,
      },
    };
    const resolutionEvent: WorkflowV2DurableEvent = {
      sequence: persisted.eventCount,
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      nodeId: input.nodeId,
      type: `intervention_${input.action}`,
      at: resolvedAt,
      detail: resolutionReason,
    };
    const initialDurableEventCount = persisted.eventCount + 1;

    if (input.action === "reject") {
      return rejectWorkflowV2ScriptApproval({ deps: this.deps, store, persisted, run: input.run, nodeId: input.nodeId, nodeTitle: targetNode.title, resolvedAt, ...(input.reason ? { reason: input.reason } : {}), nodeControl: initialNodeControl, resolutionEvent, eventCount: initialDurableEventCount });
    }

    if (input.action === "replan") {
      await store.appendEvents({
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        events: [resolutionEvent],
      });
      await store.persistRunState({
        ...structuredClone(persisted),
        savedAt: resolvedAt,
        eventCount: initialDurableEventCount,
        nodeControl: initialNodeControl,
      });
      const progress = input.run.progress.map((item) => item.nodeId === input.nodeId
        ? { ...item, status: "paused" as const, detail: resolutionReason }
        : item);
      this.deps.finishWorkflowRun({
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        status: "stopped",
        progress,
        appendEvents: [{
          type: "node_paused",
          nodeId: input.nodeId,
          at: resolvedAt,
          detail: resolutionReason,
          ...(intervention ? { intervention: structuredClone(intervention) } : {}),
        }],
        contextDocument: input.run.contextDocument,
      });
      return { ok: true, workflowId: input.workflow.workflowId, runId: input.run.runId };
    }

    const snapshot = this.deps.snapshot();
    const workDir = input.workflow.workDir || snapshot.workDir;
    const configuredAgentId = input.workflow.configuredAgentId || snapshot.configuredAgents[0]?.id || "default-agent";
    const modelId = configuredAgentModelId(input.workflow, snapshot);
    const cacheEntries = new Map<string, WorkflowV2CacheEntryMetadata>();
    const targetFingerprints = new Map<string, WorkflowV2NodeCacheFingerprint>();
    const knownOutputs = new Map(persisted.workerOutputs.map((output) => [output.nodeId, output]));

    for (const node of plan.definition.nodes) {
      const planNode = plan.nodes.find((item) => item.nodeId === node.id);
      if (!planNode) {
        return {
          ok: false,
          workflowId: input.workflow.workflowId,
          runId: input.run.runId,
          error: `Workflow V2 plan node ${node.id} was not found.`,
        };
      }
      const cacheEntry = await store.readCacheEntry?.(input.workflow.workflowId, plan.graphVersion, node.id);
      if (cacheEntry) cacheEntries.set(node.id, cacheEntry);
      const upstreamOutputs = plan.definition.edges
        .filter((edge) => edge.toNodeId === node.id)
        .map((edge) => knownOutputs.get(edge.fromNodeId))
        .filter((output): output is WorkflowV2WorkerOutput => Boolean(output));
      const agentRoute = node.execModel === "llm" ? resolveWorkflowNodeAgent(node, { configuredAgentId, modelId }, snapshot.configuredAgents) : { configuredAgentId, modelId };
      const fingerprint = createWorkflowV2NodeCacheFingerprint({
        graphVersion: plan.graphVersion,
        node,
        planNode,
        upstreamOutputs,
        executionEnvironment: workflowV2ExecutionEnvironment({ node, workDir, configuredAgentId: agentRoute.configuredAgentId, modelId: agentRoute.modelId }),
        reviewerPolicy: workflowV2ReviewerPolicy(node),
      });
      targetFingerprints.set(node.id, fingerprint);
      if (cacheEntry) knownOutputs.set(node.id, cacheEntry.output);
    }

    const recovery = buildWorkflowV2RecoveryPlan({
      persisted,
      targetDefinition: plan.definition,
      targetFingerprints,
      cacheEntries,
    });
    const targetDecision = recovery.decisions.find((decision) => decision.nodeId === input.nodeId);
    if (!targetDecision || targetDecision.action === "reuse") {
      return {
        ok: false,
        workflowId: input.workflow.workflowId,
        runId: input.run.runId,
        error: `Workflow V2 node ${input.nodeId} does not require recovery.`,
      };
    }
    await store.appendEvents({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      events: [resolutionEvent],
    });
    const materialized = materializeWorkflowV2Recovery({
      persisted,
      targetDefinition: plan.definition,
      recovery,
    });
    if (input.action === "skip") {
      materialized.checkpoint.runState = transitionWorkflowV2NodeState(materialized.checkpoint.runState, {
        nodeId: input.nodeId,
        status: "skipped",
        now: resolvedAt,
      });
      materialized.checkpoint.workerOutputs.push({
        nodeId: input.nodeId,
        summary: `Skipped by human intervention: ${resolutionReason}`,
        outputs: {},
        risks: [resolutionReason],
        proposals: [],
      });
      materialized.recoveryCheckpoints.delete(input.nodeId);
      materialized.resumeConversations.delete(input.nodeId);
    }
    const recoveryOverrides = new Map<string, WorkflowV2RecoveryOverride>();
    if (input.action === "approve_once") {
      const approval = createWorkflowV2ScriptApprovalOverride({ node: targetNode, planNode: plan.nodes.find((item) => item.nodeId === input.nodeId), intervention, resolutionReason });
      if (!approval.override) return { ok: false, workflowId: input.workflow.workflowId, runId: input.run.runId, error: approval.error ?? "Workflow V2 script approval is invalid." };
      recoveryOverrides.set(input.nodeId, approval.override);
    } else if (input.action === "continue") {
      recoveryOverrides.set(input.nodeId, {
        forceIndependentReview: false,
        instruction: resolutionReason,
        ...(input.reason?.trim() ? { userInput: input.reason.trim() } : {}),
      });
    } else if (input.action === "escalate") {
      recoveryOverrides.set(input.nodeId, {
        modelProfile: "expert",
        forceIndependentReview: true,
        instruction: resolutionReason,
      });
    } else if (input.action === "increase_review_strength") {
      recoveryOverrides.set(input.nodeId, {
        forceIndependentReview: true,
        instruction: resolutionReason,
      });
    }

    this.runRegistry.register({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      pausedNodeIds: new Set(),
      pausedTaskIds: new Set(),
      gatedNodeIds: new Set(),
      taskIdByNodeId: new Map(),
      manualPauseReasonByNodeId: new Map(),
      abortControllerByNodeId: new Map(),
    });
    this.deps.updateWorkflowRunState({
      workflowId: input.workflow.workflowId,
      runId: input.run.runId,
      status: "running",
      contextDocument: input.run.contextDocument,
    });
    const storagePlan = workflowStoragePlanFor(input.workflow.workflowId, input.run.runId);
    void this.runExecutor.execute({
      workflow: input.workflow,
      plan,
      runId: input.run.runId,
      baseWorkflowContextDocument: input.run.contextDocument,
      storagePlanDocument: workflowStoragePlanDocument(storagePlan),
      initialCheckpoint: materialized.checkpoint,
      initialNodeControl,
      initialDurableEventCount,
      recoveryCheckpoints: materialized.recoveryCheckpoints,
      resumeConversations: materialized.resumeConversations,
      recoveryOverrides,
    }).finally(() => {
      this.runRegistry.release(input.run.runId);
    });
    return { ok: true, workflowId: input.workflow.workflowId, runId: input.run.runId };
  }

  async answerWorkflowGate(input: AnswerWorkflowGateRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.runId === input.runId && item.workflowId === input.workflowId);
    if (!workflow) return { ok: false, error: `Workflow ${input.workflowId} was not found.` };
    if (!run) return { ok: false, workflowId: input.workflowId, error: `Workflow run ${input.runId} was not found.` };
    if (run.workflowV2Plan) {
      const answer = input.answer.trim();
      if (!answer) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "A gate answer is required." };
      return this.resolveWorkflowV2Intervention({
        workflowId: input.workflowId,
        runId: input.runId,
        nodeId: input.nodeId,
        action: "continue",
        reason: answer,
      });
    }
    return {
      ok: false,
      workflowId: input.workflowId,
      runId: input.runId,
      error: "Workflow V2 plan is required. Legacy workflow execution is no longer supported.",
    };
  }

  async submitWorkflowScriptInput(input: SubmitWorkflowScriptInputRequest): Promise<WorkflowOperationResult> {
    const snapshot = this.deps.snapshot();
    const workflow = snapshot.workflowStore.workflows.find((item) => item.workflowId === input.workflowId);
    const run = snapshot.workflowStore.runs.find((item) => item.workflowId === input.workflowId && item.runId === input.runId);
    const store = this.deps.createWorkflowV2Store?.();
    if (!workflow?.workflowV2Plan || !run || !store?.readRunState) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 script input state is unavailable." };
    if (run.status !== "waiting_for_user") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is not waiting for script input." };
    if (this.runRegistry.has(input.runId)) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow run is already active." };
    const persisted = await store.readRunState(input.workflowId, input.runId);
    const node = workflow.workflowV2Plan.definition.nodes.find((item) => item.id === input.nodeId);
    const request = persisted?.nodeControl[input.nodeId]?.scriptInput;
    if (!persisted || node?.execModel !== "script" || !request || request.submittedAt !== undefined) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not awaiting script input.` };
    const resolved = resolveWorkflowV2ScriptInput({ parameters: node.script.parameters, workflowContext: { objective: workflow.objective, contextDocument: run.contextDocument }, upstreamOutputs: persisted.workerOutputs, submittedValues: input.values });
    if (!resolved.complete) return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Missing required script inputs: ${resolved.missing.map((item) => item.key).join(", ")}.` };
    const submittedAt = Date.now();
    const nodeControl = structuredClone(persisted.nodeControl);
    nodeControl[input.nodeId] = { ...nodeControl[input.nodeId]!, scriptInput: { ...request, submittedValues: structuredClone(input.values), auditValues: resolved.auditValues, submittedAt } };
    let runState = structuredClone(persisted.runState);
    if (runState.nodes[input.nodeId]?.status !== "paused") return { ok: false, workflowId: input.workflowId, runId: input.runId, error: `Workflow V2 node ${input.nodeId} is not paused for script input.` };
    runState = transitionWorkflowV2NodeState(runState, { nodeId: input.nodeId, status: "ready", now: submittedAt });
    runState = { ...runState, status: "running" };
    await store.persistRunState({ ...persisted, savedAt: submittedAt, runState, nodeControl });
    this.runRegistry.register({ workflowId: input.workflowId, runId: input.runId, pausedNodeIds: new Set(), pausedTaskIds: new Set(), gatedNodeIds: new Set(), taskIdByNodeId: new Map(), manualPauseReasonByNodeId: new Map(), abortControllerByNodeId: new Map() });
    this.deps.updateWorkflowRunState({ workflowId: input.workflowId, runId: input.runId, status: "running", progress: run.progress.map((item) => {
      if (item.nodeId !== input.nodeId) return item;
      const next = { ...item, status: "running" as const, detail: "Script input submitted" };
      delete next.inputRequest;
      return next;
    }), appendEvents: [{ type: "gate_answered", nodeId: input.nodeId, at: submittedAt, answer: JSON.stringify(resolved.auditValues) }], contextDocument: run.contextDocument });
    const storagePlan = workflowStoragePlanFor(input.workflowId, input.runId);
    void this.runExecutor.execute({ workflow, plan: workflow.workflowV2Plan, runId: input.runId, baseWorkflowContextDocument: run.contextDocument, storagePlanDocument: workflowStoragePlanDocument(storagePlan), initialCheckpoint: { runState, workerOutputs: persisted.workerOutputs }, initialNodeControl: nodeControl, initialDurableEventCount: persisted.eventCount }).finally(() => this.runRegistry.release(input.runId));
    return { ok: true, workflowId: input.workflowId, runId: input.runId };
  }


}
