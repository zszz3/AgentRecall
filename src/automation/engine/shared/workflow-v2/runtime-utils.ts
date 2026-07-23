import type {
  TaskRun,
  WorkflowEvent,
  WorkflowRunNodeStatus,
  WorkflowRunProgressItem,
} from "../types";

export const WORKFLOW_TASK_POLL_MS = 1000;
export const WORKFLOW_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const WORKFLOW_STORAGE_ROOT = ".agent-recall/workflows";

export interface WorkflowStoragePlan {
  memoryPath: string;
  outputDir: string;
}

const WORKFLOW_EVENT_STATUS: Record<WorkflowEvent["type"], WorkflowRunNodeStatus> = {
  node_ready: "queued",
  node_started: "running",
  node_paused: "paused",
  node_output: "running",
  node_judged: "running",
  node_failed: "failed",
  node_completed: "completed",
  gate_opened: "awaiting_input",
  gate_answered: "running",
  graph_revised: "paused",
};

export function projectNodeStates(
  events: WorkflowEvent[],
  declaredNodes: Array<{ nodeId: string; title: string }>,
): WorkflowRunProgressItem[] {
  const titleByNodeId = new Map(declaredNodes.map((node) => [node.nodeId, node.title]));
  const order = declaredNodes.map((node) => node.nodeId);
  for (const event of events) {
    if (titleByNodeId.has(event.nodeId)) continue;
    order.push(event.nodeId);
    titleByNodeId.set(event.nodeId, event.nodeId);
  }
  const latestByNodeId = new Map<string, WorkflowEvent>();
  const latestStartByNodeId = new Map<string, WorkflowEvent>();
  for (const event of events) {
    latestByNodeId.set(event.nodeId, event);
    if (event.type === "node_started") latestStartByNodeId.set(event.nodeId, event);
  }
  return order.map((nodeId) => {
    const title = titleByNodeId.get(nodeId) ?? nodeId;
    const latest = latestByNodeId.get(nodeId);
    if (!latest) return { nodeId, title, status: "queued", detail: "Queued" };
    const status = WORKFLOW_EVENT_STATUS[latest.type];
    const item: WorkflowRunProgressItem = { nodeId, title, status };
    const detail = latest.detail
      ?? (status === "awaiting_input" ? latest.question : undefined)
      ?? (status === "failed" ? latest.error : undefined)
      ?? (status === "paused" ? "Paused" : undefined)
      ?? (status === "queued" ? "Queued" : undefined);
    if (detail) item.detail = detail;
    if (status === "paused" && latest.intervention) item.intervention = structuredClone(latest.intervention);
    if (status === "running" || status === "paused") {
      const taskId = latest.taskId ?? latestStartByNodeId.get(nodeId)?.taskId;
      if (taskId) item.taskId = taskId;
    }
    return item;
  });
}

export function truncateWorkflowContext(content: string, limit = 2400): string {
  const normalized = content.replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trim()}\n\n[truncated]`;
}

export function workflowStoragePlanFor(workflowId: string, runId: string): WorkflowStoragePlan {
  const safeWorkflowId = workflowId.replace(/[^a-zA-Z0-9_-]/g, "_") || "workflow";
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_") || "run";
  return { memoryPath: "memory.md", outputDir: `outputs/${safeWorkflowId}/${safeRunId}` };
}

export function defaultWorkflowWorkDirSuffix(workflowId: string): string {
  const safeWorkflowId = workflowId.replace(/[^a-zA-Z0-9_-]/g, "_") || "workflow";
  return `${WORKFLOW_STORAGE_ROOT}/${safeWorkflowId}`;
}

export function workflowStoragePlanDocument(plan: WorkflowStoragePlan): string {
  return [
    "# Workflow Storage Plan",
    "",
    `- Shared memory file: ${plan.memoryPath}`,
    `- Output document directory: ${plan.outputDir}`,
    "",
    "All agent nodes should treat the Workflow Context in the app as the source of shared memory.",
    "If an agent creates user-facing documents, write every file directly under the output document directory and report the exact relative file path.",
    "Do not create per-node output directories or write into another workflow run directory.",
  ].join("\n");
}

export function workflowProgressAfterFailure(progress: WorkflowRunProgressItem[], errorMessage: string): WorkflowRunProgressItem[] {
  if (progress.some((item) => item.status === "failed")) return progress;
  if (progress.length === 0) return [{ nodeId: "__workflow__", title: "Workflow", status: "failed", detail: errorMessage }];
  const index = progress.findIndex((item) => item.status === "running" || item.status === "queued");
  const targetIndex = index >= 0 ? index : progress.length - 1;
  return progress.map((item, itemIndex) => itemIndex === targetIndex ? { ...item, status: "failed", detail: errorMessage } : item);
}

export function taskArtifact(task: TaskRun): string {
  const completionTool = [...task.messages]
    .reverse()
    .flatMap((message) => [...(message.events ?? [])].reverse())
    .find((event) => event.type === "tool_call" && event.name?.toLowerCase().includes("workflow_node_complete"));
  if (completionTool?.content?.trim()) return completionTool.content.trim();
  const assistantMessage = [...task.messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
  if (assistantMessage) return assistantMessage.content.trim();
  const errorMessage = [...task.messages].reverse().find((message) => message.role === "error" && message.content.trim());
  if (errorMessage) return errorMessage.content.trim();
  return `${task.title} completed without assistant output.`;
}
