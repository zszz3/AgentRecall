import type { RunTaskRequest, TaskRun } from "../../../shared/types";
import type { RuntimeConversation } from "../../../shared/runtime/conversation";
import { mergeRuntimeUsage } from "../../../../../shared/runtime/usage";
import type { WorkflowEvent, WorkflowRunNodeTelemetry, WorkflowRunProgressItem } from "../../../shared/workflow/run";
import type { WorkflowV2LLMNode, WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowNodeMessage } from "../../../shared/workflow-v2/conversation";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import type {
  WorkflowV2Plan,
  WorkflowV2ResultPacket,
  WorkflowV2TaskPacket,
} from "../../../shared/workflow-v2/planning";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKFLOW_TASK_POLL_MS,
  WORKFLOW_TASK_TIMEOUT_MS,
  taskArtifact,
  truncateWorkflowContext,
  workflowProgressAfterFailure,
} from "../../../shared/workflow-v2/runtime-utils";
import { executeWorkflowV2Plan } from "./workflow-v2-executor";
import type { WorkflowRunRegistry } from "../workflow-run-registry";
import { WorkflowV2RunPersistence } from "./workflow-v2-run-persistence";
import type { ExecuteWorkflowV2RunInput, WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";
export type { WorkflowV2RecoveryOverride } from "./workflow-v2-execution-contract";

function addNodeUsage(telemetry: WorkflowRunNodeTelemetry, usage: TaskRun["usage"]): WorkflowRunNodeTelemetry {
  if (!usage) return telemetry;
  return { ...telemetry, ...mergeRuntimeUsage(telemetry, usage) };
}

function startNodeAttempt(previous: WorkflowRunNodeTelemetry | undefined, next: WorkflowRunNodeTelemetry): WorkflowRunNodeTelemetry {
  if (!previous) return next;
  const merged = addNodeUsage(next, previous);
  return {
    ...merged,
    attempt: next.attempt,
    startedAt: previous.startedAt,
  };
}
import type { WorkflowRuntimeDependencies } from "../workflow-runtime-ports";
import type {
  WorkflowV2ExecutionLeaseState,
  WorkflowV2ProgressReport,
} from "../../../shared/workflow-v2/supervision";
import type { WorkflowV2ReviewerInput, WorkflowV2ReviewerResponse } from "../../../shared/workflow-v2/review";
import { isWorkflowV2InterventionAction } from "../../../shared/workflow-v2/review";
import {
  createWorkflowV2ExecutionLease,
  inspectWorkflowV2ExecutionLease,
  recordWorkflowV2LeaseActivity,
  resolveWorkflowV2SupervisorDecision,
} from "./workflow-v2-supervisor";
import {
  parseWorkflowV2ProgressReport,
  parseWorkflowV2SupervisorDecision,
  workflowV2ContinueAfterProbePrompt,
  workflowV2ProgressProbePrompt,
  workflowV2SupervisorDecisionPrompt,
} from "./workflow-v2-supervision-prompts";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";
import {
  configuredAgentModelId,
  resolveWorkflowNodeAgent,
  workflowV2ExecutionEnvironment,
  workflowV2LlmNodePrompt,
  workflowV2ReviewerPolicy,
} from "./workflow-v2-node-policy";
import {
  parseWorkflowV2HookLlmValue,
  parseWorkflowV2WorkerArtifact,
} from "./workflow-v2-output-parser";
import {
  parseWorkflowV2ReviewerResponse,
  workflowV2ReviewerPrompt,
} from "./workflow-v2-reviewer";
import {
  type WorkflowV2DurableEvent,
  type WorkflowV2DurableNodeControlState,
} from "../../../shared/workflow-v2/storage";
import type { ExecuteWorkflowV2Checkpoint } from "./workflow-v2-executor";
import { recordWorkflowV2ScriptInputRequest, resolveWorkflowV2ScriptInput, workflowV2ScriptInputSignal } from "./workflow-v2-script-input";
import { projectWorkflowV2PausedNodeInteraction } from "./workflow-v2-node-interaction";
import { executeAuthorizedWorkflowV2Script } from "./workflow-v2-script-execution";
import { authorizeWorkflowV2ScriptOperation } from "./workflow-v2-script-approval";
import { buildWorkflowV2FinalReport } from "./workflow-v2-recovery";
import {
  createWorkflowV2HookRegistry,
  runWorkflowV2HookChain,
  WorkflowV2HookSignal,
  type WorkflowV2HookChainResult,
} from "./workflow-v2-hooks";
import { runWorkflowV2TaskWithOutputPolicy } from "./workflow-v2-output-approval";

const WORKFLOW_V2_MAX_PARALLEL_NODES = 4;
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function workflowNodeHistoryMessages(task: TaskRun): WorkflowNodeMessage[] {
  return task.messages.flatMap((message, messageIndex) => {
    const messages: WorkflowNodeMessage[] = [];
    if (message.content.trim()) {
      messages.push({
        id: `${message.id || `${task.id}:message:${messageIndex}`}:content`,
        role: message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system",
        content: message.content,
        at: Number.isFinite(message.timestamp) ? message.timestamp : task.updatedAt,
      });
    }
    for (const event of message.events ?? []) {
      messages.push({
        id: event.id,
        role: event.type === "tool_call" || event.type === "tool_result" ? "tool" : "system",
        content: event.content || event.type.replaceAll("_", " "),
        at: event.timestamp,
        eventType: event.type,
        ...(event.name ? { name: event.name } : {}),
        event: structuredClone(event),
      });
    }
    return messages;
  });
}

class WorkflowV2OneShotInputRequestSignal extends Error {
  constructor(readonly task: TaskRun, readonly question: string) {
    super("One-shot workflow node requested user input.");
  }
}
export class WorkflowV2RunExecutor {
  constructor(
    private readonly deps: WorkflowRuntimeDependencies,
    private readonly runRegistry: WorkflowRunRegistry,
  ) {}

  async execute(input: ExecuteWorkflowV2RunInput): Promise<void> {
    const { workflow, plan, runId, baseWorkflowContextDocument, storagePlanDocument } = input;
    const executionStartedAt = Date.now();
    const maxWallClockMs = plan.budget.cost?.maxWallClockMs;
    const maxModelCalls = plan.budget.cost?.maxModelCalls;
    let startedModelCalls = 0;
    const durableStore = this.deps.createWorkflowV2Store?.();
    const durableNodeControl: Record<string, WorkflowV2DurableNodeControlState> = input.initialNodeControl
      ? structuredClone(input.initialNodeControl)
      : Object.fromEntries(plan.definition.nodes.map((node) => [node.id, { extensionCount: 0 }]));
    const hookVariablesByNodeId = new Map<string, Record<string, unknown>>(
      Object.entries(durableNodeControl).map(([nodeId, control]) => [nodeId, structuredClone(control.hookVariables ?? {})]),
    );
    const hookInjectedContextByNodeId = new Map<string, string[]>();
    let latestSnapshot = this.deps.snapshot();
    let latestProgress = plan.definition.nodes.map((node): WorkflowRunProgressItem => {
      const recovered = input.initialCheckpoint?.runState.nodes[node.id];
      if (recovered?.status === "completed" || recovered?.status === "skipped") {
        return { nodeId: node.id, title: node.title, status: "completed", detail: "Recovered" };
      }
      if (recovered?.status === "failed") {
        return { nodeId: node.id, title: node.title, status: "failed", detail: recovered.lastError ?? "Recovery failed" };
      }
      return { nodeId: node.id, title: node.title, status: "queued", detail: "Queued" };
    });
    const workflowWorkDir = workflow.workDir || latestSnapshot.workDir;
    const configuredAgentId = workflow.configuredAgentId || latestSnapshot.configuredAgents[0]?.id || "default-agent";
    const modelId = configuredAgentModelId(workflow, latestSnapshot);
    const persistence = new WorkflowV2RunPersistence({
      store: durableStore,
      workflow,
      plan,
      runId,
      initialEventCount: input.initialDurableEventCount ?? 0,
      ...(input.initialCheckpoint ? { initialCheckpoint: input.initialCheckpoint } : {}),
      nodeControl: durableNodeControl,
      workDir: workflowWorkDir,
      configuredAgentId,
      modelId, configuredAgents: latestSnapshot.configuredAgents,
      ...(input.recoveryOverrides ? { recoveryOverrides: input.recoveryOverrides } : {}),
    });

    const remainingWallClockMs = (): number => maxWallClockMs === undefined
      ? Number.POSITIVE_INFINITY
      : maxWallClockMs - (Date.now() - executionStartedAt);
    const assertWallClockBudget = (nodeId: string): number => {
      const remainingMs = remainingWallClockMs();
      if (remainingMs <= 0) {
        throw new Error(`Workflow V2 wall-clock budget exhausted before node ${nodeId}.`);
      }
      return remainingMs;
    };
    const consumeModelCallBudget = (nodeId: string): void => {
      if (maxModelCalls !== undefined && startedModelCalls >= maxModelCalls) {
        throw new Error(`Workflow V2 model-call budget exhausted before node ${nodeId}.`);
      }
      startedModelCalls += 1;
    };

    const updateNode = (
      nodeId: string,
      update: Partial<WorkflowRunProgressItem>,
      event?: Omit<WorkflowEvent, "at">,
      clearTaskId = false,
    ): void => {
      latestProgress = latestProgress.map((item) => {
        if (item.nodeId !== nodeId) return item;
        const next = { ...item, ...update };
        if (next.status !== "awaiting_input") delete next.inputRequest;
        if (next.status !== "paused" && next.status !== "awaiting_input") delete next.intervention;
        if (clearTaskId) delete next.taskId;
        return next;
      });
      this.deps.updateWorkflowRunState({
        workflowId: workflow.workflowId,
        runId,
        status: "running",
        progress: latestProgress,
        ...(event ? { appendEvents: [{ ...event, at: Date.now() }] } : {}),
        contextDocument: baseWorkflowContextDocument,
      });
    };

    const startWorkflowTask = async (request: RunTaskRequest, allowOutputWrite = false): Promise<TaskRun> => {
      const existingTaskIds = new Set(latestSnapshot.tasks.map((task) => task.id));
      latestSnapshot = await runWorkflowV2TaskWithOutputPolicy({ workflowId: workflow.workflowId, runId, workDir: workflowWorkDir, request, allowOutputWrite, runTask: this.deps.runTask });
      const task = latestSnapshot.tasks
        .filter((item) => !existingTaskIds.has(item.id))
        .sort((left, right) => right.createdAt - left.createdAt)
        .find((item) => item.prompt === request.prompt && item.configuredAgentId === request.configuredAgentId);
      if (task) return task;
      const fallbackTask = latestSnapshot.tasks
        .filter((item) => !existingTaskIds.has(item.id))
        .sort((left, right) => right.createdAt - left.createdAt)[0];
      if (!fallbackTask) throw new Error("Workflow V2 task creation did not return a new task.");
      return fallbackTask;
    };
    const throwIfWorkflowV2ManuallyPaused = async (nodeId: string, task?: TaskRun): Promise<void> => {
      const activeRun = this.runRegistry.get(runId);
      const reason = activeRun?.manualPauseReasonByNodeId?.get(nodeId);
      if (!reason) return;
      activeRun?.manualPauseReasonByNodeId?.delete(nodeId);
      const node = plan.definition.nodes.find((item) => item.id === nodeId);
      const attempt = persistence.latestCheckpoint?.runState.nodes[nodeId]?.attempt ?? 1;
      const checkpoint = durableNodeControl[nodeId]?.checkpoint;
      const partialArtifact = task ? truncateWorkflowContext(taskArtifact(task), 500) : "";
      const report: WorkflowV2ProgressReport = {
        nodeId,
        attempt: Math.max(1, attempt),
        phase: "manual intervention",
        completedItems: [],
        remainingItems: [node?.title ?? nodeId],
        blockers: [reason],
        evidence: partialArtifact ? [partialArtifact] : [],
        ...(checkpoint ? { checkpoint } : {}),
        safeToInterrupt: true,
        requestedAction: "need_input",
        reportedAt: Date.now(),
      };
      durableNodeControl[nodeId] = {
        ...(durableNodeControl[nodeId] ?? { extensionCount: 0 }),
        progressReport: structuredClone(report),
        stopReason: reason,
      };
      await persistence.persistControlState(nodeId, "manual_pause", reason);
      throw new WorkflowV2SupervisionSignal({
        report,
        resolution: {
          action: "pause",
          question: `Choose how to continue Workflow V2 node ${node?.title ?? nodeId}.`,
          reason,
        },
        ...(task?.runtimeConversation ? { resumeConversation: task.runtimeConversation } : {}),
      });
    };

    const waitForTask = async (
      taskId: string,
      nodeId: string,
      timeoutMs = WORKFLOW_TASK_TIMEOUT_MS,
      detectUserInputRequest = false,
    ): Promise<TaskRun> => {
      const startedAt = Date.now();
      while (true) {
        assertWallClockBudget(nodeId);
        const remainingTaskMs = timeoutMs - (Date.now() - startedAt);
        if (remainingTaskMs <= 0) throw new Error(`Workflow V2 task ${taskId} timed out.`);
        latestSnapshot = this.deps.snapshot();
        const task = latestSnapshot.tasks.find((item) => item.id === taskId);
        if (!task) throw new Error(`Workflow V2 task ${taskId} was deleted before completion.`);
        await throwIfWorkflowV2ManuallyPaused(nodeId, task);
        if (detectUserInputRequest) {
          const requestEvent = task.messages
            .flatMap((message) => message.events ?? [])
            .find((event) => event.type === "user_input_request" && event.requestState !== "resolved");
          if (requestEvent?.content.trim()) throw new WorkflowV2OneShotInputRequestSignal(task, requestEvent.content.trim());
        }
        if (task.status === "completed") return task;
        if (task.status === "failed" || task.status === "stopped") {
          throw new Error(task.lastError || `Workflow V2 task ${task.title} ${task.status}.`);
        }
        updateNode(nodeId, { status: "running", detail: taskArtifact(task), taskId });
        await delay(Math.min(WORKFLOW_TASK_POLL_MS, remainingTaskMs, remainingWallClockMs()));
      }
    };

    const runtimeAttemptByNodeId = new Map<string, number>();
    const consumedRecoveryNodeIds = new Set<string>();

    const startModelTask = async (nodeId: string, request: RunTaskRequest, allowOutputWrite = false): Promise<TaskRun> => {
      consumeModelCallBudget(nodeId);
      const task = await startWorkflowTask({
        ...request,
        planningWorkflowId: workflow.workflowId,
        workflowRunId: runId,
        workflowNodeId: nodeId,
      }, allowOutputWrite);
      this.runRegistry.get(runId)?.taskIdByNodeId.set(nodeId, task.id);
      return task;
    };

    const cleanupSupervisedTasks = async (
      taskIds: readonly string[],
      archiveTaskIds: ReadonlySet<string>,
    ): Promise<void> => {
      for (const taskId of taskIds) {
        latestSnapshot = await this.deps.deleteTask(taskId, {
          preserveRuntimeConversation: !archiveTaskIds.has(taskId),
        });
      }
    };

    const stoppedTaskSnapshot = (task: TaskRun): TaskRun => {
      latestSnapshot = this.deps.snapshot();
      return latestSnapshot.tasks.find((item) => item.id === task.id) ?? task;
    };

    const unavailableProgressReport = (
      node: WorkflowV2LLMNode,
      attempt: number,
      partialArtifact: string,
      lease: WorkflowV2ExecutionLeaseState,
    ): WorkflowV2ProgressReport => ({
      nodeId: node.id,
      attempt,
      phase: "progress probe unavailable",
      completedItems: [],
      remainingItems: [node.title],
      blockers: ["The runtime did not expose a resumable conversation after interruption."],
      evidence: partialArtifact.trim() ? [truncateWorkflowContext(partialArtifact, 500)] : [],
      safeToInterrupt: true,
      requestedAction: "need_input",
      reportedAt: Math.min(Date.now(), lease.hardDeadlineAt),
    });

    const waitForLeasedLlmTask = async (input: {
      node: WorkflowV2LLMNode;
      initialTask: TaskRun;
      attempt: number;
      configuredAgentId: string;
      modelId: string;
      workDir: string;
      taskIds: string[];
      supervisorTaskIds: string[];
    }): Promise<TaskRun> => {
      const policy = input.node.executionLease;
      if (!policy) {
        return waitForTask(input.initialTask.id, input.node.id, WORKFLOW_TASK_TIMEOUT_MS, true);
      }

      let currentTask = input.initialTask;
      let lease = createWorkflowV2ExecutionLease({
        nodeId: input.node.id,
        attempt: input.attempt,
        startedAt: Date.now(),
        policy,
      });
      durableNodeControl[input.node.id] = {
        ...durableNodeControl[input.node.id],
        lease: structuredClone(lease),
        extensionCount: lease.extensionCount,
      };
      await persistence.persistControlState(input.node.id, "lease_started");
      let previousReport: WorkflowV2ProgressReport | undefined;
      const boundedProbeTimeoutMs = (): number => {
        const remainingLeaseMs = lease.hardDeadlineAt - Date.now();
        const remainingRunMs = remainingWallClockMs();
        const timeoutMs = Math.min(policy.progressProbeTimeoutMs, remainingLeaseMs, remainingRunMs);
        if (timeoutMs <= 0) throw new Error(`Workflow V2 node ${input.node.id} reached its hard execution timeout.`);
        return timeoutMs;
      };

      while (true) {
        assertWallClockBudget(input.node.id);
        latestSnapshot = this.deps.snapshot();
        const task = latestSnapshot.tasks.find((item) => item.id === currentTask.id);
        if (!task) throw new Error(`Workflow V2 task ${currentTask.id} was deleted before completion.`);
        currentTask = task;
        await throwIfWorkflowV2ManuallyPaused(input.node.id, task);
        const requestEvent = task.messages
          .flatMap((message) => message.events ?? [])
          .find((event) => event.type === "user_input_request" && event.requestState !== "resolved");
        if (requestEvent?.content.trim()) throw new WorkflowV2OneShotInputRequestSignal(task, requestEvent.content.trim());
        if (task.status === "completed") return task;
        if (task.status === "failed" || task.status === "stopped") {
          throw new Error(task.lastError || `Workflow V2 task ${task.title} ${task.status}.`);
        }

        if (task.updatedAt > lease.lastActivityAt) {
          lease = recordWorkflowV2LeaseActivity(lease, Math.min(task.updatedAt, lease.hardDeadlineAt));
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            extensionCount: lease.extensionCount,
          };
        }
        updateNode(input.node.id, { status: "running", detail: taskArtifact(task), taskId: task.id });
        const now = Date.now();
        const inspection = inspectWorkflowV2ExecutionLease({ lease, policy, now });
        if (inspection === "active") {
          const untilInactivity = policy.inactivityTimeoutMs - (now - lease.lastActivityAt);
          const waitMs = Math.max(1, Math.min(
            WORKFLOW_TASK_POLL_MS,
            lease.softDeadlineAt - now,
            lease.hardDeadlineAt - now,
            untilInactivity,
            remainingWallClockMs(),
          ));
          await delay(waitMs);
          continue;
        }
        if (inspection === "hard_timeout") {
          await this.deps.stopTask(task.id);
          const report: WorkflowV2ProgressReport = {
            ...unavailableProgressReport(input.node, input.attempt, taskArtifact(task), lease),
            phase: "hard execution timeout",
            blockers: ["The node reached its absolute hard execution timeout."],
            ...(durableNodeControl[input.node.id]?.checkpoint
              ? { checkpoint: durableNodeControl[input.node.id]!.checkpoint }
              : {}),
          };
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: "Hard execution timeout reached.",
          };
          await persistence.persistControlState(input.node.id, "lease_hard_timeout", "Hard execution timeout reached.");
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `Node ${input.node.title} reached its hard timeout. Choose whether to retry, skip, escalate, or replan.`,
              reason: "Hard execution timeout reached.",
            },
            ...(task.runtimeConversation ? { resumeConversation: task.runtimeConversation } : {}),
          });
        }

        await this.deps.stopTask(task.id);
        const stoppedTask = stoppedTaskSnapshot(task);
        const partialArtifact = truncateWorkflowContext(taskArtifact(stoppedTask), 4_000);
        if (!stoppedTask.runtimeConversation) {
          const report = unavailableProgressReport(input.node, input.attempt, partialArtifact, lease);
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: "Progress probe requires a resumable runtime conversation.",
          };
          await persistence.persistControlState(
            input.node.id,
            "progress_probe_unavailable",
            "Progress probe requires a resumable runtime conversation.",
          );
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `Node ${input.node.title} exceeded its soft timeout but its runtime cannot resume for a progress probe.`,
              reason: "Progress probe requires a resumable runtime conversation.",
            },
          });
        }

        const progressTask = await startModelTask(input.node.id, {
          prompt: workflowV2ProgressProbePrompt({
            node: input.node,
            attempt: input.attempt,
            partialArtifact,
            now: Date.now(),
          }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
          continuationPolicy: "resume-required",
          runtimeConversation: stoppedTask.runtimeConversation,
        });
        input.taskIds.push(progressTask.id);

        let completedProgressTask: TaskRun;
        try {
          completedProgressTask = await waitForTask(progressTask.id, input.node.id, boundedProbeTimeoutMs());
        } catch (error) {
          await this.deps.stopTask(progressTask.id);
          const reason = error instanceof Error ? error.message : String(error);
          const report = unavailableProgressReport(input.node, input.attempt, partialArtifact, lease);
          report.phase = "progress probe failed";
          report.blockers = [reason];
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            extensionCount: lease.extensionCount,
            stopReason: reason,
          };
          await persistence.persistControlState(input.node.id, "progress_probe_failed", reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `The progress probe for ${input.node.title} did not complete. Choose the next recovery action.`,
              reason,
            },
            ...(stoppedTask.runtimeConversation ? { resumeConversation: stoppedTask.runtimeConversation } : {}),
          });
        }
        const report = parseWorkflowV2ProgressReport(taskArtifact(completedProgressTask));
        durableNodeControl[input.node.id] = {
          ...durableNodeControl[input.node.id],
          lease: structuredClone(lease),
          progressReport: structuredClone(report),
          ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
          extensionCount: lease.extensionCount,
        };
        await persistence.persistControlState(input.node.id, "progress_reported", report.phase);

        const supervisorTask = await startModelTask(input.node.id, {
          prompt: workflowV2SupervisorDecisionPrompt({
            node: input.node,
            report,
            policy,
            extensionCount: lease.extensionCount,
          }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
        });
        input.taskIds.push(supervisorTask.id);
        input.supervisorTaskIds.push(supervisorTask.id);

        let completedSupervisorTask: TaskRun;
        try {
          completedSupervisorTask = await waitForTask(supervisorTask.id, input.node.id, boundedProbeTimeoutMs());
        } catch (error) {
          await this.deps.stopTask(supervisorTask.id);
          const reason = error instanceof Error ? error.message : String(error);
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
            extensionCount: lease.extensionCount,
            stopReason: reason,
          };
          await persistence.persistControlState(input.node.id, "supervisor_response_failed", reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution: {
              action: "pause",
              question: `The supervisor decision for ${input.node.title} did not complete. Choose the next recovery action.`,
              reason,
            },
            ...(completedProgressTask.runtimeConversation
              ? { resumeConversation: completedProgressTask.runtimeConversation }
              : {}),
          });
        }
        const decision = parseWorkflowV2SupervisorDecision(taskArtifact(completedSupervisorTask));
        const resolution = resolveWorkflowV2SupervisorDecision({
          lease,
          policy,
          report,
          ...(previousReport ? { previousReport } : {}),
          decision,
          now: Date.now(),
        });
        if (resolution.action !== "continue") {
          durableNodeControl[input.node.id] = {
            ...durableNodeControl[input.node.id],
            lease: structuredClone(lease),
            progressReport: structuredClone(report),
            ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
            extensionCount: lease.extensionCount,
            stopReason: resolution.reason,
          };
          await persistence.persistControlState(input.node.id, `supervisor_${resolution.action}`, resolution.reason);
          throw new WorkflowV2SupervisionSignal({
            report,
            resolution,
            ...(completedProgressTask.runtimeConversation
              ? { resumeConversation: completedProgressTask.runtimeConversation }
              : {}),
          });
        }
        if (decision.action !== "continue") {
          throw new Error(`Workflow V2 supervisor resolution for node ${input.node.id} lost its continue decision.`);
        }
        if (!completedProgressTask.runtimeConversation) {
          throw new Error(`Workflow V2 progress probe for node ${input.node.id} did not return a resumable conversation.`);
        }

        previousReport = report;
        lease = resolution.lease;
        durableNodeControl[input.node.id] = {
          ...durableNodeControl[input.node.id],
          lease: structuredClone(lease),
          progressReport: structuredClone(report),
          ...(report.checkpoint ? { checkpoint: report.checkpoint } : {}),
          extensionCount: lease.extensionCount,
          stopReason: resolution.reason,
        };
        await persistence.persistControlState(input.node.id, "lease_extended", resolution.reason);
        currentTask = await startModelTask(input.node.id, {
          prompt: workflowV2ContinueAfterProbePrompt({ node: input.node, report, decision }),
          configuredAgentId: input.configuredAgentId,
          modelId: input.modelId,
          workDir: input.workDir,
          continuationPolicy: "resume-required",
          runtimeConversation: completedProgressTask.runtimeConversation,
        }, true);
        input.taskIds.push(currentTask.id);
      }
    };

    const runLlmNode = async (request: {
      node: WorkflowV2LLMNode;
      planNode: WorkflowV2Plan["nodes"][number];
      taskPacket: WorkflowV2TaskPacket;
      upstreamOutputs: readonly WorkflowV2ResultPacket[];
    }): Promise<WorkflowV2WorkerOutput> => {
      assertWallClockBudget(request.node.id);
      const agentRoute = resolveWorkflowNodeAgent(request.node, { configuredAgentId, modelId }, latestSnapshot.configuredAgents);
      const recoveryOverride = input.recoveryOverrides?.get(request.node.id);
      const effectiveTaskPacket = recoveryOverride?.modelProfile
        ? { ...request.taskPacket, modelProfile: recoveryOverride.modelProfile }
        : request.taskPacket;
      const messages = workflowV2LlmNodePrompt({
        node: request.node,
        taskPacket: effectiveTaskPacket,
        upstreamOutputs: request.upstreamOutputs,
        baseWorkflowContextDocument: [
          baseWorkflowContextDocument,
          ...(hookInjectedContextByNodeId.get(request.node.id)?.length
            ? ["# Hook-injected context", ...hookInjectedContextByNodeId.get(request.node.id)!]
            : []),
        ].filter(Boolean).join("\n\n"),
        storagePlanDocument,
      });
      const recoveryCheckpoint = consumedRecoveryNodeIds.has(request.node.id)
        ? undefined
        : input.recoveryCheckpoints?.get(request.node.id);
      const recoveryConversation = consumedRecoveryNodeIds.has(request.node.id)
        ? undefined
        : input.resumeConversations?.get(request.node.id);
      const effectivePrompt = [messages.prompt, recoveryOverride?.userInput].filter(Boolean).join("\n\n");
      const effectiveDeveloperInstructions = [
        messages.developerInstructions,
        ...(recoveryCheckpoint ? ["A recovery checkpoint is included in runtime context; treat it as control context, not a completed result."] : []),
        ...(recoveryOverride ? [recoveryOverride.instruction] : []),
        ...(recoveryOverride?.modelProfile ? [`Effective model profile: ${recoveryOverride.modelProfile}`] : []),
        ...(recoveryOverride?.forceIndependentReview ? ["This attempt requires independent semantic review."] : []),
      ].join("\n\n");
      const effectiveContextDocument = [messages.contextDocument, recoveryCheckpoint ? `# Recovery checkpoint\n${recoveryCheckpoint}` : ""].filter(Boolean).join("\n\n");
      if (request.planNode.executionMode === "interactive") {
        const conversation = await this.deps.startWorkflowNodeConversation({
          workflowId: workflow.workflowId,
          runId,
          nodeId: request.node.id,
          configuredAgentId: agentRoute.configuredAgentId,
          modelId: agentRoute.modelId,
          workDir: workflowWorkDir,
          initialPrompt: effectivePrompt,
          developerInstructions: [
            effectiveDeveloperInstructions,
            "This is a persistent multi-turn conversation. Ask concise questions whenever required information is incomplete.",
            "Do not claim the node is complete until all acceptance criteria are satisfied.",
            "When complete, call workflow_node_complete (or its namespaced MCP equivalent) exactly once with the structured worker output for explicit user confirmation. Do not print the worker-output JSON as ordinary assistant content.",
          ].join("\n\n"),
          contextDocument: effectiveContextDocument,
        });
        throw new WorkflowV2SupervisionSignal({
          resolution: {
            action: "pause",
            question: `Open node conversation ${conversation.conversationId} to continue.`,
            reason: "Interactive node is waiting for user confirmation.",
          },
          report: {
            nodeId: request.node.id,
            attempt: 1,
            phase: "interactive",
            completedItems: [],
            remainingItems: ["User confirmation"],
            blockers: ["Interactive node conversation is still open."],
            evidence: [],
            safeToInterrupt: true,
            requestedAction: "need_input",
            reportedAt: Date.now(),
          },
        });
      }
      const attempt = (runtimeAttemptByNodeId.get(request.node.id) ?? 0) + 1;
      runtimeAttemptByNodeId.set(request.node.id, attempt);
      const configuredAgent = latestSnapshot.configuredAgents.find((item) => item.id === agentRoute.configuredAgentId);
      const channel = configuredAgent?.channelId
        ? latestSnapshot.channels.find((item) => item.id === configuredAgent.channelId)
        : undefined;
      const provider = channel?.apiFormat === "anthropic" || configuredAgent?.runtimeAgentId === "claude"
        ? "anthropic"
        : channel?.apiFormat?.startsWith("openai")
          ? "openai"
          : undefined;
      const nextTelemetry: WorkflowRunNodeTelemetry = {
        ...(provider ? { provider } : {}),
        ...(configuredAgent?.runtimeAgentId ? { runtimeId: configuredAgent.runtimeAgentId } : {}),
        ...(configuredAgent?.channelId ? { channelId: configuredAgent.channelId } : {}),
        modelId: agentRoute.modelId,
        attempt,
        startedAt: Date.now(),
      };
      const previousTelemetry = latestProgress.find((item) => item.nodeId === request.node.id)?.telemetry;
      const telemetry = startNodeAttempt(previousTelemetry, nextTelemetry);
      const task = await startModelTask(request.node.id, {
        prompt: effectivePrompt,
        developerInstructions: effectiveDeveloperInstructions,
        contextDocument: effectiveContextDocument,
        configuredAgentId: agentRoute.configuredAgentId,
        modelId: agentRoute.modelId,
        workDir: workflowWorkDir,
        ...(recoveryConversation
          ? { continuationPolicy: "resume-required" as const, runtimeConversation: recoveryConversation }
          : {}),
      }, true);
      consumedRecoveryNodeIds.add(request.node.id);
      updateNode(request.node.id, { status: "running", detail: "Task running", taskId: task.id, telemetry });

      let taskIds = [task.id];
      const supervisorTaskIds: string[] = [];
      let archiveTaskId: string | undefined = task.id;
      try {
        const completedTask = await waitForLeasedLlmTask({
          node: request.node,
          initialTask: task,
          attempt,
          configuredAgentId: agentRoute.configuredAgentId,
          modelId: agentRoute.modelId,
          workDir: workflowWorkDir,
          taskIds,
          supervisorTaskIds,
        });
        archiveTaskId = completedTask.id;
        // Message history is an execution artifact, independent from whether the
        // worker output passes structured validation. Archive it before parsing so
        // failed or malformed one-shot responses remain inspectable in run history.
        const historyMessages = workflowNodeHistoryMessages(completedTask);
        const completedTelemetry = { ...addNodeUsage(telemetry, completedTask.usage), finishedAt: Date.now() };
        updateNode(request.node.id, {
          status: "running",
          detail: "Task output received",
          taskId: task.id,
          telemetry: completedTelemetry,
          ...(historyMessages.length > 0 ? { messages: historyMessages } : {}),
        });
        const artifact = taskArtifact(completedTask);
        const output = parseWorkflowV2WorkerArtifact(request.node, artifact);
        updateNode(request.node.id, { status: "running", detail: output.summary, taskId: task.id, telemetry: completedTelemetry }, {
          type: "node_output",
          nodeId: request.node.id,
          taskId: task.id,
          attempt: 1,
          summary: output.summary,
        });
        return output;
      } catch (error) {
        const taskForHistory = error instanceof WorkflowV2OneShotInputRequestSignal
          ? error.task
          : [...taskIds]
              .map((taskId) => latestSnapshot.tasks.find((item) => item.id === taskId))
              .find((item): item is TaskRun => Boolean(item));
        if (taskForHistory) {
          const historyMessages = workflowNodeHistoryMessages(taskForHistory);
          updateNode(request.node.id, {
            status: "running",
            detail: "Task history archived",
            taskId: taskForHistory.id,
            telemetry: { ...addNodeUsage(telemetry, taskForHistory.usage), finishedAt: Date.now() },
            ...(historyMessages.length > 0 ? { messages: historyMessages } : {}),
          });
        } else {
          updateNode(request.node.id, { telemetry: { ...telemetry, finishedAt: Date.now() } });
        }
        if (error instanceof WorkflowV2OneShotInputRequestSignal) {
          await this.deps.stopTask(error.task.id);
          archiveTaskId = undefined;
          throw new Error(
            `Workflow V2 one-shot node ${request.node.id} requested user input: ${error.question}. `
            + "Replan this node as interactive before running the workflow.",
          );
        }
        if (
          error instanceof WorkflowV2SupervisionSignal
          && (error.resolution.action === "pause" || error.resolution.action === "escalate")
        ) {
          archiveTaskId = undefined;
        }
        throw error;
      } finally {
        await cleanupSupervisedTasks(
          taskIds,
          new Set([
            ...supervisorTaskIds,
            ...(archiveTaskId ? [archiveTaskId] : []),
          ]),
        );
      }
    };

    const runScriptNode = async (request: {
      node: WorkflowV2ScriptNode;
      planNode: WorkflowV2Plan["nodes"][number];
      upstreamOutputs: readonly WorkflowV2ResultPacket[];
    }): Promise<WorkflowV2WorkerOutput> => {
      const submittedValues = durableNodeControl[request.node.id]?.scriptInput?.submittedValues ?? {};
      const resolvedInput = resolveWorkflowV2ScriptInput({
        parameters: request.node.script.parameters,
        workflowContext: { objective: workflow.objective, contextDocument: baseWorkflowContextDocument },
        upstreamOutputs: request.upstreamOutputs,
        submittedValues,
      });
      if (!resolvedInput.complete) {
        const requestedAt = recordWorkflowV2ScriptInputRequest({ nodeId: request.node.id, nodeTitle: request.node.title, requested: resolvedInput.requested, control: durableNodeControl, updateNode });
        await persistence.persistControlState(request.node.id, "script_input_requested", resolvedInput.requested.map((item) => item.key).join(","));
        throw workflowV2ScriptInputSignal({ nodeId: request.node.id, nodeTitle: request.node.title, missing: resolvedInput.missing, requestedAt });
      }
      const remainingScriptMs = assertWallClockBudget(request.node.id);
      const timeoutMs = Math.min(
        request.node.script.timeoutMs ?? WORKFLOW_TASK_TIMEOUT_MS,
        remainingScriptMs,
        MAX_NODE_TIMER_DELAY_MS,
      );
      const controller = new AbortController();
      const graphVersion = workflow.workflowV2Plan?.graphVersion ?? workflow.definition.graphVersion;
      const approvalGrant = input.recoveryOverrides?.get(request.node.id)?.scriptApproval;
      const { governance, permission, operationDigest } = authorizeWorkflowV2ScriptOperation({
        workflowId: workflow.workflowId,
        graphVersion,
        runId,
        node: request.node,
        planNode: request.planNode,
        workDir: workflowWorkDir,
        inputs: resolvedInput.values,
        ...(approvalGrant ? { approvalGrant } : {}),
      });
      this.runRegistry.get(runId)?.abortControllerByNodeId?.set(request.node.id, controller);
      const telemetry: WorkflowRunNodeTelemetry = { attempt: 1, startedAt: Date.now() };
      updateNode(request.node.id, { status: "running", detail: "Script running", telemetry });
      let output: WorkflowV2WorkerOutput;
      try {
        output = await executeAuthorizedWorkflowV2Script({ deps: this.deps, node: request.node, workDir: workflowWorkDir, upstreamOutputs: request.upstreamOutputs, timeoutMs, inputs: resolvedInput.values, controller,
          authorization: {
            decision: permission.decision,
            workflowId: workflow.workflowId,
            graphVersion,
            runId,
            nodeId: request.node.id,
            risk: permission.risk,
            capabilities: [...governance.capabilities],
            capabilityDigest: governance.capabilityDigest,
            operationDigest,
            ...(approvalGrant ? { approvalRequestId: approvalGrant.requestId } : {}),
          },
        });
      } catch (error) {
        await throwIfWorkflowV2ManuallyPaused(request.node.id);
        throw error;
      } finally {
        this.runRegistry.get(runId)?.abortControllerByNodeId?.delete(request.node.id);
      }
      updateNode(request.node.id, { status: "running", detail: output.summary, telemetry: { ...telemetry, finishedAt: Date.now() } }, {
        type: "node_output",
        nodeId: request.node.id,
        attempt: 1,
        summary: output.summary,
      });
      return output;
    };

    const reviewNodeOutput = async (reviewInput: WorkflowV2ReviewerInput): Promise<WorkflowV2ReviewerResponse> => {
      const task = await startModelTask(`reviewer:${reviewInput.executorNodeId}`, {
        prompt: workflowV2ReviewerPrompt(reviewInput),
        configuredAgentId,
        modelId,
        workDir: workflowWorkDir,
      });
      updateNode(reviewInput.executorNodeId, {
        status: "running",
        detail: "Independent semantic review running",
        taskId: task.id,
      });
      try {
        const completedTask = await waitForTask(task.id, reviewInput.executorNodeId);
        return parseWorkflowV2ReviewerResponse(taskArtifact(completedTask), reviewInput.executorNodeId);
      } finally {
        latestSnapshot = await this.deps.deleteTask(task.id);
      }
    };

    const hookMemory = new Map<string, unknown>();
    const hookRegistry = createWorkflowV2HookRegistry({
      readMemory: async (key) => structuredClone(hookMemory.get(key) ?? null),
      writeMemory: async (key, value) => {
        hookMemory.set(key, structuredClone(value));
      },
      writeFile: async (relativePath, content) => {
        if (!relativePath.trim() || path.isAbsolute(relativePath)) {
          throw new Error("Workflow V2 writeFile hook requires a relative path.");
        }
        const targetPath = path.resolve(workflowWorkDir, relativePath);
        const relativeToRoot = path.relative(workflowWorkDir, targetPath);
        if (!relativeToRoot || relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
          throw new Error("Workflow V2 writeFile hook path must stay inside the workflow work directory.");
        }
        await mkdir(path.dirname(targetPath), { recursive: true });
        await writeFile(targetPath, content, "utf8");
      },
      runReadOnlyLlm: async ({ prompt: hookPrompt, context }) => {
        const boundedHookContext = truncateWorkflowContext(JSON.stringify({
          ...context,
          runContext: truncateWorkflowContext(context.runContext, 6_000),
        }), 12_000);
        const task = await startModelTask(`hook:${context.nodeId}`, {
          prompt: hookPrompt,
          developerInstructions: [
            "Run one read-only, low-cost Workflow V2 llmHook.",
            "Model profile: fast.",
            "Do not call tools, modify files, navigate the graph, judge node completion, or request workflow control.",
            "Return one JSON value only.",
          ].join("\n\n"),
          contextDocument: boundedHookContext,
          configuredAgentId,
          modelId,
          workDir: workflowWorkDir,
        });
        try {
          const completedTask = await waitForTask(task.id, context.nodeId);
          return parseWorkflowV2HookLlmValue(taskArtifact(completedTask));
        } finally {
          latestSnapshot = await this.deps.deleteTask(task.id);
        }
      },
    });
    const persistHookResult = async (
      nodeId: string,
      lifecycle: "beforeExecute" | "afterOutput" | "afterComplete",
      result: WorkflowV2HookChainResult,
    ): Promise<void> => {
      hookVariablesByNodeId.set(nodeId, structuredClone(result.variables));
      if (result.injectedContext.length > 0) {
        hookInjectedContextByNodeId.set(nodeId, [
          ...(hookInjectedContextByNodeId.get(nodeId) ?? []),
          ...result.injectedContext,
        ]);
      }
      durableNodeControl[nodeId] = {
        ...(durableNodeControl[nodeId] ?? { extensionCount: 0 }),
        hookVariables: structuredClone(result.variables),
      };
      await persistence.persistControlState(
        nodeId,
        `hooks_${lifecycle}`,
        result.records.map((record) => `${record.kind}:${record.status}`).join(", ") || "No hooks",
      );
    };
    const runNodeHooks: NonNullable<Parameters<typeof executeWorkflowV2Plan>[0]["runNodeHooks"]> = async ({
      lifecycle,
      node,
      output,
    }) => {
      if ((node.hooks?.[lifecycle]?.length ?? 0) === 0) return;
      try {
        const existingVariables = hookVariablesByNodeId.get(node.id);
        const result = await runWorkflowV2HookChain({
          hooks: node.hooks,
          lifecycle,
          context: {
            workflowId: workflow.workflowId,
            runId,
            nodeId: node.id,
            runContext: baseWorkflowContextDocument,
            ...(output ? { output: structuredClone(output) } : {}),
          },
          ...(existingVariables ? { variables: existingVariables } : {}),
          registry: hookRegistry,
        });
        await persistHookResult(node.id, lifecycle, result);
      } catch (error) {
        if (error instanceof WorkflowV2HookSignal) {
          await persistHookResult(node.id, lifecycle, {
            variables: structuredClone(error.variables),
            injectedContext: [...error.injectedContext],
            records: structuredClone(error.records),
          });
        }
        throw error;
      }
    };

    try {
      this.deps.updateWorkflowRunState({
        workflowId: workflow.workflowId,
        runId,
        status: "running",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
      });
      const result = await executeWorkflowV2Plan({
        plan,
        maxParallelNodes: WORKFLOW_V2_MAX_PARALLEL_NODES,
        ...(input.initialCheckpoint ? { initialCheckpoint: input.initialCheckpoint } : {}),
        runLlmNode,
        executeScript: runScriptNode,
        reviewNodeOutput,
        runNodeHooks,
        forceIndependentReviewNodeIds: new Set(
          [...(input.recoveryOverrides?.entries() ?? [])]
            .filter(([, override]) => override.forceIndependentReview)
            .map(([nodeId]) => nodeId),
        ),
        onRunCheckpoint: (checkpoint) => persistence.persistCheckpoint(checkpoint),
        onNodeStateTransition: (transition) => {
          if (transition.status === "running") {
            updateNode(transition.nodeId, { status: "running", detail: "Starting" }, {
              type: "node_started",
              nodeId: transition.nodeId,
              attempt: 1,
              detail: "Starting",
            });
          } else if (transition.status === "completed") {
            updateNode(transition.nodeId, { status: "completed", detail: transition.output.summary, outputs: structuredClone(transition.output.outputs) }, {
              type: "node_completed",
              nodeId: transition.nodeId,
              detail: transition.output.summary,
            }, true);
          } else if (transition.status === "skipped") {
            updateNode(transition.nodeId, { status: "completed", detail: transition.output.summary, outputs: structuredClone(transition.output.outputs) }, {
              type: "node_completed",
              nodeId: transition.nodeId,
              detail: transition.output.summary,
            }, true);
          } else if (transition.status === "paused") {
            const activeRun = this.runRegistry.get(runId);
            activeRun?.pausedNodeIds.add(transition.nodeId);
            const node = plan.definition.nodes.find((candidate) => candidate.id === transition.nodeId);
            const interaction = projectWorkflowV2PausedNodeInteraction({
              nodeId: transition.nodeId,
              interactiveAgent: node?.execModel === "llm" && node.executionMode === "interactive",
              intervention: transition.intervention,
              ...(durableNodeControl[transition.nodeId] ? { control: durableNodeControl[transition.nodeId] } : {}),
            });
            updateNode(transition.nodeId, interaction.progress, interaction.event, true);
          } else {
            updateNode(transition.nodeId, { status: "failed", detail: transition.error }, {
              type: "node_failed",
              nodeId: transition.nodeId,
              error: transition.error,
            }, true);
          }
        },
      });

      const finalReport = buildWorkflowV2FinalReport(plan, result.workerOutputs, result.runState.status);
      if (this.runRegistry.isStopRequested(runId)) return;
      if (result.runState.status === "completed") {
        this.deps.finishWorkflowRun({
          workflowId: workflow.workflowId,
          runId,
          status: "completed",
          progress: latestProgress,
          contextDocument: baseWorkflowContextDocument,
          finalReport,
        });
        return;
      }
      if (result.runState.status === "paused") {
        this.deps.updateWorkflowRunState({
          workflowId: workflow.workflowId,
          runId,
          status: "waiting_for_user",
          progress: latestProgress,
          contextDocument: baseWorkflowContextDocument,
          finalReport,
        });
        return;
      }

      const lastError = result.runState.nodeOrder
        .map((nodeId) => result.runState.nodes[nodeId])
        .find((node) => node?.status === "failed")?.lastError ?? "Workflow V2 execution failed.";
      this.deps.finishWorkflowRun({
        workflowId: workflow.workflowId,
        runId,
        status: "failed",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
        finalReport,
        lastError,
      });
    } catch (error) {
      if (this.runRegistry.isStopRequested(runId)) return;
      const message = error instanceof Error ? error.message : String(error);
      latestProgress = workflowProgressAfterFailure(latestProgress, message);
      this.deps.finishWorkflowRun({
        workflowId: workflow.workflowId,
        runId,
        status: "failed",
        progress: latestProgress,
        contextDocument: baseWorkflowContextDocument,
        lastError: message,
      });
    }
  }

}
