import { randomUUID } from "node:crypto";
import {
  DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY,
  DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
} from "../../../shared/types";
import type {
  ScheduledWorkflowOperationResult,
  ScheduledWorkflowRun,
  ScheduledWorkflowRunStatus,
  ScheduledWorkflowRunnerConfig,
  ScheduledWorkflowRunnerStatus,
  ScheduledWorkflowSchedule,
} from "../../../shared/types";

function latestScheduledWorkflowId(schedules: Iterable<ScheduledWorkflowSchedule>): string | undefined {
  let latest: ScheduledWorkflowSchedule | undefined;
  for (const schedule of schedules) {
    if (!latest || schedule.createdAt > latest.createdAt) latest = schedule;
  }
  return latest?.scheduleId;
}

export function saveScheduledWorkflowRunnerConfig(
  config: ScheduledWorkflowRunnerConfig,
  cloneConfig: (config: ScheduledWorkflowRunnerConfig) => ScheduledWorkflowRunnerConfig,
): ScheduledWorkflowRunnerConfig {
  return cloneConfig(config);
}

export function updateScheduledWorkflowRunnerStatus(
  current: ScheduledWorkflowRunnerStatus,
  status: Partial<ScheduledWorkflowRunnerStatus>,
): ScheduledWorkflowRunnerStatus {
  return {
    ...current,
    ...status,
  };
}

export function selectScheduledWorkflowId(input: {
  scheduleId: string;
  hasSchedule: (scheduleId: string) => boolean;
  activeScheduleId: string | undefined;
}): string | undefined {
  return input.hasSchedule(input.scheduleId) ? input.scheduleId : input.activeScheduleId;
}

export function upsertScheduledWorkflowSchedule(input: {
  schedule: ScheduledWorkflowSchedule;
  current: ScheduledWorkflowSchedule | undefined;
  hasWorkflow: boolean;
  workflowTitle: string | undefined;
  cloneSchedule: (schedule: ScheduledWorkflowSchedule) => ScheduledWorkflowSchedule;
  now?: number;
}): (ScheduledWorkflowOperationResult & { schedule?: ScheduledWorkflowSchedule }) {
  if (!input.hasWorkflow) {
    return {
      ok: false,
      error: `Workflow ${input.schedule.workflowId} was not found.`,
    };
  }
  const now = input.now ?? Date.now();
  const schedule = input.cloneSchedule({
    ...input.schedule,
    scheduleId: input.schedule.scheduleId || `sched_${randomUUID()}`,
    title: input.schedule.title.trim() || input.workflowTitle || "Scheduled workflow",
    intervalSeconds: Math.max(60, Math.floor(input.schedule.intervalSeconds || input.current?.intervalSeconds || 3600)),
    frequency: input.schedule.frequency ?? input.current?.frequency ?? "daily",
    timeOfDay: input.schedule.timeOfDay ?? input.current?.timeOfDay ?? DEFAULT_SCHEDULED_WORKFLOW_TIME_OF_DAY,
    timezone: input.schedule.timezone ?? input.current?.timezone ?? DEFAULT_SCHEDULED_WORKFLOW_TIMEZONE,
    ...(input.schedule.weekdays !== undefined || input.current?.weekdays !== undefined
      ? { weekdays: input.schedule.weekdays ?? input.current?.weekdays }
      : {}),
    ...(input.schedule.dayOfMonth !== undefined || input.current?.dayOfMonth !== undefined
      ? { dayOfMonth: input.schedule.dayOfMonth ?? input.current?.dayOfMonth }
      : {}),
    source: input.schedule.source ?? input.current?.source ?? "cloud",
    createdAt: input.schedule.createdAt || input.current?.createdAt || now,
    updatedAt: input.schedule.updatedAt || now,
  });
  return { ok: true, scheduleId: schedule.scheduleId, schedule };
}

export function replaceScheduledWorkflowSchedules(input: {
  schedules: ScheduledWorkflowSchedule[];
  hasWorkflow: (workflowId: string) => boolean;
  cloneSchedule: (schedule: ScheduledWorkflowSchedule) => ScheduledWorkflowSchedule;
  activeScheduleId: string | undefined;
}): {
  schedules: Map<string, ScheduledWorkflowSchedule>;
  activeScheduleId: string | undefined;
} {
  const nextSchedules = new Map<string, ScheduledWorkflowSchedule>();
  for (const schedule of input.schedules) {
    if (!input.hasWorkflow(schedule.workflowId)) continue;
    const normalized = input.cloneSchedule(schedule);
    nextSchedules.set(normalized.scheduleId, normalized);
  }
  let activeScheduleId = input.activeScheduleId;
  if (activeScheduleId && !nextSchedules.has(activeScheduleId)) {
    activeScheduleId = undefined;
  }
  activeScheduleId ??= latestScheduledWorkflowId(nextSchedules.values());
  return {
    schedules: nextSchedules,
    activeScheduleId,
  };
}

export function deleteScheduledWorkflowSchedule(input: {
  scheduleId: string;
  schedules: Map<string, ScheduledWorkflowSchedule>;
  activeScheduleId: string | undefined;
}): {
  deleted: boolean;
  activeScheduleId: string | undefined;
} {
  if (!input.schedules.has(input.scheduleId)) {
    return {
      deleted: false,
      activeScheduleId: input.activeScheduleId,
    };
  }
  input.schedules.delete(input.scheduleId);
  const activeScheduleId =
    input.activeScheduleId === input.scheduleId
    || (input.activeScheduleId && !input.schedules.has(input.activeScheduleId))
      ? latestScheduledWorkflowId(input.schedules.values())
      : input.activeScheduleId;
  return {
    deleted: true,
    activeScheduleId,
  };
}

export function recordScheduledWorkflowRun(input: {
  run: ScheduledWorkflowRun;
  hasWorkflow: boolean;
  scheduleTitle: string | undefined;
  workflowTitle: string | undefined;
  cloneRun: (run: ScheduledWorkflowRun) => ScheduledWorkflowRun;
  now?: number;
}): ScheduledWorkflowRun | undefined {
  if (!input.hasWorkflow) return undefined;
  const now = input.now ?? Date.now();
  return input.cloneRun({
    ...input.run,
    runId: input.run.runId || `scheduled_run_${randomUUID()}`,
    title: input.run.title.trim() || input.scheduleTitle || input.workflowTitle || "Scheduled workflow",
    status: input.run.status || "running",
    startedAt: input.run.startedAt || now,
    finishedAt: input.run.finishedAt,
  });
}

export function finishScheduledWorkflowRun(input: {
  run: ScheduledWorkflowRun | undefined;
  update: {
    status: Exclude<ScheduledWorkflowRunStatus, "queued" | "running">;
    workflowRunId?: string;
    message?: string;
    finishedAt?: number;
  };
  cloneRun: (run: ScheduledWorkflowRun) => ScheduledWorkflowRun;
  now?: number;
}): ScheduledWorkflowRun | undefined {
  if (!input.run) return undefined;
  return input.cloneRun({
    ...input.run,
    status: input.update.status,
    ...(input.update.workflowRunId !== undefined ? { workflowRunId: input.update.workflowRunId } : {}),
    ...(input.update.message !== undefined ? { message: input.update.message } : {}),
    finishedAt: input.update.finishedAt ?? input.now ?? Date.now(),
  });
}
