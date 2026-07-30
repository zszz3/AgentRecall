import type { AppSnapshot } from "../../../../automation/contracts";
import {
  AUTOMATION_CHANGE_PROTOCOL_VERSION,
  type AutomationChange,
  type AutomationEntityPatch,
} from "../../../../shared/ipc/automation";

export interface AutomationChangeApplication {
  snapshot: AppSnapshot;
  sequence: number;
  resyncRequired: boolean;
}

type WorkflowMessage = AppSnapshot["workflowStore"]["workflows"][number]["messages"][number];

function workflowMessageVersion(message: WorkflowMessage): string {
  const lastEvent = message.events?.at(-1);
  return `${message.role}:${message.content}:${message.events?.length ?? 0}:${lastEvent?.id ?? ""}:${lastEvent?.content ?? ""}:${String(lastEvent?.metadata?.status ?? "")}`;
}

function reconcileWorkflowMessages(current: WorkflowMessage[], incoming: WorkflowMessage[]): WorkflowMessage[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const next = incoming.map((message) => {
    const prior = currentById.get(message.id);
    return prior && workflowMessageVersion(prior) === workflowMessageVersion(message) ? prior : message;
  });
  return next.length === current.length && next.every((message, index) => message === current[index]) ? current : next;
}

function applyEntityPatch<T>(
  current: T[],
  patch: AutomationEntityPatch<T> | undefined,
  idOf: (value: T) => string,
  reconcile: (current: T, incoming: T) => T = (_current, incoming) => incoming,
): T[] {
  if (!patch) return current;
  const removed = new Set(patch.remove);
  const upsertById = new Map(patch.upsert.map((value) => [idOf(value), value]));
  const next = current
    .filter((value) => !removed.has(idOf(value)))
    .map((value) => {
      const incoming = upsertById.get(idOf(value));
      return incoming ? reconcile(value, incoming) : value;
    });
  const known = new Set(next.map(idOf));
  for (const value of patch.upsert) {
    if (!known.has(idOf(value))) next.push(value);
  }
  return next;
}

export function applyAutomationChange(
  snapshot: AppSnapshot,
  change: AutomationChange,
  previousSequence: number | undefined,
): AutomationChangeApplication {
  if (previousSequence !== undefined && change.sequence <= previousSequence) {
    return {
      snapshot,
      sequence: previousSequence,
      resyncRequired: false,
    };
  }
  const sequenceGap = previousSequence !== undefined && change.sequence > previousSequence + 1;
  const unsupportedProtocol = change.protocolVersion !== AUTOMATION_CHANGE_PROTOCOL_VERSION;
  if (sequenceGap || unsupportedProtocol) {
    return {
      snapshot,
      sequence: change.sequence,
      resyncRequired: true,
    };
  }

  const workflows = applyEntityPatch(
    snapshot.workflowStore.workflows,
    change.payload.workflows,
    (value) => value.workflowId,
    (current, incoming) => current.revision === incoming.revision
      ? { ...incoming, definition: current.definition, messages: reconcileWorkflowMessages(current.messages, incoming.messages) }
      : incoming,
  )
    .sort((left, right) => right.createdAt - left.createdAt);
  const runs = applyEntityPatch(snapshot.workflowStore.runs, change.payload.runs, (value) => value.runId)
    .sort((left, right) => right.startedAt - left.startedAt);
  const activeWorkflowId = change.payload.activeWorkflowId === null
    ? undefined
    : change.payload.activeWorkflowId ?? snapshot.workflowStore.activeWorkflowId;
  const workflowDraft = activeWorkflowId
    ? workflows.find((workflow) => workflow.workflowId === activeWorkflowId)
    : undefined;
  const tasks = applyEntityPatch(snapshot.tasks, change.payload.tasks, (value) => value.id)
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const nextSnapshot: AppSnapshot = {
    ...snapshot,
    detectedAt: change.detectedAt,
    workflowStore: {
      activeWorkflowId,
      workflows,
      runs,
      ...(change.payload.readinessByWorkflowId !== undefined
        ? { readinessByWorkflowId: change.payload.readinessByWorkflowId }
        : snapshot.workflowStore.readinessByWorkflowId !== undefined
          ? { readinessByWorkflowId: snapshot.workflowStore.readinessByWorkflowId }
          : {}),
    },
    workflowNodeConversations: applyEntityPatch(snapshot.workflowNodeConversations, change.payload.conversations, (value) => value.conversationId),
    workflowDraft,
    tasks,
    artifacts: applyEntityPatch(snapshot.artifacts, change.payload.artifacts, (value) => value.id),
  };
  return {
    snapshot: nextSnapshot,
    sequence: change.sequence,
    resyncRequired: false,
  };
}
