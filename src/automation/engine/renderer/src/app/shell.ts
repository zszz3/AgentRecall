import type { ScheduledWorkflowDueEvent } from "../../../shared/types";

export type ActiveFeature = "chat" | "tasks" | "workflow" | "schedules" | "skills" | "agent" | "mcp" | "evaluation" | "runtimes";

export function appShellClass(activeFeature: ActiveFeature): string {
  return activeFeature === "tasks" ||
    activeFeature === "workflow" ||
    activeFeature === "schedules" ||
    activeFeature === "skills" ||
    activeFeature === "agent" ||
    activeFeature === "mcp" ||
    activeFeature === "evaluation" ||
    activeFeature === "runtimes"
    ? `shell ${activeFeature}-shell`
    : "shell";
}

export function appContentClass(activeFeature: ActiveFeature): string {
  if (activeFeature === "chat") return "content chat-content";
  if (activeFeature === "tasks") return "content tasks-content";
  if (activeFeature === "workflow") return "content workflow-content";
  if (activeFeature === "schedules") return "content scheduled-content";
  if (activeFeature === "skills") return "content skills-content";
  if (activeFeature === "agent") return "content agent-content";
  if (activeFeature === "mcp") return "content mcp-content";
  if (activeFeature === "evaluation") return "content evaluation-content";
  if (activeFeature === "runtimes") return "content runtime-content";
  return "content chat-content";
}

export function missingAppCapabilityMessage(action: string): string {
  return `${action} needs a full app restart to load the updated Electron API.`;
}

export async function syncKeepAwakeIfAvailable(
  api: { setKeepAwake?: (enabled: boolean) => Promise<boolean> },
  enabled: boolean,
): Promise<void> {
  if (typeof api.setKeepAwake !== "function") return;
  await api.setKeepAwake(enabled);
}

export function taskDetailIdFor(
  activeFeature: ActiveFeature,
  selectedTaskDetailId: string | undefined,
  persistedActiveTaskId: string | undefined,
): string | undefined {
  void persistedActiveTaskId;
  return activeFeature === "tasks" ? selectedTaskDetailId : undefined;
}

export function scheduledWorkflowEventTarget(event: ScheduledWorkflowDueEvent): { scheduleId: string; workflowId: string } | undefined {
  const scheduleId = typeof event.payload.scheduleId === "string" ? event.payload.scheduleId : undefined;
  const workflowId = typeof event.payload.workflowId === "string" ? event.payload.workflowId : undefined;
  if (!scheduleId || !workflowId) return undefined;
  return { scheduleId, workflowId };
}

export async function refreshSnapshotForFeature<T>(feature: ActiveFeature, load: () => Promise<T>, apply: (snapshot: T) => void): Promise<void> {
  if (feature !== "workflow") return;
  apply(await load());
}
