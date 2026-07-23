import path from "node:path";
import type { AgentHub } from "../hub/agent-hub";
import type { WorkflowOperationResult, WorkflowRunState } from "../../shared/types";
import type { WorkflowV2InterventionAction } from "../../shared/workflow-v2/review";

type McpLifecycleErrorCode =
  | "INVALID_ARGUMENT"
  | "WORKFLOW_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "WORKFLOW_REVISION_CONFLICT"
  | "RUN_IDENTITY_MISMATCH"
  | "INTERVENTION_ALREADY_RESOLVED"
  | "INVALID_STATE";

type McpLifecycleResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: McpLifecycleErrorCode; message: string } };

const INTERVENTION_ACTIONS = new Set<WorkflowV2InterventionAction>([
  "continue",
  "skip",
  "escalate",
  "replan",
  "increase_review_strength",
  "approve_once",
  "reject",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function fail(code: McpLifecycleErrorCode, message: string): McpLifecycleResult {
  return { ok: false, error: { code, message } };
}

function operationResult(result: WorkflowOperationResult): McpLifecycleResult {
  if (result.ok) {
    return {
      ok: true,
      data: {
        ...(result.workflowId ? { workflowId: result.workflowId } : {}),
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.revision !== undefined ? { revision: result.revision } : {}),
      },
    };
  }
  const message = result.error || "Workflow operation was rejected.";
  const normalized = message.toLowerCase();
  const code: McpLifecycleErrorCode = normalized.includes("not found")
    ? normalized.includes("run") ? "RUN_NOT_FOUND" : "WORKFLOW_NOT_FOUND"
    : normalized.includes("revision") || normalized.includes("changed")
      ? "WORKFLOW_REVISION_CONFLICT"
      : normalized.includes("already") && normalized.includes("resolv")
        ? "INTERVENTION_ALREADY_RESOLVED"
        : "INVALID_STATE";
  return fail(code, message);
}

function workflowAndRun(hub: AgentHub, workflowId: string, runId: string):
  | { run: WorkflowRunState }
  | McpLifecycleResult {
  const snapshot = hub.snapshot();
  if (!snapshot.workflowStore.workflows.some((workflow) => workflow.workflowId === workflowId)) {
    return fail("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} was not found.`);
  }
  const run = snapshot.workflowStore.runs.find((candidate) => candidate.runId === runId);
  if (!run) return fail("RUN_NOT_FOUND", `Workflow run ${runId} was not found.`);
  if (run.workflowId !== workflowId) {
    return fail("RUN_IDENTITY_MISMATCH", `Run ${runId} does not belong to workflow ${workflowId}.`);
  }
  return { run };
}

function publicRun(run: WorkflowRunState): unknown {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    status: run.status,
    triggerSource: run.triggerSource,
    graphVersion: run.workflowV2Plan.definition.graphVersion,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError,
    finalReport: run.finalReport,
    progress: run.progress.map((node) => ({
      nodeId: node.nodeId,
      title: node.title,
      status: node.status,
      detail: node.detail,
      telemetry: node.telemetry,
      outputKeys: node.outputs ? Object.keys(node.outputs) : [],
    })),
  };
}

function pendingActions(run: WorkflowRunState): unknown[] {
  const actions: unknown[] = [];
  for (const node of run.progress) {
    if (node.intervention) {
      actions.push({ nodeId: node.nodeId, kind: "intervention", intervention: node.intervention });
      continue;
    }
    if (node.inputRequest) {
      actions.push({ nodeId: node.nodeId, kind: node.inputRequest.kind, request: node.inputRequest });
    }
  }
  return actions;
}

export async function routeWorkflowMcpLifecycle(
  hub: AgentHub,
  route: string,
  body: unknown,
): Promise<McpLifecycleResult | undefined> {
  const record = asRecord(body);
  const workflowId = stringField(record, "workflowId");
  const runId = stringField(record, "runId");
  const nodeId = stringField(record, "nodeId");

  if (route === "/mcp/workflow/run/list") {
    const status = stringField(record, "status");
    const startedAfter = typeof record.startedAfter === "number" ? record.startedAfter : undefined;
    const startedBefore = typeof record.startedBefore === "number" ? record.startedBefore : undefined;
    const runs = hub.snapshot().workflowStore.runs
      .filter((run) => !workflowId || run.workflowId === workflowId)
      .filter((run) => !status || run.status === status)
      .filter((run) => startedAfter === undefined || run.startedAt >= startedAfter)
      .filter((run) => startedBefore === undefined || run.startedAt <= startedBefore)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(publicRun);
    return { ok: true, data: { runs } };
  }

  if (route === "/mcp/workflow/run/get") {
    if (!workflowId || !runId) return fail("INVALID_ARGUMENT", "workflow_run_get requires workflowId and runId.");
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    return { ok: true, data: { run: publicRun(resolved.run), pendingActions: pendingActions(resolved.run) } };
  }

  if (route === "/mcp/workflow/outputs/list") {
    if (!workflowId || !runId) return fail("INVALID_ARGUMENT", "workflow_outputs_list requires workflowId and runId.");
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    const outputs = await hub.listWorkflowOutputs({ workflowId, runId });
    return { ok: true, data: { outputs: outputs.map((output) => ({ name: path.basename(output.name || output.path) })) } };
  }

  if (route === "/mcp/workflow/confirm" || route === "/mcp/workflow/run") {
    const expectedRevision = typeof record.expectedRevision === "number" ? record.expectedRevision : undefined;
    if (!workflowId || expectedRevision === undefined) {
      return fail("INVALID_ARGUMENT", `${route.endsWith("confirm") ? "workflow_confirm" : "workflow_run"} requires workflowId and expectedRevision.`);
    }
    const workflow = hub.snapshot().workflowStore.workflows.find((candidate) => candidate.workflowId === workflowId);
    if (!workflow) return fail("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} was not found.`);
    if (workflow.revision !== expectedRevision) {
      return fail("WORKFLOW_REVISION_CONFLICT", `Workflow ${workflowId} is at revision ${workflow.revision}, not ${expectedRevision}.`);
    }
    if (route.endsWith("confirm")) return operationResult(hub.confirmWorkflow({ workflowId, expectedRevision }));
    const contextDocument = stringField(record, "contextDocument");
    return operationResult(hub.runWorkflow({ workflowId, triggerSource: "mcp", ...(contextDocument ? { contextDocument } : {}) }));
  }

  if (route === "/mcp/workflow/run/stop") {
    if (!workflowId || !runId) return fail("INVALID_ARGUMENT", "workflow_stop requires workflowId and runId.");
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    return operationResult(await hub.stopWorkflowRun({ workflowId, runId }));
  }

  if (route === "/mcp/workflow/intervention/resolve") {
    const action = stringField(record, "action") as WorkflowV2InterventionAction | undefined;
    if (!workflowId || !runId || !nodeId || !action || !INTERVENTION_ACTIONS.has(action)) {
      return fail("INVALID_ARGUMENT", "workflow_intervention_resolve requires workflowId, runId, nodeId, and a valid action.");
    }
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    if (!resolved.run.progress.some((node) => node.nodeId === nodeId)) return fail("NODE_NOT_FOUND", `Workflow node ${nodeId} was not found in run ${runId}.`);
    const reason = stringField(record, "reason");
    return operationResult(await hub.resolveWorkflowV2Intervention({ workflowId, runId, nodeId, action, ...(reason ? { reason } : {}) }));
  }

  if (route === "/mcp/workflow/script-input/submit") {
    if (!workflowId || !runId || !nodeId || !record.values || typeof record.values !== "object" || Array.isArray(record.values)) {
      return fail("INVALID_ARGUMENT", "workflow_script_input_submit requires workflowId, runId, nodeId, and values.");
    }
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    if (!resolved.run.progress.some((node) => node.nodeId === nodeId)) return fail("NODE_NOT_FOUND", `Workflow node ${nodeId} was not found in run ${runId}.`);
    return operationResult(await hub.submitWorkflowScriptInput({ workflowId, runId, nodeId, values: record.values as Record<string, unknown> }));
  }

  if (route === "/mcp/workflow/node/complete") {
    if (!workflowId || !runId || !nodeId) return fail("INVALID_ARGUMENT", "workflow_node_complete requires workflowId, runId, and nodeId.");
    const resolved = workflowAndRun(hub, workflowId, runId);
    if (!("run" in resolved)) return resolved;
    if (!resolved.run.progress.some((node) => node.nodeId === nodeId)) return fail("NODE_NOT_FOUND", `Workflow node ${nodeId} was not found in run ${runId}.`);
    const summary = stringField(record, "summary");
    if (!summary || !record.outputs || typeof record.outputs !== "object" || Array.isArray(record.outputs) || !Array.isArray(record.proposals)) {
      return fail("INVALID_ARGUMENT", "workflow_node_complete requires nodeId, summary, outputs, and proposals.");
    }
    return {
      ok: true,
      data: {
        output: {
          nodeId,
          summary,
          outputs: record.outputs,
          ...(Array.isArray(record.evidence) ? { evidence: record.evidence } : {}),
          ...(Array.isArray(record.risks) ? { risks: record.risks } : {}),
          ...(Array.isArray(record.nextStepSuggestions) ? { nextStepSuggestions: record.nextStepSuggestions } : {}),
          proposals: record.proposals,
        },
      },
    };
  }

  return undefined;
}
