import type { WorkflowOperationResult } from "../../../shared/workflow/commands";
import type { WorkflowRunState } from "../../../shared/workflow/run";
import type { WorkflowV2Node, WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2PlanNode } from "../../../shared/workflow-v2/planning";
import type { WorkflowV2HumanIntervention, WorkflowV2InterventionAction } from "../../../shared/workflow-v2/review";
import type { WorkflowV2DurableEvent, WorkflowV2DurableNodeControlState, WorkflowV2PersistedRunState } from "../../../shared/workflow-v2/storage";
import type { WorkflowRuntimeDependencies, WorkflowV2StorePort } from "../workflow-runtime-ports";
import type { WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";
import { authorizeWorkflowV2Script } from "./workflow-v2-script-execution";
import { workflowV2ScriptOperationDigest } from "./workflow-v2-script-analysis";
import { transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";

export function authorizeWorkflowV2ScriptOperation(input: {
  workflowId: string;
  graphVersion: number;
  runId: string;
  node: WorkflowV2ScriptNode;
  planNode: WorkflowV2PlanNode;
  workDir: string;
  inputs: Readonly<Record<string, unknown>>;
  approvalGrant?: NonNullable<WorkflowV2RecoveryOverride["scriptApproval"]>;
}) {
  const operationDigest = workflowV2ScriptOperationDigest({ workflowId: input.workflowId, graphVersion: input.graphVersion, runId: input.runId, node: input.node, workDir: input.workDir, inputs: input.inputs });
  if (input.approvalGrant && input.approvalGrant.operationDigest !== operationDigest) {
    throw new Error(`Workflow V2 script approval ${input.approvalGrant.requestId} does not match the concrete operation.`);
  }
  const authorization = authorizeWorkflowV2Script({ node: input.node, planNode: input.planNode, confirmed: input.approvalGrant !== undefined });
  if (authorization.permission.decision === "require_confirmation") {
    const executable = input.node.script.executable;
    throw new WorkflowV2SupervisionSignal({
      resolution: { action: "pause", question: `Approve ${authorization.permission.risk} script node ${input.node.title}?`, reason: authorization.analysis.rationale },
      report: { nodeId: input.node.id, attempt: 1, phase: "approval", completedItems: [], remainingItems: ["Human approval"], blockers: ["Script permission is not approved."], evidence: authorization.analysis.detectedCapabilities, safeToInterrupt: true, requestedAction: "need_input", reportedAt: Date.now() },
      intervention: {
        source: "script_permission",
        allowedActions: ["approve_once", "reject"],
        scriptApproval: {
          requestId: randomUUID(),
          risk: authorization.permission.risk,
          capabilities: [...authorization.governance.capabilities],
          capabilityDigest: authorization.governance.capabilityDigest,
          operationDigest,
          executableSummary: executable.kind === "command" ? [executable.command, ...(executable.args ?? [])].join(" ") : executable.code,
          workDir: input.workDir,
        },
      },
    });
  }
  return { ...authorization, operationDigest };
}

export class WorkflowV2ScriptApprovalCoordinator {
  private readonly resolving = new Set<string>();

  async run(input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    action: WorkflowV2InterventionAction;
  }, resolve: () => Promise<WorkflowOperationResult>): Promise<WorkflowOperationResult> {
    if (input.action !== "approve_once" && input.action !== "reject") return resolve();
    const key = `${input.workflowId}:${input.runId}:${input.nodeId}`;
    if (this.resolving.has(key)) {
      return { ok: false, workflowId: input.workflowId, runId: input.runId, error: "Workflow V2 script approval is already being resolved." };
    }
    this.resolving.add(key);
    try {
      return await resolve();
    } finally {
      this.resolving.delete(key);
    }
  }
}

export async function rejectWorkflowV2ScriptApproval(input: {
  deps: WorkflowRuntimeDependencies;
  store: WorkflowV2StorePort;
  persisted: WorkflowV2PersistedRunState;
  run: WorkflowRunState;
  nodeId: string;
  nodeTitle: string;
  resolvedAt: number;
  reason?: string;
  nodeControl: Record<string, WorkflowV2DurableNodeControlState>;
  resolutionEvent: WorkflowV2DurableEvent;
  eventCount: number;
}): Promise<WorkflowOperationResult> {
  const rejectionReason = input.reason?.trim() || `Dangerous script ${input.nodeTitle} was rejected by the user.`;
  const runState = transitionWorkflowV2NodeState(input.persisted.runState, { nodeId: input.nodeId, status: "failed", now: input.resolvedAt, error: rejectionReason });
  await input.store.appendEvents({ workflowId: input.run.workflowId, runId: input.run.runId, events: [{ ...input.resolutionEvent, detail: rejectionReason }] });
  await input.store.persistRunState({ ...structuredClone(input.persisted), savedAt: input.resolvedAt, eventCount: input.eventCount, runState, nodeControl: input.nodeControl });
  const progress = input.run.progress.map((item) => item.nodeId === input.nodeId ? { ...item, status: "failed" as const, detail: rejectionReason } : item);
  input.deps.finishWorkflowRun({
    workflowId: input.run.workflowId,
    runId: input.run.runId,
    status: "failed",
    progress,
    appendEvents: [{ type: "node_failed", nodeId: input.nodeId, at: input.resolvedAt, error: rejectionReason }],
    contextDocument: input.run.contextDocument,
    lastError: rejectionReason,
  });
  return { ok: true, workflowId: input.run.workflowId, runId: input.run.runId };
}

export function createWorkflowV2ScriptApprovalOverride(input: {
  node: WorkflowV2Node;
  planNode: WorkflowV2PlanNode | undefined;
  intervention: WorkflowV2HumanIntervention | undefined;
  resolutionReason: string;
}): { override?: WorkflowV2RecoveryOverride; error?: string } {
  if (input.node.execModel !== "script" || !input.intervention?.scriptApproval) {
    return { error: "Workflow V2 script approval request is incomplete." };
  }
  if (!input.planNode?.scriptGovernance || input.planNode.scriptGovernance.capabilityDigest !== input.intervention.scriptApproval.capabilityDigest) {
    return { error: "Workflow V2 script approval no longer matches frozen governance." };
  }
  return {
    override: {
      forceIndependentReview: false,
      instruction: input.resolutionReason,
      scriptApproval: {
        requestId: input.intervention.scriptApproval.requestId,
        operationDigest: input.intervention.scriptApproval.operationDigest,
      },
    },
  };
}
import { randomUUID } from "node:crypto";
