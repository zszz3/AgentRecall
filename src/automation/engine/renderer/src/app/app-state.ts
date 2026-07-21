import { DEFAULT_SCHEDULED_WORKFLOW_CLOUD_BASE_URL } from "../../../shared/types";
import type {
  AgentChannel,
  AgentId,
  AgentModelOption,
  AgentTeam,
  AppSnapshot,
  ChatSession,
  ConfiguredAgent,
  RuntimeConversation,
  TaskRun,
  TeamRun,
  WorkflowGrillMessage,
  WorkflowRunProgressItem,
} from "../../../shared/types";
import { DEFAULT_MODEL_ID, FALLBACK_MODEL_OPTIONS, defaultChannelForAgent } from "../../../shared/models";
import { runtimeDefinition, runtimeLabel } from "../../../shared/runtime-catalog";
import type { AgentProviderPreset } from "../../../shared/provider-presets";
import { truncateWorkflowContext } from "../pages/workflow/workflow-utils";

export const DEFAULT_SNAPSHOT: AppSnapshot = {
  detectedAt: 0,
  activeChatId: undefined,
  activeTaskId: undefined,
  activeTeamId: undefined,
  activeTeamRunId: undefined,
  workDir: "",
  runtimes: [],
  channels: [],
  configuredAgents: [],
  chats: [],
  tasks: [],
  teams: [],
  teamRuns: [],
  workflowStore: {
    activeWorkflowId: undefined,
    workflows: [],
    runs: [],
  },
  scheduledWorkflowStore: {
    activeScheduleId: undefined,
    runnerConfig: { baseUrl: DEFAULT_SCHEDULED_WORKFLOW_CLOUD_BASE_URL },
    runnerStatus: { connected: false, connecting: false },
    schedules: [],
    runs: [],
  },
  workflowNodeConversations: [],
  workflowDraft: undefined,
  artifacts: [],
};

export function activeChatFrom(snapshot: AppSnapshot): ChatSession | undefined {
  return snapshot.chats.find((chat) => chat.id === snapshot.activeChatId) ?? snapshot.chats[0];
}

export function activeTaskFrom(snapshot: AppSnapshot): TaskRun | undefined {
  return snapshot.tasks.find((task) => task.id === snapshot.activeTaskId) ?? snapshot.tasks[0];
}

export function activeTeamFrom(snapshot: AppSnapshot): AgentTeam | undefined {
  return snapshot.teams.find((team) => team.id === snapshot.activeTeamId) ?? snapshot.teams[0];
}

export function activeTeamRunFrom(snapshot: AppSnapshot, teamId: string | undefined): TeamRun | undefined {
  const run = snapshot.teamRuns.find((item) => item.id === snapshot.activeTeamRunId);
  if (run && (!teamId || run.teamId === teamId)) return run;
  return snapshot.teamRuns.find((item) => !teamId || item.teamId === teamId);
}

export function uniqueId(base: string, existingIds: string[]): string {
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "channel";
  if (!existingIds.includes(normalized)) return normalized;
  let suffix = 2;
  while (existingIds.includes(`${normalized}-${suffix}`)) suffix += 1;
  return `${normalized}-${suffix}`;
}

export function createChannel(agentId: AgentId, existingIds: string[]): AgentChannel {
  const definition = runtimeDefinition(agentId);
  const useDefaultIdentity = !existingIds.includes(definition.defaultChannel.id);
  const id = useDefaultIdentity
    ? definition.defaultChannel.id
    : uniqueId(`${agentId}-config`, existingIds);
  return {
    ...(useDefaultIdentity ? definition.defaultChannel : {}),
    id,
    agentId,
    label: useDefaultIdentity ? definition.defaultChannel.label : `New ${runtimeLabel(agentId)} Config`,
    models: FALLBACK_MODEL_OPTIONS[agentId].some((model) => model.id === DEFAULT_MODEL_ID)
      ? FALLBACK_MODEL_OPTIONS[agentId]
      : [{ id: DEFAULT_MODEL_ID, label: "Default" }, ...FALLBACK_MODEL_OPTIONS[agentId]],
  };
}

export function applyProviderPresetToConfiguredAgent(agent: ConfiguredAgent, channel: AgentChannel, preset: AgentProviderPreset): ConfiguredAgent {
  return {
    ...agent,
    channelId: channel.id,
    runtimeAgentId: preset.runtimeAgentId,
    modelId: DEFAULT_MODEL_ID,
  };
}

export function applyProviderModelIdToAgentConfig(
  agent: ConfiguredAgent,
  channel: AgentChannel,
  rawModelId: string,
): { agent: ConfiguredAgent; channel: AgentChannel } {
  const modelId = rawModelId.trim();
  if (!modelId) {
    return {
      agent: { ...agent, modelId: DEFAULT_MODEL_ID },
      channel,
    };
  }

  const models = channel.models.some((model) => model.id === modelId)
    ? channel.models.map((model) => (model.id === modelId ? { ...model, label: model.label || modelId } : model))
    : [...channel.models, { id: modelId, label: modelId }];

  return {
    agent: { ...agent, modelId },
    channel: { ...channel, models },
  };
}

export function createConfiguredAgent(channels: AgentChannel[], existingIds: string[]): ConfiguredAgent {
  const runtimeAgentId: AgentId = "codex";
  const id = uniqueId("agent", existingIds);
  const channelId = defaultChannelForAgent(runtimeAgentId, channels);
  return {
    id,
    name: "New Agent",
    description: "",
    runtimeAgentId,
    channelId,
    modelId: DEFAULT_MODEL_ID,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createModel(existingModels: AgentModelOption[]): AgentModelOption {
  const id = uniqueId("model", existingModels.map((model) => model.id));
  return { id, label: id };
}

export function initialWorkflowMessages(): WorkflowGrillMessage[] {
  return [];
}

export function createWorkflowId(): string {
  const randomPart =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `wf_${randomPart}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function taskArtifact(task: TaskRun): string {
  const assistantMessage = [...task.messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
  if (assistantMessage) return assistantMessage.content.trim();
  const errorMessage = [...task.messages].reverse().find((message) => message.role === "error" && message.content.trim());
  if (errorMessage) return errorMessage.content.trim();
  return `${task.title} completed without assistant output.`;
}

function compactWorkflowActivity(content: string, limit = 140): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function workflowToolResultDisplayContent(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (/^Chunk ID:/i.test(trimmed)) return false;
    if (/^Wall time:/i.test(trimmed)) return false;
    if (/^Process exited with code\b/i.test(trimmed)) return false;
    if (/^Original token count:/i.test(trimmed)) return false;
    if (/^Output:$/i.test(trimmed)) return false;
    return true;
  });
  return filtered.join("\n").trim() || content;
}

export function workflowTaskLiveDetail(task: TaskRun): string {
  const latestEvent = task.messages
    .flatMap((message) => message.events ?? [])
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);

  if (latestEvent) {
    const name = latestEvent.name ?? "tool";
    const eventContent = latestEvent.type === "tool_result" ? workflowToolResultDisplayContent(latestEvent.content) : latestEvent.content;
    const content = compactWorkflowActivity(eventContent);
    if (latestEvent.type === "tool_call") return content ? `Tool ${name}: ${content}` : `Tool ${name} started`;
    if (latestEvent.type === "tool_result") return content ? `Tool ${name} done: ${content}` : `Tool ${name} done`;
    if (latestEvent.type === "system") return content ? `System: ${content}` : "System event";
    if (latestEvent.type === "handoff") return content ? `Handoff: ${content}` : "Handoff received";
    if (latestEvent.type === "error") return content ? `Error: ${content}` : "Agent error";
    return content || "Agent event";
  }

  const latestAssistant = [...task.messages].reverse().find((message) => message.role === "assistant" && message.content.trim());
  if (latestAssistant) return `Output: ${compactWorkflowActivity(latestAssistant.content)}`;
  if (task.runtimeConversation) return "Conversation linked";
  return "Starting agent...";
}

export interface WorkflowDraftPersistInput {
  workflowId: string;
  activeWorkflowId?: string | undefined;
  workflowIds: string[];
  objective: string;
  messages: WorkflowGrillMessage[];
  definitionReady: boolean;
  reply: string;
  error: string | undefined;
  runProgress: WorkflowRunProgressItem[];
  runContextDocument: string;
  contextDocument: string;
  finalReport: string;
  runtimeConversation?: RuntimeConversation;
}

export function workflowDraftShouldPersist(input: WorkflowDraftPersistInput): boolean {
  const hasContent = Boolean(
    input.objective.trim() ||
      input.messages.length > 0 ||
      input.definitionReady ||
      input.reply.trim() ||
      input.error ||
      input.runProgress.length > 0 ||
      input.runContextDocument.trim() ||
      input.contextDocument.trim() ||
      input.finalReport.trim() ||
      input.runtimeConversation,
  );
  return hasContent || input.activeWorkflowId === input.workflowId || input.workflowIds.includes(input.workflowId);
}

export interface BalanceRefreshInput {
  channels: AgentChannel[];
  configDirty: boolean;
  refreshInFlight: boolean;
  lastRefreshAt: number | undefined;
  now: number;
  intervalMs: number;
}

export function shouldRefreshBalances(input: BalanceRefreshInput): boolean {
  if (input.channels.length === 0) return false;
  if (input.configDirty) return false;
  if (input.refreshInFlight) return false;
  return input.lastRefreshAt === undefined || input.now - input.lastRefreshAt >= input.intervalMs;
}

function extractWorkflowSection(content: string, headings: string[]): string | undefined {
  const headingSet = new Set(headings.map((heading) => heading.toLowerCase()));
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let startIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const heading = match[1]!.trim().toLowerCase();
    if (headingSet.has(heading)) {
      startIndex = index + 1;
      break;
    }
  }
  if (startIndex < 0) return undefined;
  const sectionLines: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line)) break;
    sectionLines.push(line);
  }
  const section = sectionLines.join("\n").trim();
  return section || undefined;
}

function extractWorkflowHandoffSection(content: string): string | undefined {
  return extractWorkflowSection(content, ["handoff", "summary", "key context", "context"]);
}

function workflowStringField(content: string, field: string): string | undefined {
  const pattern = `["']?${field}["']?\\s*:\\s*("([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*'|\`([^\`\\\\]|\\\\.)*\`)`;
  const match = new RegExp(pattern, "s").exec(content);
  if (!match) return undefined;
  const raw = match[1]!;
  const body = raw.slice(1, -1);
  return body
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, `"`)
    .replace(/\\'/g, `'`)
    .replace(/\\`/g, "`")
    .replace(/\\\\/g, "\\")
    .trim();
}

export interface WorkflowJudgeResult {
  complete: boolean;
  reason: string;
  retryPrompt: string;
}

export function workflowArtifactSummary(artifact: string): string {
  const report = extractWorkflowSection(artifact, ["work completion report", "completion report"]);
  const handoff = extractWorkflowSection(artifact, ["handoff"]);
  if (report && handoff) {
    return truncateWorkflowContext(["### Work Completion Report", report, "", "### Handoff", handoff].join("\n"));
  }
  return truncateWorkflowContext(report ?? extractWorkflowHandoffSection(artifact) ?? artifact);
}

export function workflowContextDocumentFromArtifacts(artifacts: Array<{ nodeId: string; title: string; summary: string }>): string {
  if (artifacts.length === 0) return "";
  return [
    "# Workflow Context",
    "",
    ...artifacts.flatMap((artifact) => [`## ${artifact.title} (${artifact.nodeId})`, artifact.summary.trim() || "No handoff summary produced.", ""]),
  ]
    .join("\n")
    .trim();
}
