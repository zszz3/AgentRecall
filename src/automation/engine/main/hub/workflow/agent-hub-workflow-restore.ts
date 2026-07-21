import { randomUUID } from "node:crypto";
import { DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE } from "../../../shared/types";
import type {
  ScheduledWorkflowRun,
  ScheduledWorkflowRunnerConfig,
  ScheduledWorkflowSchedule,
  ScheduledWorkflowStoreState,
  WorkflowV2Plan,
} from "../../../shared/types";
import type { RuntimeConversation } from "../../../shared/runtime/conversation";
import type { WorkflowDraftState, WorkflowStoreState } from "../../../shared/workflow/draft";
import type {
  WorkflowEvent,
  WorkflowRunProgressItem,
  WorkflowRunState,
} from "../../../shared/workflow/run";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  isScheduledWorkflowRunStatus,
  isWorkflowDraftMessageRole,
  normalizeScheduledWorkflowDayOfMonth,
  normalizeScheduledWorkflowFrequency,
  normalizeScheduledWorkflowTimeOfDay,
  normalizeScheduledWorkflowWeekdays,
} from "../persisted/agent-hub-persistence";
import {
  restoreWorkflowDraftStatus,
  restoreWorkflowEvent,
  restoreWorkflowRunProgressItem,
  restoreWorkflowRunStatus,
} from "../state/agent-hub-restore";
import { cloneWorkflowV2Plan } from "../../../shared/workflow-v2/planning";
import type { WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { validateWorkflowV2Definition } from "../../../shared/workflow-v2/validation";
import type { WorkflowV2PersistedRunState } from "../../../shared/workflow-v2/storage";
import type { WorkflowV2RunNodeState } from "../../../shared/workflow-v2/state";
import { buildWorkflowV2FinalReport } from "../../workflows/v2/workflow-v2-recovery";
import { projectWorkflowV2PausedNodeInteraction } from "../../workflows/v2/workflow-v2-node-interaction";

function restoreWorkflowV2Plan(raw: unknown): WorkflowV2Plan | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (!asOptionalString(record.workflowId) || !asOptionalString(record.objective) || typeof record.graphVersion !== "number") {
    return undefined;
  }
  try {
    return cloneWorkflowV2Plan(record as unknown as WorkflowV2Plan);
  } catch {
    return undefined;
  }
}

export function restoreScheduledWorkflowRunnerConfig(
  raw: unknown,
  cloneRunnerConfig: (config: ScheduledWorkflowRunnerConfig) => ScheduledWorkflowRunnerConfig,
): ScheduledWorkflowRunnerConfig | undefined {
  const configRecord = asRecord(raw);
  if (!configRecord) return undefined;
  return cloneRunnerConfig({
    baseUrl: asOptionalString(configRecord.baseUrl) ?? "",
    ...(asOptionalString(configRecord.tenantId) !== undefined ? { tenantId: asOptionalString(configRecord.tenantId) } : {}),
    ...(asOptionalString(configRecord.userId) !== undefined ? { userId: asOptionalString(configRecord.userId) } : {}),
    ...(asOptionalString(configRecord.deviceName) !== undefined ? { deviceName: asOptionalString(configRecord.deviceName) } : {}),
    ...(asOptionalString(configRecord.deviceId) !== undefined ? { deviceId: asOptionalString(configRecord.deviceId) } : {}),
    ...(asOptionalString(configRecord.runnerToken) !== undefined ? { runnerToken: asOptionalString(configRecord.runnerToken) } : {}),
  });
}

export function restoreScheduledWorkflowSchedule(
  raw: unknown,
  deps: {
    hasWorkflow: (workflowId: string) => boolean;
    workflowTitle: (workflowId: string) => string | undefined;
    cloneScheduledWorkflowSchedule: (schedule: ScheduledWorkflowSchedule) => ScheduledWorkflowSchedule;
  },
): ScheduledWorkflowSchedule | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const scheduleId = asOptionalString(record.scheduleId);
  const workflowId = asOptionalString(record.workflowId);
  if (!scheduleId || !workflowId || !deps.hasWorkflow(workflowId)) return undefined;
  return deps.cloneScheduledWorkflowSchedule({
    scheduleId,
    workflowId,
    title: asOptionalString(record.title) ?? deps.workflowTitle(workflowId) ?? "Scheduled workflow",
    enabled: record.enabled !== false,
    intervalSeconds: Math.max(60, Math.floor(asNumber(record.intervalSeconds, 3600))),
    frequency: normalizeScheduledWorkflowFrequency(record.frequency ?? record.scheduleType),
    timeOfDay: normalizeScheduledWorkflowTimeOfDay(record.timeOfDay),
    timezone: asOptionalString(record.timezone)?.trim() || DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
    ...(normalizeScheduledWorkflowWeekdays(record.weekdays) !== undefined ? { weekdays: normalizeScheduledWorkflowWeekdays(record.weekdays) } : {}),
    ...(normalizeScheduledWorkflowDayOfMonth(record.dayOfMonth) !== undefined ? { dayOfMonth: normalizeScheduledWorkflowDayOfMonth(record.dayOfMonth) } : {}),
    ...(typeof record.nextRunAt === "number" ? { nextRunAt: record.nextRunAt } : {}),
    ...(typeof record.lastRunAt === "number" ? { lastRunAt: record.lastRunAt } : {}),
    source: record.source === "local" ? "local" : "cloud",
    createdAt: asNumber(record.createdAt, Date.now()),
    updatedAt: asNumber(record.updatedAt, Date.now()),
  });
}

export function restoreScheduledWorkflowRun(
  raw: unknown,
  deps: {
    hasWorkflow: (workflowId: string) => boolean;
    scheduledWorkflowTitle: (scheduleId: string) => string | undefined;
    cloneScheduledWorkflowRun: (run: ScheduledWorkflowRun) => ScheduledWorkflowRun;
  },
): ScheduledWorkflowRun | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const runId = asOptionalString(record.runId);
  const scheduleId = asOptionalString(record.scheduleId);
  const workflowId = asOptionalString(record.workflowId);
  if (!runId || !scheduleId || !workflowId || !deps.hasWorkflow(workflowId)) return undefined;
  const status = isScheduledWorkflowRunStatus(record.status) ? record.status : "failed";
  return deps.cloneScheduledWorkflowRun({
    runId,
    scheduleId,
    workflowId,
    ...(asOptionalString(record.eventId) !== undefined ? { eventId: asOptionalString(record.eventId) } : {}),
    ...(asOptionalString(record.workflowRunId) !== undefined ? { workflowRunId: asOptionalString(record.workflowRunId) } : {}),
    title: asOptionalString(record.title) ?? deps.scheduledWorkflowTitle(scheduleId) ?? "Scheduled workflow",
    status: status === "running" || status === "queued" ? "failed" : status,
    startedAt: asNumber(record.startedAt, Date.now()),
    finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
    ...((asOptionalString(record.message) ?? (status === "running" || status === "queued" ? "Interrupted before app restart" : undefined)) !== undefined
      ? { message: asOptionalString(record.message) ?? "Interrupted before app restart" }
      : {}),
  });
}

export function restoreWorkflowDraft(
  raw: unknown,
  deps: {
    restoreRuntimeConversation: (rawConversation: unknown) => RuntimeConversation | undefined;
    cloneWorkflowDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  },
): WorkflowDraftState | undefined {
  const record = asRecord(raw);
  if (!record || "agentSessionId" in record) return undefined;
  const definitionRecord = asRecord(record.definition);
  if (!definitionRecord) return undefined;
  const definition = structuredClone(definitionRecord) as unknown as WorkflowV2Definition;
  const workflowId = asOptionalString(record.workflowId) ?? definition.workflowId;
  const planningDraft = restoreWorkflowDraftStatus(record.status) === "draft"
    && Array.isArray(definition.nodes)
    && definition.nodes.length === 0
    && Array.isArray(definition.edges)
    && definition.edges.length === 0
    && typeof definition.workflowId === "string"
    && definition.workflowId === workflowId
    && Number.isSafeInteger(definition.graphVersion)
    && definition.graphVersion > 0
    && typeof definition.objective === "string";
  if (!planningDraft && !validateWorkflowV2Definition(definition).valid) return undefined;
  const finalReport = asOptionalString(record.finalReport);
  const restoredRuntimeConversation = record.runtimeConversation === undefined
    ? undefined
    : deps.restoreRuntimeConversation(record.runtimeConversation);
  if (record.runtimeConversation !== undefined && !restoredRuntimeConversation) return undefined;
  const restoredWorkflowV2Plan = record.workflowV2Plan === undefined
    ? undefined
    : restoreWorkflowV2Plan(record.workflowV2Plan);
  if (record.workflowV2Plan !== undefined && !restoredWorkflowV2Plan) return undefined;
  if (workflowId !== definition.workflowId) return undefined;
  return deps.cloneWorkflowDraft({
    workflowId,
    sourceType: record.sourceType === "official" ? "official" : "user",
    topologyLocked: record.sourceType === "official" || record.topologyLocked === true,
    title: asOptionalString(record.title) ?? definition.objective ?? "Untitled workflow",
    status: restoreWorkflowDraftStatus(record.status),
    revision: Math.max(1, Math.floor(asNumber(record.revision, 1))),
    configuredAgentId: asOptionalString(record.configuredAgentId) ?? "",
    modelId: asOptionalString(record.modelId) ?? "",
    reviewerConfiguredAgentId: asOptionalString(record.reviewerConfiguredAgentId) ?? asOptionalString(record.configuredAgentId) ?? "",
    reviewerModelId: asOptionalString(record.reviewerModelId) ?? asOptionalString(record.modelId) ?? "",
    objective: asOptionalString(record.objective) ?? definition.objective,
    definition,
    ...(asOptionalString(record.workDir) ? { workDir: asOptionalString(record.workDir) as string } : {}),
    messages: asArray(record.messages)
      .map((message) => {
        const messageRecord = asRecord(message);
        if (!messageRecord || !isWorkflowDraftMessageRole(messageRecord.role)) return undefined;
        return {
          id: asOptionalString(messageRecord.id) ?? randomUUID(),
          role: messageRecord.role,
          content: asOptionalString(messageRecord.content) ?? "",
        };
      })
      .filter((message): message is WorkflowDraftState["messages"][number] => Boolean(message)),
    reply: asOptionalString(record.reply) ?? "",
    error: asOptionalString(record.error),
    runProgress: asArray(record.runProgress)
      .map((item) => restoreWorkflowRunProgressItem(item))
      .filter((item): item is WorkflowRunProgressItem => Boolean(item)),
    runContextDocument: asOptionalString(record.runContextDocument) ?? "",
    contextDocument: asOptionalString(record.contextDocument) ?? "",
    ...(restoredWorkflowV2Plan ? { workflowV2Plan: restoredWorkflowV2Plan } : {}),
    ...(finalReport !== undefined ? { finalReport } : {}),
    runIds: asArray(record.runIds).map((runId) => asOptionalString(runId)).filter((runId): runId is string => Boolean(runId)),
    ...(restoredRuntimeConversation ? { runtimeConversation: restoredRuntimeConversation } : {}),
    createdAt: asNumber(record.createdAt, Date.now()),
    updatedAt: asNumber(record.updatedAt, Date.now()),
  });
}

export function restoreWorkflowRun(raw: unknown): WorkflowRunState | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const runId = asOptionalString(record.runId);
  const workflowId = asOptionalString(record.workflowId);
  if (!runId || !workflowId) return undefined;
  const finalReport = asOptionalString(record.finalReport);
  const restoredWorkflowV2Plan =
    record.workflowV2Plan === undefined ? undefined : restoreWorkflowV2Plan(record.workflowV2Plan);
  if (!restoredWorkflowV2Plan) return undefined;
  return {
    runId,
    workflowId,
    status: restoreWorkflowRunStatus(record.status),
    workflowV2Plan: restoredWorkflowV2Plan,
    progress: asArray(record.progress)
      .map((item) => restoreWorkflowRunProgressItem(item))
      .filter((item): item is WorkflowRunProgressItem => Boolean(item)),
    events: asArray(record.events)
      .map((event) => restoreWorkflowEvent(event))
      .filter((event): event is WorkflowEvent => Boolean(event)),
    contextDocument: asOptionalString(record.contextDocument) ?? "",
    ...(finalReport !== undefined ? { finalReport } : {}),
    startedAt: asNumber(record.startedAt, Date.now()),
    finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
    lastError: asOptionalString(record.lastError),
  };
}

export function reconcileWorkflowV2RunFromDurableState(input: {
  workflow: WorkflowDraftState;
  run: WorkflowRunState;
  persisted: WorkflowV2PersistedRunState;
  updateWorkflowProjection: boolean;
}): { workflow: WorkflowDraftState; run: WorkflowRunState } | undefined {
  if (input.persisted.workflowId !== input.workflow.workflowId
    || input.persisted.workflowId !== input.run.workflowId
    || input.persisted.runId !== input.run.runId
    || !input.run.workflowV2Plan
    || input.run.workflowV2Plan.graphVersion !== input.persisted.graphVersion) {
    return undefined;
  }

  const outputByNodeId = new Map(input.persisted.workerOutputs.map((output) => [output.nodeId, output]));
  const progress = input.persisted.runState.nodeOrder.map((nodeId): WorkflowRunProgressItem => {
    const node = input.persisted.runState.nodes[nodeId]!;
    const definitionNode = input.persisted.plan.definition.nodes.find((candidate) => candidate.id === nodeId);
    const progressItem: WorkflowRunProgressItem = {
      nodeId,
      title: node.title,
      status: publicWorkflowV2NodeStatus(node),
      detail: publicWorkflowV2NodeDetail(node, outputByNodeId.get(nodeId)?.summary),
    };
    const output = outputByNodeId.get(nodeId);
    if (output) progressItem.outputs = structuredClone(output.outputs);
    if (node.intervention) {
      Object.assign(progressItem, projectWorkflowV2PausedNodeInteraction({
        nodeId,
        interactiveAgent: definitionNode?.execModel === "llm" && definitionNode.executionMode === "interactive",
        intervention: node.intervention,
        ...(input.persisted.nodeControl[nodeId] ? { control: input.persisted.nodeControl[nodeId] } : {}),
      }).progress);
    }
    return progressItem;
  });
  const events = [...input.run.events];
  for (const nodeId of input.persisted.runState.nodeOrder) {
    const intervention = input.persisted.runState.nodes[nodeId]?.intervention;
    if (!intervention) continue;
    const alreadyProjected = events.some((event) => event.type === "node_paused"
      && event.nodeId === nodeId
      && event.at === intervention.requestedAt);
    if (!alreadyProjected) {
      events.push({
        type: "node_paused",
        nodeId,
        at: intervention.requestedAt,
        detail: intervention.reason,
        intervention: structuredClone(intervention),
      });
    }
  }

  const durableStatus = input.persisted.runState.status;
  const status = durableStatus === "completed"
    ? "completed"
    : durableStatus === "failed"
      ? "failed"
      : "waiting_for_user";
  const finalReport = status === "completed" || status === "failed"
    ? buildWorkflowV2FinalReport(input.persisted.plan, input.persisted.workerOutputs, durableStatus)
    : undefined;
  const lastError = status === "failed"
    ? progress.find((item) => item.status === "failed")?.detail ?? "Workflow V2 run failed before app restart."
    : undefined;
  const nextRun: WorkflowRunState = {
    ...input.run,
    status,
    progress,
    events,
    finishedAt: status === "completed" || status === "failed" ? input.persisted.savedAt : undefined,
    lastError,
  };
  if (finalReport !== undefined) nextRun.finalReport = finalReport;
  else delete nextRun.finalReport;

  if (!input.updateWorkflowProjection) return { workflow: input.workflow, run: nextRun };
  const nextWorkflow: WorkflowDraftState = {
    ...input.workflow,
    status,
    runProgress: structuredClone(progress),
    error: lastError,
    updatedAt: Math.max(input.workflow.updatedAt, input.persisted.savedAt),
  };
  if (finalReport !== undefined) nextWorkflow.finalReport = finalReport;
  else delete nextWorkflow.finalReport;
  return { workflow: nextWorkflow, run: nextRun };
}

function publicWorkflowV2NodeStatus(node: WorkflowV2RunNodeState): WorkflowRunProgressItem["status"] {
  if (node.status === "completed" || node.status === "skipped") return "completed";
  if (node.status === "failed") return "failed";
  if (node.status === "paused" || node.status === "running" || node.status === "validating" || node.status === "awaiting_review") {
    return "paused";
  }
  return "queued";
}

function publicWorkflowV2NodeDetail(node: WorkflowV2RunNodeState, outputSummary: string | undefined): string {
  if (node.status === "completed") return outputSummary ?? "Completed before app restart";
  if (node.status === "skipped") return "Skipped before app restart";
  if (node.status === "failed") return node.lastError ?? "Failed before app restart";
  if (node.status === "paused") {
    return node.intervention?.reason ?? node.lastError ?? "Paused with durable recovery state";
  }
  if (node.status === "running" || node.status === "validating" || node.status === "awaiting_review") {
    return "Interrupted before app restart; durable recovery is available";
  }
  return "Queued for recovery";
}

export function restoreWorkflowStoreCollections(
  rawStore: unknown,
  deps: {
    restoreWorkflowDraft: (raw: unknown) => WorkflowDraftState | undefined;
    restoreWorkflowRun: (raw: unknown) => WorkflowRunState | undefined;
  },
): WorkflowStoreState | undefined {
  if (rawStore === undefined) {
    return {
      activeWorkflowId: undefined,
      workflows: [],
      runs: [],
    };
  }
  const storeRecord = asRecord(rawStore);
  if (!storeRecord) return undefined;

  const workflows: WorkflowDraftState[] = [];
  for (const item of asArray(storeRecord.workflows)) {
    const workflow = deps.restoreWorkflowDraft(item);
    if (workflow) workflows.push(workflow);
  }

  const runs: WorkflowRunState[] = [];
  for (const item of asArray(storeRecord.runs)) {
    const run = deps.restoreWorkflowRun(item);
    if (run && workflows.some((workflow) => workflow.workflowId === run.workflowId)) runs.push(run);
  }

  const activeWorkflowId = asOptionalString(storeRecord.activeWorkflowId);
  return {
    activeWorkflowId:
      activeWorkflowId && workflows.some((workflow) => workflow.workflowId === activeWorkflowId)
        ? activeWorkflowId
        : [...workflows].sort((left, right) => right.updatedAt - left.updatedAt)[0]?.workflowId,
    workflows,
    runs,
  };
}

export function restoreScheduledWorkflowStoreCollections(
  rawStore: unknown,
  deps: {
    restoreRunnerConfig: (raw: unknown) => ScheduledWorkflowRunnerConfig | undefined;
    restoreSchedule: (raw: unknown) => ScheduledWorkflowSchedule | undefined;
    restoreRun: (raw: unknown) => ScheduledWorkflowRun | undefined;
  },
): ScheduledWorkflowStoreState {
  const storeRecord = asRecord(rawStore);
  const schedules: ScheduledWorkflowSchedule[] = [];
  const runs: ScheduledWorkflowRun[] = [];

  if (storeRecord) {
    for (const item of asArray(storeRecord.schedules)) {
      const schedule = deps.restoreSchedule(item);
      if (schedule) schedules.push(schedule);
    }
    for (const item of asArray(storeRecord.runs)) {
      const run = deps.restoreRun(item);
      if (run) runs.push(run);
    }
  }

  const activeScheduleId = asOptionalString(storeRecord?.activeScheduleId);
  return {
    activeScheduleId:
      activeScheduleId && schedules.some((schedule) => schedule.scheduleId === activeScheduleId)
        ? activeScheduleId
        : [...schedules].sort((left, right) => right.createdAt - left.createdAt)[0]?.scheduleId,
    runnerConfig: deps.restoreRunnerConfig(storeRecord?.runnerConfig) ?? { baseUrl: "" },
    runnerStatus: { connected: false, connecting: false },
    schedules,
    runs,
  };
}
