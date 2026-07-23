import { open } from "node:fs/promises";
import path from "node:path";
import type { AgentHub } from "../hub/agent-hub";
import type { WorkflowOperationResult, WorkflowRunState, WorkflowStatus } from "../../shared/types";
import type { WorkflowV2InterventionAction } from "../../shared/workflow-v2/review";

type McpLifecycleErrorCode =
  | "INVALID_ARGUMENT"
  | "WORKFLOW_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "WORKFLOW_REVISION_CONFLICT"
  | "RUN_IDENTITY_MISMATCH"
  | "INTERVENTION_ALREADY_RESOLVED"
  | "INVALID_STATE"
  | "INTERNAL_ERROR";

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
const WORKFLOW_STATUSES = new Set<WorkflowStatus>(["draft", "running", "waiting_for_user", "completed", "failed", "stopped"]);
const OUTPUT_PREVIEW_BYTES = 4_096;
const TEXT_OUTPUT_TYPES = new Map([
  [".csv", "text/csv"],
  [".html", "text/html"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
]);
const WORKFLOW_MCP_LIFECYCLE_ROUTES = new Set([
  "/mcp/workflow/run/list",
  "/mcp/workflow/run/get",
  "/mcp/workflow/outputs/list",
  "/mcp/workflow/confirm",
  "/mcp/workflow/run",
  "/mcp/workflow/run/stop",
  "/mcp/workflow/intervention/resolve",
  "/mcp/workflow/script-input/submit",
  "/mcp/workflow/node/complete",
]);

export function isWorkflowMcpLifecycleRoute(route: string): boolean {
  return WORKFLOW_MCP_LIFECYCLE_ROUTES.has(route);
}

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

function redactSensitiveText(value: string): string {
  return value
    .replace(/(\bauthorization\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*\b\s*=\s*)[^\s\r\n]+/gi, "$1[REDACTED]")
    .replace(/("(?:authorization|[^"\r\n]*(?:token|secret|password|api_key)[^"\r\n]*)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
}

function validStringArray(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validProposal(value: unknown): boolean {
  const proposal = asRecord(value);
  if (typeof proposal.reason !== "string" || !proposal.reason.trim()) return false;
  if (proposal.kind === "continue") {
    return proposal.targetNodeIds === undefined
      || Array.isArray(proposal.targetNodeIds) && proposal.targetNodeIds.every((item) => typeof item === "string" && item.trim());
  }
  if (proposal.kind === "retry") return proposal.targetNodeId === undefined || typeof proposal.targetNodeId === "string" && Boolean(proposal.targetNodeId.trim());
  return proposal.kind === "escalate" || proposal.kind === "graph-revision";
}

function operationErrorCode(message: string): McpLifecycleErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("not found")) return normalized.includes("run") ? "RUN_NOT_FOUND" : "WORKFLOW_NOT_FOUND";
  if (normalized.includes("revision") || normalized.includes("changed")) return "WORKFLOW_REVISION_CONFLICT";
  if (normalized.includes("no pending human intervention")
    || normalized.includes("already") && (normalized.includes("resolv") || normalized.includes("resolved"))) {
    return "INTERVENTION_ALREADY_RESOLVED";
  }
  return "INVALID_STATE";
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
  return fail(operationErrorCode(message), message);
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

async function publicOutput(output: { name: string; path: string }): Promise<Record<string, unknown>> {
  const name = path.basename(output.name || output.path);
  const type = TEXT_OUTPUT_TYPES.get(path.extname(name).toLowerCase()) ?? "application/octet-stream";
  const projected: Record<string, unknown> = { name, type };
  try {
    const file = await open(output.path, "r");
    try {
      const stats = await file.stat();
      projected.size = stats.size;
      if (!TEXT_OUTPUT_TYPES.has(path.extname(name).toLowerCase())) return projected;
      const bytesToRead = Math.min(stats.size, OUTPUT_PREVIEW_BYTES + 1);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
      const previewBytes = buffer.subarray(0, Math.min(bytesRead, OUTPUT_PREVIEW_BYTES));
      projected.preview = redactSensitiveText(new TextDecoder().decode(previewBytes, { stream: true }));
      projected.previewTruncated = stats.size > OUTPUT_PREVIEW_BYTES;
    } finally {
      await file.close();
    }
  } catch {
    // Outputs can disappear between directory enumeration and projection.
  }
  return projected;
}

async function routeWorkflowMcpLifecycleInternal(
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
    if (status && !WORKFLOW_STATUSES.has(status as WorkflowStatus)) {
      return fail("INVALID_ARGUMENT", "workflow_run_list status is invalid.");
    }
    if ((record.startedAfter !== undefined && (!Number.isFinite(startedAfter) || startedAfter! < 0))
      || (record.startedBefore !== undefined && (!Number.isFinite(startedBefore) || startedBefore! < 0))
      || (startedAfter !== undefined && startedBefore !== undefined && startedAfter > startedBefore)) {
      return fail("INVALID_ARGUMENT", "workflow_run_list time range is invalid.");
    }
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
    return { ok: true, data: { outputs: await Promise.all(outputs.map(publicOutput)) } };
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
    if (record.reason !== undefined && (typeof record.reason !== "string" || record.reason.trim().length > 2_000)) {
      return fail("INVALID_ARGUMENT", "workflow_intervention_resolve reason is invalid.");
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
    if (!validStringArray(record.evidence) || !validStringArray(record.risks) || !validStringArray(record.nextStepSuggestions)
      || !record.proposals.every(validProposal)) {
      return fail("INVALID_ARGUMENT", "workflow_node_complete output is invalid.");
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

export async function routeWorkflowMcpLifecycle(
  hub: AgentHub,
  route: string,
  body: unknown,
): Promise<McpLifecycleResult | undefined> {
  try {
    return await routeWorkflowMcpLifecycleInternal(hub, route, body);
  } catch {
    return fail("INTERNAL_ERROR", "The Workflow MCP request could not be completed.");
  }
}
