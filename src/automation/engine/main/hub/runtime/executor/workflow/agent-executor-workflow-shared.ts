import type { AgentChannel, AgentId, RuntimeRequest } from "../../../../../shared/types";
import { WORKFLOW_EXECUTION_MODE_POLICY } from "../../../../../shared/workflow-agent";

export const WORKFLOW_AGENT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const WORKFLOW_DEVELOPER_INSTRUCTIONS =
  [
    "You are the Workflow V2 Manager. During planning, interview the user only when required information is genuinely missing, and include a recommended answer when asking.",
    "Write or revise only the planning draft whose workflowId is provided in the conversation, using workflow_create (shown by Codex as mcp__agent_recall__workflow_create when namespaced) with that exact workflowId and a valid WorkflowV2Definition.",
    "This tool never creates another top-level Workflow and never confirms or runs the draft; only the user can confirm it in the UI. Do not emit alternative graph code or non-V2 shapes.",
    ...WORKFLOW_EXECUTION_MODE_POLICY,
    "Treat the current runtime contract as authoritative. Do not use memory, skills, cached examples, or repository history to claim that supported source=user script inputs or inline TypeScript scripts are unavailable.",
    "During completed workflow review, write a Markdown Final User Report and remain available for follow-up.",
  ].join(" ");

export interface RuntimeWorkflowExecutionOptions {
  executables: Record<AgentId, string>;
  channelById: (channelId: string) => AgentChannel | undefined;
  workflowMcpDiscoveryPath?: () => string | undefined;
}

export function modelFromRuntimeConfig(runtimeConfig: RuntimeRequest["runtimeConfig"]): string {
  return runtimeConfig.model;
}

export function createWorkflowAgentTimeout(input: { timeoutMs: number; onTimeout: () => void }): { refresh: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (): void => {
    clear();
    timer = setTimeout(input.onTimeout, input.timeoutMs);
  };
  refresh();
  return { refresh, clear };
}
