import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import {
  WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
  type WorkflowV2DurableEvent,
  type WorkflowV2DurableNodeControlState,
  type WorkflowV2PersistedRunState,
} from "../../../shared/workflow-v2/storage";
import type { WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import { createWorkflowV2NodeCacheFingerprint } from "./workflow-v2-recovery";
import { resolveWorkflowNodeAgent, workflowV2ExecutionEnvironment, workflowV2ReviewerPolicy } from "./workflow-v2-node-policy";
import type { WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";

export class WorkflowV2RunPersistence {
  private eventCount: number;
  private latest: ExecuteWorkflowV2Checkpoint | undefined;
  private previousRunState: ExecuteWorkflowV2Checkpoint["runState"] | undefined;
  private readonly cachedNodeIds = new Set<string>();

  constructor(private readonly input: {
    store: WorkflowV2StorePort | undefined;
    workflow: WorkflowDraftState;
    plan: WorkflowV2Plan;
    runId: string;
    initialEventCount: number;
    initialCheckpoint?: ExecuteWorkflowV2Checkpoint;
    nodeControl: Record<string, WorkflowV2DurableNodeControlState>;
    workDir: string;
    configuredAgentId: string;
    modelId: string;
    configuredAgents: Array<{ id: string; modelId: string }>;
    recoveryOverrides?: ReadonlyMap<string, WorkflowV2RecoveryOverride>;
  }) {
    this.eventCount = input.initialEventCount;
    this.previousRunState = input.initialCheckpoint ? structuredClone(input.initialCheckpoint.runState) : undefined;
  }

  get latestCheckpoint(): ExecuteWorkflowV2Checkpoint | undefined {
    return this.latest ? structuredClone(this.latest) : undefined;
  }

  async appendEvents(events: Array<Omit<WorkflowV2DurableEvent, "sequence" | "workflowId" | "runId">>): Promise<void> {
    if (!this.input.store || events.length === 0) return;
    const sequenced = events.map((event, index): WorkflowV2DurableEvent => ({
      ...event,
      sequence: this.eventCount + index,
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
    }));
    await this.input.store.appendEvents({
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
      events: sequenced,
    });
    this.eventCount += sequenced.length;
  }

  async persistCheckpoint(checkpoint: ExecuteWorkflowV2Checkpoint): Promise<void> {
    this.latest = structuredClone(checkpoint);
    if (!this.input.store) return;
    const transitionEvents = checkpoint.runState.nodeOrder.flatMap((nodeId) => {
      const current = checkpoint.runState.nodes[nodeId];
      const previous = this.previousRunState?.nodes[nodeId];
      if (!current || previous?.status === current.status) return [];
      return [{
        nodeId,
        type: `node_${current.status}`,
        at: Date.now(),
        ...(current.lastError ? { detail: current.lastError } : {}),
      } satisfies Omit<WorkflowV2DurableEvent, "sequence" | "workflowId" | "runId">];
    });
    await this.appendEvents(transitionEvents);
    const persisted: WorkflowV2PersistedRunState = {
      schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
      workflowId: this.input.workflow.workflowId,
      runId: this.input.runId,
      graphVersion: this.input.plan.graphVersion,
      savedAt: Date.now(),
      eventCount: this.eventCount,
      plan: structuredClone(this.input.plan),
      runState: structuredClone(checkpoint.runState),
      workerOutputs: checkpoint.workerOutputs.map((output) => structuredClone(output)),
      nodeControl: structuredClone(this.input.nodeControl),
    };
    await this.input.store.persistRunState(persisted);
    await this.persistCacheEntries(checkpoint);
    this.previousRunState = structuredClone(checkpoint.runState);
  }

  async persistControlState(nodeId: string, type: string, detail?: string): Promise<void> {
    if (!this.latest || !this.input.store) return;
    await this.appendEvents([{ nodeId, type, at: Date.now(), ...(detail ? { detail } : {}) }]);
    await this.persistCheckpoint(this.latest);
  }

  private async persistCacheEntries(checkpoint: ExecuteWorkflowV2Checkpoint): Promise<void> {
    if (!this.input.store?.persistCacheEntry) return;
    const outputByNodeId = new Map(checkpoint.workerOutputs.map((output) => [output.nodeId, output]));
    for (const output of checkpoint.workerOutputs) {
      if (this.cachedNodeIds.has(output.nodeId)) continue;
      const node = this.input.plan.definition.nodes.find((item) => item.id === output.nodeId);
      const planNode = this.input.plan.nodes.find((item) => item.nodeId === output.nodeId);
      if (!node || !planNode || checkpoint.runState.nodes[output.nodeId]?.status !== "completed") continue;
      const recoveryOverride = this.input.recoveryOverrides?.get(output.nodeId);
      const effectivePlanNode = recoveryOverride?.modelProfile ? { ...planNode, modelProfile: recoveryOverride.modelProfile } : planNode;
      const upstreamOutputs = this.input.plan.definition.edges
        .filter((edge) => edge.toNodeId === output.nodeId)
        .map((edge) => outputByNodeId.get(edge.fromNodeId))
        .filter((item): item is WorkflowV2WorkerOutput => Boolean(item));
      const agentRoute = node.execModel === "llm"
        ? resolveWorkflowNodeAgent(node, { configuredAgentId: this.input.configuredAgentId, modelId: this.input.modelId }, this.input.configuredAgents)
        : { configuredAgentId: this.input.configuredAgentId, modelId: this.input.modelId };
      await this.input.store.persistCacheEntry({
        schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
        workflowId: this.input.workflow.workflowId,
        nodeId: output.nodeId,
        graphVersion: this.input.plan.graphVersion,
        fingerprint: createWorkflowV2NodeCacheFingerprint({
          graphVersion: this.input.plan.graphVersion,
          node,
          planNode: effectivePlanNode,
          upstreamOutputs,
          executionEnvironment: workflowV2ExecutionEnvironment({
            node,
            workDir: this.input.workDir,
            configuredAgentId: agentRoute.configuredAgentId,
            modelId: agentRoute.modelId,
          }),
          reviewerPolicy: workflowV2ReviewerPolicy(node, recoveryOverride?.forceIndependentReview === true),
        }),
        output: structuredClone(output),
        savedAt: Date.now(),
        ...(checkpoint.runState.nodes[output.nodeId]?.reviewVerdict
          ? { reviewVerdict: structuredClone(checkpoint.runState.nodes[output.nodeId]!.reviewVerdict!) }
          : {}),
      });
      this.cachedNodeIds.add(output.nodeId);
    }
  }
}
