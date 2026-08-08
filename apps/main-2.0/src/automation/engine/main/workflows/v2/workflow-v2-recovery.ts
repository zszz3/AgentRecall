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
import { sanitizeWorkflowTransactionValue, type WorkflowConflictPreview, type WorkflowOperationRecord, type WorkflowRecoveryDecisionRecord, type WorkflowRecoveryManagerRecommendation, type WorkflowRecoveryPreview, type WorkflowTransactionState } from "../../../shared/workflow-v2/transaction";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import type { WorkflowWorkspaceDiffResult } from "./workflow-v2-workspace-transaction";
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

    if ((nodeState.status === "completed" || nodeState.status === "completed_with_override") && !graphChanged) {
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

export function acceptedWorkflowV2WorkerOutputs(
  runState: WorkflowV2PersistedRunState["runState"],
  workerOutputs: readonly WorkflowV2WorkerOutput[],
): WorkflowV2WorkerOutput[] {
  return workerOutputs.filter((output) => {
    const status = runState.nodes[output.nodeId]?.status;
    return status === "completed" || status === "completed_with_override" || status === "skipped";
  });
}

export function buildWorkflowV2FinalReport(
  plan: WorkflowV2PersistedRunState["plan"],
  workerOutputs: readonly WorkflowV2WorkerOutput[],
  status: "completed" | "failed" | "paused" | "running",
  recoveryDecisions: readonly WorkflowRecoveryDecisionRecord[] = [],
  operations: readonly WorkflowOperationRecord[] = [],
  workspaceDiff?: WorkflowWorkspaceDiffResult,
): string {
  const outputByNodeId = new Map(workerOutputs.map((output) => [output.nodeId, output]));
  const changedPaths = [...new Set(workerOutputs.flatMap((output) => output.acceptance?.changedPaths ?? []))].sort();
  const nodeTimelineReport = [
    "## Node timeline",
    ...plan.definition.nodes.map((node, index) => {
      const output = outputByNodeId.get(node.id);
      return `- ${index + 1}. ${node.title} (${node.id}): ${output ? `${output.acceptance?.outcome ?? "completed"}; ${output.summary}` : "no completed output"}`;
    }),
  ].join("\n");
  const actualFileChanges = workspaceDiff ? [
    ...workspaceDiff.created.map((changedPath) => `- created: ${changedPath}`),
    ...workspaceDiff.modified.map((changedPath) => `- modified: ${changedPath}`),
    ...workspaceDiff.deleted.map((changedPath) => `- deleted: ${changedPath}`),
  ] : changedPaths.map((changedPath) => `- changed: ${changedPath}`);
  const fileDiffReport = ["## File diff", ...(actualFileChanges.length ? actualFileChanges : ["- No governed file changes recorded."])].join("\n");
  const transactionReport = workflowV2NodeTransactionReport(plan.definition.nodes, outputByNodeId);
  const recoveryDecisionReport = recoveryDecisions.length > 0 ? [
    "## Recovery decisions",
    ...recoveryDecisions.map((decision) => `- ${decision.action} by ${workflowV2ReportText(decision.actor)} at ${new Date(decision.decidedAt).toISOString()}: ${workflowV2ReportText(decision.reason)} [operations: ${decision.operationIds.join(", ") || "none"}]`),
  ].join("\n") : "";
  const compensationOperations = operations
    .filter((operation) => operation.state === "compensated" || operation.state === "compensating" || operation.state === "unknown")
    .sort((left, right) => left.updatedAt - right.updatedAt || left.operationId.localeCompare(right.operationId));
  const manualOperationSteps = [
    ...operations.filter((operation) => operation.state === "unknown").map((operation) => `- Verify ${operation.operationId} in the external system before retrying, continuing, or compensating.`),
    ...operations.filter((operation) => operation.state === "applied" && !operation.reversible).map((operation) => `- Manually reconcile ${operation.operationId}; the applied external operation is irreversible and cannot be automatically compensated.`),
  ];
  const operationReport = operations.length > 0 ? [
    "## External operations",
    ...operations.map((operation) => `- ${operation.operationId}: ${operation.kind} ${operation.state}; target=${operation.target}; reversible=${operation.reversible}; request=${workflowV2ReportValue(operation.requestSummary)}; receipt=${workflowV2ReportValue(operation.receipt)}${operation.error ? `; error=${operation.error}` : ""}`),
    ...(manualOperationSteps.length > 0 ? ["", "## Manual steps", ...manualOperationSteps] : []),
    "",
    "## Compensation results",
    ...compensationOperations.map((operation, index) => `- ${index + 1}. ${operation.operationId}: ${operation.state}; updated=${new Date(operation.updatedAt).toISOString()}${operation.error ? `; ${operation.error}` : ""}`),
    ...(compensationOperations.length === 0 ? ["- No compensation or unknown external state recorded."] : []),
  ].join("\n") : "";
  const governanceReport = [nodeTimelineReport, fileDiffReport, transactionReport, operationReport, recoveryDecisionReport].filter(Boolean).join("\n\n");
  if (status === "completed") {
    const terminalNodeIds = new Set(plan.definition.nodes.map((node) => node.id));
    for (const edge of plan.definition.edges) terminalNodeIds.delete(edge.fromNodeId);
    for (const node of [...plan.definition.nodes].reverse()) {
      if (!terminalNodeIds.has(node.id)) continue;
      const output = outputByNodeId.get(node.id);
      const userReport = output ? workflowV2ExplicitUserFacingOutput(output) : undefined;
      if (userReport) return governanceReport ? `${userReport}\n\n${governanceReport}` : userReport;
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
    ...(governanceReport ? ["", governanceReport] : []),
  ].join("\n");
}

export function workflowV2ReportValue(value: unknown): string {
  if (value === undefined) return "missing";
  try {
    const serialized = JSON.stringify(sanitizeWorkflowTransactionValue(value));
    if (serialized === undefined) return "unavailable";
    return serialized.length > 2_000 ? `${serialized.slice(0, 2_000)}...[truncated]` : serialized;
  } catch {
    return "unavailable";
  }
}

function workflowV2ReportText(value: string): string {
  const sanitized = sanitizeWorkflowTransactionValue(value);
  return typeof sanitized === "string" ? sanitized : "[REDACTED]";
}

export function buildWorkflowV2RecoveryPreview(input: {
  transaction: WorkflowTransactionState;
  operations: readonly WorkflowOperationRecord[];
  runState: WorkflowV2PersistedRunState["runState"];
  nodeControl?: WorkflowV2PersistedRunState["nodeControl"];
  workspaceDiff?: { created: readonly string[]; modified: readonly string[]; deleted: readonly string[]; conflicts?: readonly string[] };
  canCompensate?: boolean;
  compensableOperationIds?: readonly string[];
  canRollbackSavepoint?: boolean;
  canRollbackWorkspace?: boolean;
  workspaceAvailable?: boolean;
  operationLedgerAvailable?: boolean;
  conflictDetails?: readonly WorkflowConflictPreview[];
  now?: number;
}): WorkflowRecoveryPreview {
  const uncertainOperations = input.operations.filter((operation) =>
    operation.state === "applying" || operation.state === "unknown" || operation.state === "compensating");
  const blockers = uncertainOperations.map((operation) =>
    `${operation.operationId}: ${operation.state}${operation.error ? ` (${operation.error})` : ""}`);
  const cancellingNodeIds = input.runState.nodeOrder.filter((nodeId) => {
    const status = input.runState.nodes[nodeId]?.status;
    return status === "running" || status === "validating" || status === "awaiting_review";
  });
  const cancelledNodeIds = input.runState.nodeOrder.filter((nodeId) =>
    input.runState.nodes[nodeId]?.status === "paused" && Boolean(input.nodeControl?.[nodeId]?.stopReason));
  const notStartedNodeIds = input.runState.nodeOrder.filter((nodeId) => {
    const status = input.runState.nodes[nodeId]?.status;
    return status === "blocked" || status === "ready";
  });
  const uncertainNodeIds = [...new Set([...uncertainOperations.map((operation) => operation.nodeId), ...cancellingNodeIds])].sort();
  const pendingNodeIds = [...new Set([...cancellingNodeIds, ...notStartedNodeIds])];
  const conflicts = [...new Set(input.workspaceDiff?.conflicts ?? [])].sort();
  const changedPaths = [...new Set([
    ...(input.workspaceDiff?.created ?? []),
    ...(input.workspaceDiff?.modified ?? []),
    ...(input.workspaceDiff?.deleted ?? []),
  ])].sort();
  const workspaceUnavailable = input.transaction.mode === "strict_atomic" && input.workspaceAvailable === false;
  const operationLedgerUnavailable = input.operationLedgerAvailable === false;
  const savepointOperationIds = new Set(input.transaction.currentSavepointOperationIds ?? []);
  const savepointLedgerBoundaryKnown = input.transaction.currentSavepointOperationIds !== undefined || input.operations.length === 0;
  const postSavepointOperationIds = savepointLedgerBoundaryKnown
    ? input.operations.filter((operation) => !savepointOperationIds.has(operation.operationId)).map((operation) => operation.operationId)
    : input.operations.map((operation) => operation.operationId);
  if (conflicts.length > 0) blockers.push(`Workspace conflicts: ${conflicts.join(", ")}`);
  if (workspaceUnavailable) blockers.push("The isolated workflow workspace is unavailable or cannot be inspected; continuation is blocked.");
  if (operationLedgerUnavailable) blockers.push("The external operation ledger is unavailable or malformed; continuation is blocked.");
  if (input.transaction.currentSavepointId && postSavepointOperationIds.length > 0) {
    blockers.push(`Savepoint rollback cannot proceed while later external operations remain in the ledger: ${postSavepointOperationIds.join(", ")}.`);
  }
  if (input.transaction.pendingCheckpointId) blockers.push(`Checkpoint ${input.transaction.pendingCheckpointId} requires approval before the frozen run can continue.`);
  if (input.transaction.status === "recovery_required" && blockers.length === 0) {
    blockers.push("The transaction requires recovery review before execution can continue.");
  }
  const hasReversibleAppliedOperation = input.operations.some((operation) => operation.state === "applied" && operation.reversible);
  const hasContinuationTarget = Boolean(input.transaction.pendingCheckpointId)
    || input.runState.nodeOrder.some((nodeId) => {
      const status = input.runState.nodes[nodeId]?.status;
      return status !== "completed" && status !== "completed_with_override" && status !== "skipped";
    });
  const generatedAt = input.now ?? Date.now();
  const availableActions = [
    ...(hasContinuationTarget && uncertainOperations.length === 0 && conflicts.length === 0 && !workspaceUnavailable && !operationLedgerUnavailable ? ["continue" as const] : []),
    ...(input.transaction.currentSavepointId && input.canRollbackSavepoint && postSavepointOperationIds.length === 0 ? ["rollback_savepoint" as const] : []),
    ...((hasReversibleAppliedOperation && input.canCompensate) || (changedPaths.length > 0 && input.canRollbackWorkspace) ? ["compensate_all" as const] : []),
    "keep_state" as const,
    "abandon" as const,
  ];
  const reversibleAppliedOperations = input.operations.filter((operation) => operation.state === "applied" && operation.reversible);
  const irreversibleAppliedOperations = input.operations.filter((operation) => operation.state === "applied" && !operation.reversible);
  const compensationOperationIds = reversibleAppliedOperations
    .filter((operation) => !input.compensableOperationIds || input.compensableOperationIds.includes(operation.operationId))
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .map((operation) => operation.operationId);
  const recommendedAction = uncertainOperations.length > 0 || conflicts.length > 0 || workspaceUnavailable || operationLedgerUnavailable
    ? "keep_state" as const
    : availableActions.includes("compensate_all")
      ? "compensate_all" as const
      : availableActions.includes("rollback_savepoint")
        ? "rollback_savepoint" as const
        : availableActions.includes("continue")
          ? "continue" as const
          : "keep_state" as const;
  const conflictCandidates = (input.conflictDetails ?? []).map((conflict) => {
    if (conflict.isolated.sha256 === conflict.current.sha256) return { path: conflict.path, resolution: "isolated" as const, rationale: "Both sides already contain the same content." };
    if (conflict.current.sha256 === conflict.baseline.sha256) return { path: conflict.path, resolution: "isolated" as const, rationale: "Only the isolated workflow result changed from the baseline." };
    if (conflict.isolated.sha256 === conflict.baseline.sha256) return { path: conflict.path, resolution: "current" as const, rationale: "Only the user's current workspace changed from the baseline." };
    return { path: conflict.path, resolution: "manual" as const, rationale: "Both sides changed; review the three-way preview before applying a merge." };
  });
  return {
    generatedAt,
    transactionId: input.transaction.transactionId,
    status: input.transaction.status,
    blockers,
    conflicts,
    conflictDetails: [...structuredClone(input.conflictDetails ?? [])],
    changedPaths,
    pendingNodeIds,
    uncertainNodeIds,
    cancelledNodeIds,
    cancellingNodeIds,
    notStartedNodeIds,
    availableActions,
    managerRecommendation: {
      source: "rules",
      generatedAt,
      transactionId: input.transaction.transactionId,
      recommendedAction,
      rationale: recommendedAction === "keep_state"
        ? "Preserve the current evidence until unknown operations or workspace conflicts are resolved."
        : recommendedAction === "compensate_all"
          ? "Reverse the verified reversible external operations before deciding how to handle workspace changes."
          : recommendedAction === "rollback_savepoint"
            ? "A verified savepoint is available and no unresolved external state blocks a rollback preview."
            : "No unknown external operation or workspace conflict currently blocks continuation.",
      ...(input.transaction.currentSavepointId && availableActions.includes("rollback_savepoint") ? { rollbackTarget: input.transaction.currentSavepointId } : {}),
      compensationOperationIds,
      manualSteps: [
        ...uncertainOperations.map((operation) => `Verify ${operation.operationId} with its provider receipt before retrying or compensating.`),
        ...reversibleAppliedOperations.filter((operation) => !compensationOperationIds.includes(operation.operationId)).map((operation) => `Re-authorize or manually reverse ${operation.operationId}; its persisted adapter state cannot execute compensation safely.`),
        ...irreversibleAppliedOperations.map((operation) => `Manually reconcile ${operation.operationId}; the applied external operation is irreversible and cannot be included in automatic compensation.`),
        ...conflictCandidates.filter((candidate) => candidate.resolution === "manual").map((candidate) => `Manually merge ${candidate.path} from the three-way conflict preview and confirm the resulting diff.`),
      ],
      riskComparison: availableActions.map((action) => ({
        action,
        risk: action === "abandon" || action === "compensate_all" ? "high" as const : action === "continue" || action === "rollback_savepoint" ? "medium" as const : "low" as const,
        detail: action === "continue" ? "May resume node execution and create new effects."
          : action === "rollback_savepoint" ? "Changes isolated workspace state and may discard later node work."
            : action === "compensate_all" ? "Calls external compensation adapters in reverse operation order."
              : action === "abandon" ? "Stops active handling while preserving unresolved evidence."
                : "Leaves all current state and evidence unchanged.",
      })),
      conflictCandidates,
    },
  };
}

export function parseWorkflowV2RecoveryManagerRecommendation(content: string, preview: WorkflowRecoveryPreview): WorkflowRecoveryManagerRecommendation {
  const normalized = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const value = JSON.parse(normalized) as Record<string, unknown>;
  const recommendedAction = value.recommendedAction;
  if (typeof recommendedAction !== "string" || !preview.availableActions.includes(recommendedAction as WorkflowRecoveryManagerRecommendation["recommendedAction"])) throw new Error("Manager recovery recommendation selected an unavailable action.");
  if (typeof value.rationale !== "string" || !value.rationale.trim()) throw new Error("Manager recovery recommendation requires a rationale.");
  const compensationOperationIds = stringArray(value.compensationOperationIds);
  const allowedCompensationIds = new Set(preview.managerRecommendation.compensationOperationIds);
  if (compensationOperationIds.some((operationId) => !allowedCompensationIds.has(operationId))) throw new Error("Manager recovery recommendation contains an ineligible compensation operation.");
  const manualSteps = stringArray(value.manualSteps);
  if (value.rollbackTarget !== undefined && (typeof value.rollbackTarget !== "string" || value.rollbackTarget !== preview.managerRecommendation.rollbackTarget)) throw new Error("Manager recovery recommendation selected an unavailable rollback target.");
  const conflictPaths = new Set(preview.conflicts);
  const conflictCandidates = Array.isArray(value.conflictCandidates) ? value.conflictCandidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Manager conflict candidate is malformed.");
    const item = candidate as Record<string, unknown>;
    if (typeof item.path !== "string" || !conflictPaths.has(item.path)) throw new Error("Manager conflict candidate does not belong to the recovery preview.");
    if (item.resolution !== "isolated" && item.resolution !== "current" && item.resolution !== "manual") throw new Error("Manager conflict candidate resolution is invalid.");
    if (typeof item.rationale !== "string" || !item.rationale.trim()) throw new Error("Manager conflict candidate requires a rationale.");
    return { path: item.path, resolution: item.resolution as "isolated" | "current" | "manual", rationale: item.rationale };
  }) : [];
  const riskComparison = Array.isArray(value.riskComparison) ? value.riskComparison.map((risk) => {
    if (!risk || typeof risk !== "object" || Array.isArray(risk)) throw new Error("Manager risk comparison is malformed.");
    const item = risk as Record<string, unknown>;
    if (typeof item.action !== "string" || !preview.availableActions.includes(item.action as WorkflowRecoveryManagerRecommendation["recommendedAction"])) throw new Error("Manager risk comparison contains an unavailable action.");
    if (item.risk !== "low" && item.risk !== "medium" && item.risk !== "high") throw new Error("Manager risk comparison level is invalid.");
    if (typeof item.detail !== "string" || !item.detail.trim()) throw new Error("Manager risk comparison requires detail.");
    return { action: item.action as WorkflowRecoveryManagerRecommendation["recommendedAction"], risk: item.risk as "low" | "medium" | "high", detail: item.detail };
  }) : [];
  if (new Set(riskComparison.map((item) => item.action)).size !== preview.availableActions.length || preview.availableActions.some((action) => !riskComparison.some((item) => item.action === action))) throw new Error("Manager risk comparison must cover every available recovery action.");
  return {
    source: "agent",
    generatedAt: Date.now(),
    transactionId: preview.transactionId,
    recommendedAction: recommendedAction as WorkflowRecoveryManagerRecommendation["recommendedAction"],
    rationale: value.rationale.trim(),
    ...(typeof value.rollbackTarget === "string" && value.rollbackTarget.trim() ? { rollbackTarget: value.rollbackTarget.trim() } : {}),
    compensationOperationIds,
    manualSteps,
    riskComparison,
    conflictCandidates,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) throw new Error("Manager recovery recommendation requires string arrays.");
  return value.map((item) => item.trim());
}

function workflowV2NodeTransactionReport(
  nodes: readonly WorkflowV2Node[],
  outputByNodeId: ReadonlyMap<string, WorkflowV2WorkerOutput>,
): string {
  const lines = nodes.flatMap((node) => {
    const output = outputByNodeId.get(node.id);
    const acceptance = output?.acceptance;
    if (!acceptance) return [];
    return [
      `### ${node.title} (${node.id}) — ${acceptance.outcome}`,
      `- Changed paths: ${acceptance.changedPaths.join(", ") || "none"}`,
      `- Operations: ${acceptance.operationIds.join(", ") || "none"}`,
      ...acceptance.issues.map((issue) => `- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.detail}`),
      ...(output.scriptReceipt ? [
        `- Script receipt: exit=${output.scriptReceipt.exitCode ?? "none"}; signal=${output.scriptReceipt.signal ?? "none"}; timeout=${output.scriptReceipt.timedOut}; effect=${output.scriptReceipt.effectState}; stdout=${output.scriptReceipt.stdoutDigest}`,
        ...(output.scriptReceipt.stderrSummary ? [`- Stderr: ${output.scriptReceipt.stderrSummary}`] : []),
      ] : []),
    ];
  });
  return lines.length > 0 ? ["## Transactional node acceptance", ...lines].join("\n") : "";
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
