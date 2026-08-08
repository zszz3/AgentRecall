export type WorkflowMcpScope = "planning" | "review" | "runtime_review" | "node_execution";
export type WorkflowMcpToolDecision = "allow" | "approval_required" | "deny";

export const WORKFLOW_MCP_SERVER_NAMES = ["agent_recall", "agent_recall_workflow"] as const;
export const STUDIO_MCP_TOOL_NAMES = [
  "studio_list_members",
  "studio_get_context",
  "studio_get_room_state",
  "studio_inbox_list",
  "studio_task_finish",
  "studio_turn_list",
  "studio_turn_get",
  "studio_turn_events",
  "studio_read_thread",
  "studio_post",
  "studio_read_messages",
  "studio_read_range",
  "studio_search",
  "workspace_reserve",
  "workspace_release",
  "workspace_status",
] as const;

const PLANNING_ALLOWED = new Set([
  "agent_templates_list",
  "skill_templates_list",
  "agents_list",
  "channels_list",
  "models_list",
  "workflow_create",
  "workflow_list",
  "workflow_get",
  "workflow_update",
  "workflow_validate",
  "workflow_context_append",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_outputs_list",
]);

const PLANNING_APPROVAL_REQUIRED = new Set([
  "agents_create",
  "agents_update",
  "agents_delete",
  "agents_test",
  "workflow_confirm",
  "workflow_run",
  "workflow_stop",
  "workflow_intervention_resolve",
  "workflow_script_input_submit",
]);

const NODE_EXECUTION_ALLOWED = new Set([
  "workflow_get",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_outputs_list",
  "workflow_run_context_append",
  "workflow_node_complete",
]);

const REVIEW_ALLOWED = new Set([
  "workflow_review_submit",
]);

const RUNTIME_REVIEW_ALLOWED = new Set([
  "workflow_review_gate_submit",
]);

const KNOWN_TOOLS = new Set([
  ...PLANNING_ALLOWED,
  ...PLANNING_APPROVAL_REQUIRED,
  ...REVIEW_ALLOWED,
  ...RUNTIME_REVIEW_ALLOWED,
  ...NODE_EXECUTION_ALLOWED,
]);
const STUDIO_TOOLS = new Set<string>(STUDIO_MCP_TOOL_NAMES);

export function workflowMcpToolDecision(
  scope: WorkflowMcpScope,
  toolName: string,
): WorkflowMcpToolDecision {
  if (scope === "node_execution") return NODE_EXECUTION_ALLOWED.has(toolName) ? "allow" : "deny";
  if (scope === "runtime_review") return RUNTIME_REVIEW_ALLOWED.has(toolName) ? "allow" : "deny";
  if (scope === "review") return REVIEW_ALLOWED.has(toolName) ? "allow" : "deny";
  if (PLANNING_ALLOWED.has(toolName)) return "allow";
  return PLANNING_APPROVAL_REQUIRED.has(toolName) ? "approval_required" : "deny";
}

export function workflowMcpToolsForScope(scope: WorkflowMcpScope): string[] {
  return [...KNOWN_TOOLS].filter((name) => workflowMcpToolDecision(scope, name) !== "deny");
}

export function isWorkflowMcpServerName(value: string): boolean {
  return (WORKFLOW_MCP_SERVER_NAMES as readonly string[]).includes(value.toLowerCase());
}

export function workflowMcpToolNameFromIdentifier(identifier: string): string | undefined {
  return scopedMcpToolNameFromIdentifier(identifier, KNOWN_TOOLS);
}

export function studioMcpToolNameFromIdentifier(identifier: string): string | undefined {
  return scopedMcpToolNameFromIdentifier(identifier, STUDIO_TOOLS);
}

function scopedMcpToolNameFromIdentifier(
  identifier: string,
  knownTools: ReadonlySet<string>,
): string | undefined {
  const normalized = identifier.trim().toLowerCase();
  const claude = normalized.match(/^mcp__(agent_recall(?:_workflow)?)__([a-z0-9_]+)$/);
  if (claude && isWorkflowMcpServerName(claude[1]!)) {
    return knownTools.has(claude[2]!) ? claude[2] : undefined;
  }
  const qualified = normalized.match(/^(agent_recall(?:_workflow)?)[/:]([a-z0-9_]+)$/);
  if (qualified && isWorkflowMcpServerName(qualified[1]!)) {
    return knownTools.has(qualified[2]!) ? qualified[2] : undefined;
  }
  return knownTools.has(normalized) ? normalized : undefined;
}

export function workflowMcpScopeFromEnvironment(environment: NodeJS.ProcessEnv): WorkflowMcpScope {
  if (environment.AGENT_RECALL_WORKFLOW_MCP_SCOPE === "node_execution") return "node_execution";
  if (environment.AGENT_RECALL_WORKFLOW_MCP_SCOPE === "runtime_review") return "runtime_review";
  if (environment.AGENT_RECALL_WORKFLOW_MCP_SCOPE === "review") return "review";
  return "planning";
}

export function workflowMcpScopeForContext(context: {
  planningWorkflowId?: string;
  workflowReviewRevision?: number;
  workflowRunId?: string;
  workflowNodeId?: string;
}): WorkflowMcpScope | undefined {
  if (context.workflowRunId && context.workflowNodeId && context.workflowReviewRevision) return "runtime_review";
  if (context.workflowRunId && context.workflowNodeId) return "node_execution";
  if (context.planningWorkflowId && context.workflowReviewRevision) return "review";
  return context.planningWorkflowId ? "planning" : undefined;
}
