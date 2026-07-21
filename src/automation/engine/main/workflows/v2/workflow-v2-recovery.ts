import { createHash } from "node:crypto";
import type { WorkflowV2Definition, WorkflowV2Node } from "../../../shared/workflow-v2/definition";
import { workflowV2ExplicitUserFacingOutput, type WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type { WorkflowV2PlanNode } from "../../../shared/workflow-v2/planning";
import {
  sameWorkflowV2CacheFingerprint,
  type WorkflowV2CacheEntryMetadata,
  type WorkflowV2NodeCacheFingerprint,
  type WorkflowV2NodeRecoveryDecision,
  type WorkflowV2PersistedRunState,
  type WorkflowV2RecoveryPlan,
} from "../../../shared/workflow-v2/storage";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import type { RuntimeConversation } from "../../../shared/types";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import { transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";

export function createWorkflowV2NodeCacheFingerprint(input: {
  graphVersion: number;
  node: WorkflowV2Node;
  planNode: WorkflowV2PlanNode;
  upstreamOutputs: readonly WorkflowV2WorkerOutput[];
  executionEnvironment: unknown;
  reviewerPolicy?: unknown;
  templateVersion?: string;
}): WorkflowV2NodeCacheFingerprint {
  return {
    graphVersion: input.graphVersion,
    nodeDefinitionHash: hashValue(input.node),
    upstreamOutputHash: hashValue(input.upstreamOutputs),
    modelProfile: input.planNode.modelProfile,
    role: input.planNode.role,
    ...(input.node.execModel === "llm" && input.node.requiredTools
      ? { requiredToolsHash: hashValue([...input.node.requiredTools].sort()) }
      : {}),
    executionEnvHash: hashValue(input.executionEnvironment),
    ...(input.reviewerPolicy !== undefined ? { reviewerPolicyHash: hashValue(input.reviewerPolicy) } : {}),
    ...(input.templateVersion ? { templateVersion: input.templateVersion } : {}),
  };
}

export function buildWorkflowV2RecoveryPlan(input: {
  persisted: WorkflowV2PersistedRunState;
  targetDefinition: WorkflowV2Definition;
  targetFingerprints: ReadonlyMap<string, WorkflowV2NodeCacheFingerprint>;
  cacheEntries: ReadonlyMap<string, WorkflowV2CacheEntryMetadata>;
}): WorkflowV2RecoveryPlan {
  const targetGraphVersion = input.targetDefinition.graphVersion;
  const graphChanged = input.persisted.graphVersion !== targetGraphVersion;
  const outputByNodeId = new Map(input.persisted.workerOutputs.map((output) => [output.nodeId, output]));
  const decisions = new Map<string, WorkflowV2NodeRecoveryDecision>();

  for (const targetNode of input.targetDefinition.nodes) {
    const nodeId = targetNode.id;
    const nodeState = input.persisted.runState.nodes[nodeId];
    const upstreamNodeIds = input.targetDefinition.edges
      .filter((edge) => edge.toNodeId === nodeId)
      .map((edge) => edge.fromNodeId);
    if (upstreamNodeIds.some((upstreamNodeId) => decisions.get(upstreamNodeId)?.action !== "reuse")) {
      decisions.set(nodeId, { nodeId, action: "rerun", reason: "An upstream node is not reusable." });
      continue;
    }

    const targetFingerprint = input.targetFingerprints.get(nodeId);
    const cacheEntry = input.cacheEntries.get(nodeId);
    const cacheReusable = Boolean(
      targetFingerprint
      && cacheEntry
      && cacheEntry.graphVersion === targetGraphVersion
      && sameWorkflowV2CacheFingerprint(cacheEntry.fingerprint, targetFingerprint),
    );
    if (cacheReusable && cacheEntry) {
      decisions.set(nodeId, {
        nodeId,
        action: "reuse",
        reason: "Cache fingerprint matches the target execution contract.",
        cachedOutput: structuredClone(cacheEntry.output),
      });
      continue;
    }

    if (!nodeState) {
      decisions.set(nodeId, { nodeId, action: "rerun", reason: "Node is new or missing from persisted state." });
      continue;
    }

    if (nodeState.status === "completed" && !graphChanged) {
      const output = outputByNodeId.get(nodeId);
      if (output) {
        decisions.set(nodeId, {
          nodeId,
          action: "reuse",
          reason: "Completed output belongs to the same frozen graph version.",
          cachedOutput: structuredClone(output),
        });
      } else {
        decisions.set(nodeId, { nodeId, action: "rerun", reason: "Completed node output is missing." });
      }
      continue;
    }

    const control = input.persisted.nodeControl[nodeId];
    if (!graphChanged && nodeState.status === "paused" && control?.checkpoint) {
      decisions.set(nodeId, {
        nodeId,
        action: "resume",
        reason: "Paused node has a checkpoint under the same graph version.",
        checkpoint: control.checkpoint,
      });
      continue;
    }

    decisions.set(nodeId, {
      nodeId,
      action: "rerun",
      reason: graphChanged
        ? "Graph version changed and no matching cache entry is available."
        : `Persisted node state ${nodeState.status} is not reusable.`,
    });
  }

  return {
    workflowId: input.persisted.workflowId,
    runId: input.persisted.runId,
    persistedGraphVersion: input.persisted.graphVersion,
    targetGraphVersion,
    decisions: input.targetDefinition.nodes.map((node) => decisions.get(node.id)!),
  };
}

export interface WorkflowV2MaterializedRecovery {
  checkpoint: ExecuteWorkflowV2Checkpoint;
  recoveryCheckpoints: Map<string, string>;
  resumeConversations: Map<string, RuntimeConversation>;
}

export function buildWorkflowV2FinalReport(
  plan: WorkflowV2PersistedRunState["plan"],
  workerOutputs: readonly WorkflowV2WorkerOutput[],
  status: "completed" | "failed" | "paused" | "running",
): string {
  const outputByNodeId = new Map(workerOutputs.map((output) => [output.nodeId, output]));
  if (status === "completed") {
    const terminalNodeIds = new Set(plan.definition.nodes.map((node) => node.id));
    for (const edge of plan.definition.edges) terminalNodeIds.delete(edge.fromNodeId);
    for (const node of [...plan.definition.nodes].reverse()) {
      if (!terminalNodeIds.has(node.id)) continue;
      const output = outputByNodeId.get(node.id);
      const userReport = output ? workflowV2ExplicitUserFacingOutput(output) : undefined;
      if (userReport) return userReport;
    }
  }
  return [
    "# Workflow V2 Run Summary",
    "",
    `- Workflow: ${plan.objective}`,
    `- Graph version: ${plan.graphVersion}`,
    `- Status: ${status}`,
    "",
    "## Node outputs",
    ...plan.definition.nodes.map((node) => {
      const output = outputByNodeId.get(node.id);
      if (!output) return `- ${node.title} (${node.id}): no output`;
      const outputKeys = Object.keys(output.outputs).sort();
      return `- ${node.title} (${node.id}): ${output.summary} [outputs: ${outputKeys.join(", ") || "none"}]`;
    }),
  ].join("\n");
}

export function materializeWorkflowV2Recovery(input: {
  persisted: WorkflowV2PersistedRunState;
  targetDefinition: WorkflowV2Definition;
  recovery: WorkflowV2RecoveryPlan;
}): WorkflowV2MaterializedRecovery {
  let runState = createWorkflowV2RunState({
    definition: input.targetDefinition,
    maxParallelNodes: input.persisted.runState.maxParallelNodes,
  });
  const workerOutputs: WorkflowV2WorkerOutput[] = [];
  const recoveryCheckpoints = new Map<string, string>();
  const resumeConversations = new Map<string, RuntimeConversation>();

  for (const decision of input.recovery.decisions) {
    if (decision.action === "reuse") {
      if (!decision.cachedOutput) {
        runState = transitionWorkflowV2NodeState(runState, {
          nodeId: decision.nodeId,
          status: "failed",
          error: "Recovery selected reuse without an output.",
        });
        continue;
      }
      runState = transitionWorkflowV2NodeState(runState, { nodeId: decision.nodeId, status: "running" });
      runState = transitionWorkflowV2NodeState(runState, { nodeId: decision.nodeId, status: "completed" });
      workerOutputs.push(structuredClone(decision.cachedOutput));
      continue;
    }
    if (decision.action === "blocked") {
      runState = transitionWorkflowV2NodeState(runState, {
        nodeId: decision.nodeId,
        status: "failed",
        error: decision.reason,
      });
      continue;
    }
    if (decision.action === "resume" && decision.checkpoint) {
      recoveryCheckpoints.set(decision.nodeId, decision.checkpoint);
      const conversation = input.persisted.runState.nodes[decision.nodeId]?.intervention?.resumeConversation;
      if (conversation && isRuntimeConversation(conversation)) {
        resumeConversations.set(decision.nodeId, structuredClone(conversation));
      }
    }
  }

  return {
    checkpoint: { runState, workerOutputs },
    recoveryCheckpoints,
    resumeConversations,
  };
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("Workflow V2 cache fingerprint input cannot contain non-finite numbers.");
    }
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function isRuntimeConversation(value: {
  runtimeId: string;
  codecVersion: string;
  payload: unknown;
}): value is RuntimeConversation {
  return value.runtimeId === "codex"
    || value.runtimeId === "claude"
    || value.runtimeId === "api"
    || value.runtimeId === "hermes";
}
