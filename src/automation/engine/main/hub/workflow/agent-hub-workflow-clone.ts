import { randomUUID } from "node:crypto";
import { DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE } from "../../../shared/types";
import type {
  ScheduledWorkflowRun,
  ScheduledWorkflowRunnerConfig,
  ScheduledWorkflowRunnerStatus,
  ScheduledWorkflowSchedule,
  ScheduledWorkflowStoreState,
} from "../../../shared/types";
import type { RuntimeConversation } from "../../../shared/runtime/conversation";
import type { WorkflowDraftState, WorkflowStoreState } from "../../../shared/workflow/draft";
import type { WorkflowRunProgressItem, WorkflowRunState, WorkflowStatus } from "../../../shared/workflow/run";
import {
  isScheduledWorkflowRunStatus,
  normalizeScheduledWorkflowDayOfMonth,
  normalizeScheduledWorkflowFrequency,
  normalizeScheduledWorkflowTimeOfDay,
  normalizeScheduledWorkflowWeekdays,
} from "../persisted/agent-hub-persistence";
import { cloneWorkflowV2Plan } from "../../../shared/workflow-v2/planning";

export function cloneWorkflowRunProgressItem(item: WorkflowRunProgressItem): WorkflowRunProgressItem {
  return {
    nodeId: item.nodeId,
    title: item.title,
    status: item.status,
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.taskId !== undefined ? { taskId: item.taskId } : {}),
    ...(item.intervention !== undefined ? { intervention: structuredClone(item.intervention) } : {}),
    ...(item.inputRequest !== undefined ? { inputRequest: structuredClone(item.inputRequest) } : {}),
    ...(item.inputSummary !== undefined ? { inputSummary: structuredClone(item.inputSummary) } : {}),
    ...(item.outputs !== undefined ? { outputs: structuredClone(item.outputs) } : {}),
    ...(item.messages !== undefined ? { messages: structuredClone(item.messages) } : {}),
    ...(item.telemetry !== undefined ? { telemetry: structuredClone(item.telemetry) } : {}),
  };
}

export function normalizeWorkflowStatus(status: WorkflowStatus): WorkflowStatus {
  return status === "running" || status === "waiting_for_user" || status === "completed" || status === "failed" || status === "stopped" ? status : "draft";
}

export function cloneWorkflowRun(run: WorkflowRunState): WorkflowRunState {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    status: run.status,
    workflowV2Plan: cloneWorkflowV2Plan(run.workflowV2Plan),
    progress: run.progress.map(cloneWorkflowRunProgressItem),
    events: run.events.map((event) => structuredClone(event)),
    contextDocument: run.contextDocument,
    ...(run.finalReport !== undefined ? { finalReport: run.finalReport } : {}),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError,
  };
}

export function cloneScheduledWorkflowRunnerConfig(config: ScheduledWorkflowRunnerConfig): ScheduledWorkflowRunnerConfig {
  return {
    baseUrl: config.baseUrl?.trim() ?? "",
    ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
    ...(config.userId !== undefined ? { userId: config.userId } : {}),
    ...(config.deviceName !== undefined ? { deviceName: config.deviceName } : {}),
    ...(config.deviceId !== undefined ? { deviceId: config.deviceId } : {}),
    ...(config.runnerToken !== undefined ? { runnerToken: config.runnerToken } : {}),
  };
}

export function cloneScheduledWorkflowSchedule(input: {
  schedule: ScheduledWorkflowSchedule;
  workflowTitle?: string;
  now?: number;
}): ScheduledWorkflowSchedule {
  const { schedule, workflowTitle, now = Date.now() } = input;
  return {
    scheduleId: schedule.scheduleId || `sched_${randomUUID()}`,
    workflowId: schedule.workflowId,
    title: schedule.title || workflowTitle || "Scheduled workflow",
    enabled: schedule.enabled !== false,
    intervalSeconds: Math.max(60, Math.floor(schedule.intervalSeconds || 3600)),
    frequency: normalizeScheduledWorkflowFrequency(schedule.frequency),
    timeOfDay: normalizeScheduledWorkflowTimeOfDay(schedule.timeOfDay),
    timezone: schedule.timezone?.trim() || DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
    ...(normalizeScheduledWorkflowWeekdays(schedule.weekdays) !== undefined ? { weekdays: normalizeScheduledWorkflowWeekdays(schedule.weekdays) } : {}),
    ...(normalizeScheduledWorkflowDayOfMonth(schedule.dayOfMonth) !== undefined ? { dayOfMonth: normalizeScheduledWorkflowDayOfMonth(schedule.dayOfMonth) } : {}),
    ...(schedule.nextRunAt !== undefined ? { nextRunAt: schedule.nextRunAt } : {}),
    ...(schedule.lastRunAt !== undefined ? { lastRunAt: schedule.lastRunAt } : {}),
    source: schedule.source === "local" ? "local" : "cloud",
    createdAt: Number.isFinite(schedule.createdAt) ? schedule.createdAt : now,
    updatedAt: Number.isFinite(schedule.updatedAt) ? schedule.updatedAt : now,
  };
}

export function cloneScheduledWorkflowRun(input: {
  run: ScheduledWorkflowRun;
  scheduleTitle?: string;
  now?: number;
}): ScheduledWorkflowRun {
  const { run, scheduleTitle, now = Date.now() } = input;
  return {
    runId: run.runId || `scheduled_run_${randomUUID()}`,
    scheduleId: run.scheduleId,
    workflowId: run.workflowId,
    ...(run.eventId !== undefined ? { eventId: run.eventId } : {}),
    ...(run.workflowRunId !== undefined ? { workflowRunId: run.workflowRunId } : {}),
    title: run.title || scheduleTitle || "Scheduled workflow",
    status: isScheduledWorkflowRunStatus(run.status) ? run.status : "failed",
    startedAt: Number.isFinite(run.startedAt) ? run.startedAt : now,
    finishedAt: run.finishedAt,
    ...(run.message !== undefined ? { message: run.message } : {}),
  };
}

export function cloneWorkflowDraft(input: {
  draft: WorkflowDraftState;
  normalizeConfiguredAgentId: (configuredAgentId: string | undefined) => string;
  normalizeModelId: (configuredAgentId: string | undefined, modelId: string | undefined) => string;
  cloneConversation: (conversation: RuntimeConversation) => RuntimeConversation;
  now?: number;
}): WorkflowDraftState {
  const { draft, normalizeConfiguredAgentId, normalizeModelId, cloneConversation, now = Date.now() } = input;
  return {
    workflowId: draft.workflowId || `wf_${randomUUID()}`,
    sourceType: draft.sourceType === "official" ? "official" : "user",
    topologyLocked: draft.sourceType === "official" || draft.topologyLocked === true,
    title: draft.title || draft.definition.objective || draft.objective || "Untitled workflow",
    status: normalizeWorkflowStatus(draft.status),
    revision: Number.isFinite(draft.revision) && draft.revision > 0 ? Math.floor(draft.revision) : 1,
    ...(Number.isFinite(draft.confirmedRevision) && draft.confirmedRevision === draft.revision
      ? { confirmedRevision: Math.floor(draft.confirmedRevision!) }
      : {}),
    configuredAgentId: normalizeConfiguredAgentId(draft.configuredAgentId),
    modelId: normalizeModelId(draft.configuredAgentId, draft.modelId),
    reviewerConfiguredAgentId: normalizeConfiguredAgentId(draft.reviewerConfiguredAgentId),
    reviewerModelId: normalizeModelId(draft.reviewerConfiguredAgentId, draft.reviewerModelId),
    objective: draft.objective,
    definition: structuredClone(draft.definition),
    ...(draft.workDir ? { workDir: draft.workDir } : {}),
    messages: draft.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.events ? { events: structuredClone(message.events) } : {}),
    })),
    reply: draft.reply,
    error: draft.error,
    runProgress: draft.runProgress.map(cloneWorkflowRunProgressItem),
    runContextDocument: draft.runContextDocument,
    contextDocument: draft.contextDocument,
    ...(draft.workflowV2Plan ? { workflowV2Plan: cloneWorkflowV2Plan(draft.workflowV2Plan) } : {}),
    ...(draft.generationReview ? { generationReview: structuredClone(draft.generationReview) } : {}),
    ...(draft.finalReport !== undefined ? { finalReport: draft.finalReport } : {}),
    runIds: draft.runIds.map((runId) => runId),
    ...(draft.runtimeConversation ? { runtimeConversation: cloneConversation(draft.runtimeConversation) } : {}),
    createdAt: draft.createdAt || draft.updatedAt || now,
    updatedAt: draft.updatedAt,
  };
}

export function cloneWorkflowStore(input: {
  activeWorkflowId: string | undefined;
  workflows: Iterable<WorkflowDraftState>;
  workflowRuns: Iterable<WorkflowRunState>;
  cloneDraft: (draft: WorkflowDraftState) => WorkflowDraftState;
  cloneRun: (run: WorkflowRunState) => WorkflowRunState;
}): WorkflowStoreState {
  const workflows = [...input.workflows];
  const workflowRuns = [...input.workflowRuns];
  return {
    activeWorkflowId: input.activeWorkflowId,
    workflows: workflows
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((workflow) => input.cloneDraft(workflow)),
    runs: workflowRuns
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((run) => input.cloneRun(run)),
  };
}

export function cloneScheduledWorkflowStore(input: {
  activeScheduleId: string | undefined;
  runnerConfig: ScheduledWorkflowRunnerConfig;
  runnerStatus: ScheduledWorkflowRunnerStatus;
  schedules: Iterable<ScheduledWorkflowSchedule>;
  runs: Iterable<ScheduledWorkflowRun>;
  cloneRunnerConfig: (config: ScheduledWorkflowRunnerConfig) => ScheduledWorkflowRunnerConfig;
  cloneSchedule: (schedule: ScheduledWorkflowSchedule) => ScheduledWorkflowSchedule;
  cloneRun: (run: ScheduledWorkflowRun) => ScheduledWorkflowRun;
}): ScheduledWorkflowStoreState {
  const schedules = [...input.schedules];
  const runs = [...input.runs];
  return {
    activeScheduleId: input.activeScheduleId,
    runnerConfig: input.cloneRunnerConfig(input.runnerConfig),
    runnerStatus: { ...input.runnerStatus },
    schedules: schedules
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((schedule) => input.cloneSchedule(schedule)),
    runs: runs
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((run) => input.cloneRun(run)),
  };
}
