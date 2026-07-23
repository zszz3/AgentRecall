import type {
  AgentChannel,
  AgentId,
  ChatMessage,
  ChatRuntimeSessionState,
  ConfiguredAgent,
  RuntimeConversation,
} from "../../../shared/types";
import { defaultChannelForAgent, defaultModelForAgent, isModelForChannel } from "../../../shared/models";
import {
  asArray,
  asBoolean,
  asNumber,
  asOptionalString,
  asRecord,
  cloneRuntimeState,
  defaultRuntimeSessionCapabilities,
  isAgentId,
  isExecutionStyle,
  isRuntimeAttachmentState,
  isTaskProgress,
  isTaskRunStatus,
} from "./agent-hub-persistence";
import { normalizeRestoredMessages, restoreMessage } from "../state/agent-hub-restore";
import { titleFromPrompt } from "../chat/agent-hub-ui";
import { ChatState, TaskState } from "../state/agent-hub-state";
export {
  restoreTeamRunState,
  restoreTeamRunStep,
  restoreTeamState,
  type RestoreTeamRunStateDeps,
  type RestoreTeamRunStepDeps,
  type RestoreTeamStateDeps,
} from "./agent-hub-team-state-restore";

export interface RestoreConfiguredAgentDeps {
  channels: AgentChannel[];
  channelById: (channelId: string) => AgentChannel | undefined;
  defaultAgentId: AgentId;
}

export interface RestoreChatStateDeps {
  configuredAgentOrDefault: (configuredAgentId: string | undefined) => ConfiguredAgent | undefined;
  normalizeModelIdForConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelId: string | undefined,
    channelIdOverride?: string,
  ) => string;
  channelById: (channelId: string) => AgentChannel | undefined;
  restoreRuntimeConversation: (raw: unknown) => RuntimeConversation | undefined;
  cloneRuntimeConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  runtimeSupportsInteractiveChat: (runtimeAgentId: AgentId) => boolean;
  expirePendingInteractionEvents: (messages: ChatMessage[]) => ChatMessage[];
}

export interface RestoreTaskStateDeps {
  workDir: string;
  configuredAgentOrDefault: (configuredAgentId: string | undefined) => ConfiguredAgent | undefined;
  normalizeModelIdForConfiguredAgent: (
    configuredAgentId: string | undefined,
    modelId: string | undefined,
    channelIdOverride?: string,
  ) => string;
  restoreRuntimeConversation: (raw: unknown) => RuntimeConversation | undefined;
  cloneRuntimeConversation: (conversation: RuntimeConversation) => RuntimeConversation;
}

export function restoreConfiguredAgentState(
  raw: unknown,
  deps: RestoreConfiguredAgentDeps,
  now = Date.now(),
): ConfiguredAgent | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = asOptionalString(record.id)?.trim();
  const name = asOptionalString(record.name)?.trim();
  const runtimeAgentId = isAgentId(record.runtimeAgentId) ? record.runtimeAgentId : deps.defaultAgentId;
  if (!id || !name) return undefined;
  const fallbackChannelId = defaultChannelForAgent(runtimeAgentId, deps.channels);
  const channelId = asOptionalString(record.channelId);
  const normalizedChannelId = channelId && deps.channelById(channelId)?.agentId === runtimeAgentId ? channelId : fallbackChannelId;
  const modelId = asOptionalString(record.modelId);
  const normalizedModelId = modelId && isModelForChannel(runtimeAgentId, normalizedChannelId, modelId, deps.channels)
    ? modelId
    : defaultModelForAgent(runtimeAgentId);
  const model = deps.channelById(normalizedChannelId)?.models.find((item) => item.id === normalizedModelId);
  const reasoningEffort = asOptionalString(record.reasoningEffort);
  const agentType = record.agentType === "execution" || record.agentType === "composed"
    ? record.agentType
    : undefined;
  const instructions = asOptionalString(record.instructions);
  const baseAgentId = asOptionalString(record.baseAgentId)?.trim();
  const currentRevisionId = asOptionalString(record.currentRevisionId)?.trim();
  const revision = typeof record.revision === "number" && Number.isFinite(record.revision) && record.revision > 0
    ? Math.floor(record.revision)
    : undefined;
  const mcpBindings = asArray(record.mcpBindings).flatMap((rawBinding) => {
    const binding = asRecord(rawBinding);
    const serverId = asOptionalString(binding?.serverId)?.trim();
    if (!serverId) return [];
    const toolAllowlist = [...new Set(
      asArray(binding?.toolAllowlist)
        .map((tool) => asOptionalString(tool)?.trim())
        .filter((tool): tool is string => Boolean(tool)),
    )];
    return [{ serverId, toolAllowlist }];
  });
  return {
    id,
    ...(agentType ? { agentType } : {}),
    name,
    description: asOptionalString(record.description) ?? "",
    ...(instructions !== undefined ? { instructions } : {}),
    ...(baseAgentId ? { baseAgentId } : {}),
    runtimeAgentId,
    channelId: normalizedChannelId,
    modelId: normalizedModelId,
    ...(reasoningEffort && model?.reasoningEfforts?.includes(reasoningEffort) ? { reasoningEffort } : {}),
    ...(mcpBindings.length > 0 ? { mcpBindings } : {}),
    tags: asArray(record.tags).map((tag) => asOptionalString(tag)).filter((tag): tag is string => Boolean(tag)),
    ...(currentRevisionId ? { currentRevisionId } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(record.managed === true ? { managed: true } : {}),
    createdAt: asNumber(record.createdAt, now),
    updatedAt: asNumber(record.updatedAt, now),
  };
}

export function restoreRuntimeState(raw: unknown): ChatRuntimeSessionState | undefined {
  const record = asRecord(raw);
  if (!record || !isExecutionStyle(record.executionStyle) || !isRuntimeAttachmentState(record.attachmentState)) return undefined;
  const capabilitiesRecord = asRecord(record.capabilities);
  const capabilities = defaultRuntimeSessionCapabilities();
  if (capabilitiesRecord) {
    capabilities.supportsInProcessConversationResume = asBoolean(capabilitiesRecord.supportsInProcessConversationResume);
    capabilities.supportsResumeAfterDetach = asBoolean(capabilitiesRecord.supportsResumeAfterDetach);
    capabilities.supportsResumeAfterAppRestart = asBoolean(capabilitiesRecord.supportsResumeAfterAppRestart);
    capabilities.supportsTurnResume = asBoolean(capabilitiesRecord.supportsTurnResume);
    capabilities.supportsInterrupt = asBoolean(capabilitiesRecord.supportsInterrupt);
    capabilities.supportsContinue = asBoolean(capabilitiesRecord.supportsContinue);
    capabilities.supportsApprovalRequests = asBoolean(capabilitiesRecord.supportsApprovalRequests);
    capabilities.supportsUserInputRequests = asBoolean(capabilitiesRecord.supportsUserInputRequests);
  }
  const restored: ChatRuntimeSessionState = {
    executionStyle: record.executionStyle,
    attachmentState: record.attachmentState,
    attachmentGeneration: Math.max(0, Math.floor(asNumber(record.attachmentGeneration, 0))),
    capabilities,
  };
  const activeTurnId = asOptionalString(record.activeTurnId);
  if (activeTurnId) restored.activeTurnId = activeTurnId;
  if (typeof record.lastMeaningfulActivityAt === "number") {
    restored.lastMeaningfulActivityAt = record.lastMeaningfulActivityAt;
  }
  return restored;
}

export function restoreChatState(raw: unknown, deps: RestoreChatStateDeps): ChatState | null {
  const record = asRecord(raw);
  if (!record || "sessionId" in record || "runtimeSession" in record) return null;

  const now = Date.now();
  const configuredAgent = deps.configuredAgentOrDefault(asOptionalString(record.configuredAgentId));
  if (!configuredAgent) return null;
  const chat = new ChatState(
    configuredAgent.id,
    deps.normalizeModelIdForConfiguredAgent(configuredAgent.id, asOptionalString(record.modelId) ?? configuredAgent.modelId),
    configuredAgent.name || "New Chat",
  );
  const channelId = asOptionalString(record.channelId);
  chat.channelId =
    channelId && deps.channelById(channelId)?.agentId === configuredAgent.runtimeAgentId
      ? channelId
      : undefined;
  chat.modelId = deps.normalizeModelIdForConfiguredAgent(
    configuredAgent.id,
    asOptionalString(record.modelId) ?? configuredAgent.modelId,
    chat.channelId,
  );
  chat.id = asOptionalString(record.id) ?? chat.id;
  chat.title = asOptionalString(record.title) ?? (configuredAgent.name || "New Chat");
  chat.running = false;
  chat.pendingAssistantMessageId = undefined;
  chat.lastError = asOptionalString(record.lastError);
  chat.createdAt = asNumber(record.createdAt, now);
  chat.updatedAt = asNumber(record.updatedAt, chat.createdAt);
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message) => restoreMessage(message)).filter((message): message is ChatMessage => Boolean(message))
    : [];
  chat.messages = deps.expirePendingInteractionEvents(normalizeRestoredMessages(messages));
  const restoredRuntimeState = record.runtimeState === undefined ? undefined : restoreRuntimeState(record.runtimeState);
  if (record.runtimeState !== undefined && !restoredRuntimeState) return null;
  const restoredRuntimeConversation =
    record.runtimeConversation === undefined ? undefined : deps.restoreRuntimeConversation(record.runtimeConversation);
  if (record.runtimeConversation !== undefined && !restoredRuntimeConversation) return null;
  if (restoredRuntimeState && deps.runtimeSupportsInteractiveChat(configuredAgent.runtimeAgentId)) {
    chat.runtimeState = {
      ...cloneRuntimeState(restoredRuntimeState),
      attachmentState: "detached",
      attachmentGeneration: 0,
    };
    delete chat.runtimeState.activeTurnId;
  }
  chat.runtimeConversation = restoredRuntimeConversation ? deps.cloneRuntimeConversation(restoredRuntimeConversation) : undefined;
  return chat;
}

export function restoreTaskState(raw: unknown, deps: RestoreTaskStateDeps): TaskState | null {
  const record = asRecord(raw);
  if (!record || "sessionId" in record || typeof record.prompt !== "string") return null;

  const configuredAgent = deps.configuredAgentOrDefault(asOptionalString(record.configuredAgentId));
  if (!configuredAgent) return null;
  const now = Date.now();
  const task = new TaskState(
    record.prompt,
    configuredAgent.id,
    deps.normalizeModelIdForConfiguredAgent(configuredAgent.id, asOptionalString(record.modelId) ?? configuredAgent.modelId),
    asOptionalString(record.workDir) ?? deps.workDir,
  );
  task.id = asOptionalString(record.id) ?? task.id;
  task.developerInstructions = asOptionalString(record.developerInstructions);
  task.contextDocument = asOptionalString(record.contextDocument);
  task.title = asOptionalString(record.title) ?? titleFromPrompt(record.prompt);
  task.progress = isTaskProgress(record.progress) ? record.progress : "todo";
  const status = isTaskRunStatus(record.status) ? record.status : "completed";
  task.status = status === "running" ? "failed" : status;
  task.running = false;
  task.pendingAssistantMessageId = undefined;
  task.lastError = asOptionalString(record.lastError);
  task.createdAt = asNumber(record.createdAt, now);
  task.updatedAt = asNumber(record.updatedAt, task.createdAt);
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message) => restoreMessage(message)).filter((message): message is ChatMessage => Boolean(message))
    : [];
  task.messages = normalizeRestoredMessages(messages);
  const restoredRuntimeConversation =
    record.runtimeConversation === undefined ? undefined : deps.restoreRuntimeConversation(record.runtimeConversation);
  if (record.runtimeConversation !== undefined && !restoredRuntimeConversation) return null;
  task.runtimeConversation = restoredRuntimeConversation ? deps.cloneRuntimeConversation(restoredRuntimeConversation) : undefined;
  const usage = record.usage;
  if (usage && typeof usage === "object") task.usage = structuredClone(usage) as TaskState["usage"];
  return task;
}
