import type {
  AckScheduledWorkflowEventRequest,
  ScheduledWorkflowDueEvent,
  ScheduledWorkflowRun,
  WorkflowOperationResult,
} from "../../../shared/types";
import type { WorkflowDraftState } from "../../../shared/workflow/draft";
import type { WorkflowRunState } from "../../../shared/workflow/run";

export function scheduledWorkflowEventTarget(
  event: ScheduledWorkflowDueEvent,
): { scheduleId: string; workflowId: string } | undefined {
  const scheduleId = optionalTrimmedString(event.payload?.scheduleId);
  const workflowId = optionalTrimmedString(event.payload?.workflowId);
  if (!scheduleId || !workflowId) return undefined;
  return { scheduleId, workflowId };
}

export function waitForWorkflowRunToSettle(input: {
  runId: string;
  getRun: (runId: string) => WorkflowRunState | undefined;
  cloneRun: (run: WorkflowRunState) => WorkflowRunState;
  onChange: (listener: () => void) => () => void;
}): Promise<WorkflowRunState> {
  const immediate = input.getRun(input.runId);
  if (immediate && isWorkflowRunSettled(immediate)) {
    return Promise.resolve(input.cloneRun(immediate));
  }

  return new Promise<WorkflowRunState>((resolve, reject) => {
    let stopListening: () => void = () => {};
    stopListening = input.onChange(() => {
      const run = input.getRun(input.runId);
      if (!run) {
        stopListening();
        reject(new Error(`Workflow run ${input.runId} was not found.`));
        return;
      }
      if (isWorkflowRunSettled(run)) {
        stopListening();
        resolve(input.cloneRun(run));
      }
    });
  });
}

export async function runScheduledWorkflowEvent(input: {
  event: ScheduledWorkflowDueEvent;
  ackEvent: (eventId: string, request: AckScheduledWorkflowEventRequest) => Promise<void>;
  target: { scheduleId: string; workflowId: string } | undefined;
  workflow: WorkflowDraftState | undefined;
  runId: string;
  recordScheduledWorkflowRun: (run: ScheduledWorkflowRun) => void;
  runWorkflow: (input: { workflowId: string; contextDocument?: string }) => WorkflowOperationResult;
  finishScheduledWorkflowRun: (
    runId: string,
    input: {
      status: AckScheduledWorkflowEventRequest["status"];
      workflowRunId?: string;
      message?: string;
      finishedAt?: number;
    },
  ) => void;
  waitForWorkflowRunToSettle: (runId: string) => Promise<WorkflowRunState>;
  now?: number;
}): Promise<void> {
  if (!input.target) {
    await input.ackEvent(input.event.eventId, {
      status: "failed",
      message: "Scheduled event payload is missing scheduleId or workflowId.",
    });
    return;
  }

  if (!input.workflow) {
    await input.ackEvent(input.event.eventId, {
      status: "failed",
      message: `Workflow ${input.target.workflowId} was not found locally.`,
    });
    return;
  }

  input.recordScheduledWorkflowRun({
    runId: input.runId,
    scheduleId: input.target.scheduleId,
    workflowId: input.workflow.workflowId,
    eventId: input.event.eventId,
    title: input.event.title || input.workflow.title,
    status: "running",
    startedAt: input.now ?? Date.now(),
    finishedAt: undefined,
    message: input.event.message || "Runner started workflow.",
  });

  const started = input.runWorkflow({
    workflowId: input.workflow.workflowId,
    contextDocument: input.workflow.contextDocument,
  });
  if (!started.ok || !started.runId) {
    const message = started.error || "Workflow failed to start.";
    input.finishScheduledWorkflowRun(input.runId, {
      status: "failed",
      message,
      finishedAt: Date.now(),
    });
    await input.ackEvent(input.event.eventId, {
      status: "failed",
      message,
    });
    return;
  }

  const workflowRun = await input.waitForWorkflowRunToSettle(started.runId);
  const summary = summarizeScheduledWorkflowRun(workflowRun);

  input.finishScheduledWorkflowRun(input.runId, {
    status: summary.status,
    workflowRunId: workflowRun.runId,
    message: summary.message,
    finishedAt: Date.now(),
  });
  await input.ackEvent(input.event.eventId, {
    status: summary.status,
    workflowRunId: workflowRun.runId,
    message: summary.message,
  });
}

function isWorkflowRunSettled(run: WorkflowRunState): boolean {
  return (
    run.status === "completed"
    || run.status === "failed"
    || run.status === "stopped"
    || run.progress.some((item) => item.status === "awaiting_input")
  );
}

function summarizeScheduledWorkflowRun(run: WorkflowRunState): {
  status: AckScheduledWorkflowEventRequest["status"];
  message: string;
} {
  const completed = run.status === "completed";
  const awaitingInput = run.progress.some((item) => item.status === "awaiting_input");
  return {
    status: completed ? "completed" : "failed",
    message: completed
      ? "Workflow completed."
      : awaitingInput
        ? "Workflow requires human input before it can finish."
        : run.lastError || (run.status === "stopped" ? "Workflow stopped before completion." : "Workflow failed."),
  };
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
