import { randomUUID } from "node:crypto";
import type {
  ChatEvent,
  ChatMessage,
  WorkflowArtifactReference,
  WorkflowEvent,
  WorkflowRunProgressItem,
  WorkflowStatus,
} from "../../../shared/types";
import type { WorkflowNodeInputRequest } from "../../../shared/workflow/run";
import type { WorkflowV2ScriptParameterDef } from "../../../shared/workflow-v2/definition";
import { isWorkflowV2HumanIntervention } from "../../../shared/workflow-v2/review";
import {
  asArray,
  asNumber,
  asOptionalString,
  asRecord,
  isAgentId,
  isApprovalDecision,
  isChatEventType,
  isInteractionRequestState,
  isMessageRole,
  isWorkflowRunNodeStatus,
} from "../persisted/agent-hub-persistence";
import { createAssistantMessage } from "../chat/agent-hub-ui";

export function restoreWorkflowStatus(value: unknown): WorkflowStatus {
  return value === "running" || value === "waiting_for_user" || value === "completed" || value === "failed" || value === "stopped" ? value : "draft";
}

export function restoreWorkflowDraftStatus(value: unknown): WorkflowStatus {
  const status = restoreWorkflowStatus(value);
  return status === "running" ? "failed" : status;
}

export function restoreWorkflowRunStatus(value: unknown): WorkflowStatus {
  const status = restoreWorkflowStatus(value);
  return status === "running" ? "failed" : status;
}

function restoreWorkflowV2ScriptParameter(raw: unknown): WorkflowV2ScriptParameterDef | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const key = asOptionalString(record.key);
  const label = asOptionalString(record.label);
  const location = record.location;
  const valueType = record.valueType;
  const source = record.source;
  if (!key || !label
    || (location !== "argument" && location !== "environment" && location !== "header" && location !== "query" && location !== "body" && location !== "stdin")
    || (valueType !== "string" && valueType !== "number" && valueType !== "boolean" && valueType !== "json" && valueType !== "secret" && valueType !== "file" && valueType !== "directory")
    || (source !== "user" && source !== "workflow" && source !== "upstream" && source !== "literal")
    || typeof record.required !== "boolean") {
    return undefined;
  }
  const parameter: WorkflowV2ScriptParameterDef = { key, label, location, valueType, source, required: record.required };
  const description = asOptionalString(record.description);
  const upstreamNodeId = asOptionalString(record.upstreamNodeId);
  const upstreamOutputKey = asOptionalString(record.upstreamOutputKey);
  const workflowPath = asOptionalString(record.workflowPath);
  if (description) parameter.description = description;
  if (Array.isArray(record.enum) && record.enum.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
    parameter.enum = structuredClone(record.enum) as NonNullable<WorkflowV2ScriptParameterDef["enum"]>;
  }
  if (record.defaultValue !== undefined) parameter.defaultValue = structuredClone(record.defaultValue) as NonNullable<WorkflowV2ScriptParameterDef["defaultValue"]>;
  if (record.literalValue !== undefined) parameter.literalValue = structuredClone(record.literalValue) as NonNullable<WorkflowV2ScriptParameterDef["literalValue"]>;
  if (upstreamNodeId) parameter.upstreamNodeId = upstreamNodeId;
  if (upstreamOutputKey) parameter.upstreamOutputKey = upstreamOutputKey;
  if (workflowPath) parameter.workflowPath = workflowPath;
  return parameter;
}

function restoreWorkflowNodeInputRequest(raw: unknown): WorkflowNodeInputRequest | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (record.kind === "agent_message") {
    const prompt = asOptionalString(record.prompt);
    return prompt ? { kind: "agent_message", prompt } : undefined;
  }
  if (record.kind !== "script_parameters") return undefined;
  const rawParameters = asArray(record.parameters);
  const parameters = rawParameters.map(restoreWorkflowV2ScriptParameter);
  if (parameters.some((parameter) => !parameter)) return undefined;
  return { kind: "script_parameters", parameters: parameters as WorkflowV2ScriptParameterDef[] };
}

export function restoreWorkflowRunProgressItem(raw: unknown): WorkflowRunProgressItem | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const nodeId = asOptionalString(record.nodeId);
  const title = asOptionalString(record.title);
  if (!nodeId || !title || !isWorkflowRunNodeStatus(record.status)) return undefined;
  const status = record.status === "running" || record.status === "queued" ? "failed" : record.status;
  const item: WorkflowRunProgressItem = {
    nodeId,
    title,
    status,
  };
  const detail = asOptionalString(record.detail) ?? (status === "failed" && record.status !== "failed" ? "Interrupted before app restart" : undefined);
  if (detail) item.detail = detail;
  const taskId = asOptionalString(record.taskId);
  if (taskId) item.taskId = taskId;
  if (record.intervention !== undefined && isWorkflowV2HumanIntervention(record.intervention)) {
    item.intervention = structuredClone(record.intervention);
  }
  if (status === "awaiting_input") {
    const inputRequest = restoreWorkflowNodeInputRequest(record.inputRequest);
    if (inputRequest) item.inputRequest = inputRequest;
  }
  const outputs = asRecord(record.outputs);
  if (outputs) item.outputs = structuredClone(outputs);
  return item;
}

export function restoreWorkflowArtifactReference(raw: unknown): WorkflowArtifactReference | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const kind = record.kind;
  if (kind !== "text" && kind !== "file" && kind !== "url") return undefined;
  const title = asOptionalString(record.title);
  if (!title) return undefined;
  const ref: WorkflowArtifactReference = { kind, title };
  const content = asOptionalString(record.content);
  if (content) ref.content = content;
  const filePath = asOptionalString(record.path);
  if (filePath) ref.path = filePath;
  const url = asOptionalString(record.url);
  if (url) ref.url = url;
  return ref;
}

export function restoreWorkflowEvent(raw: unknown): WorkflowEvent | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const nodeId = asOptionalString(record.nodeId);
  const type = record.type;
  const validType =
    type === "node_ready" ||
    type === "node_started" ||
    type === "node_paused" ||
    type === "node_output" ||
    type === "node_judged" ||
    type === "node_failed" ||
    type === "node_completed";
  if (!nodeId || !validType) return undefined;
  const event: WorkflowEvent = { type, nodeId, at: asNumber(record.at, Date.now()) };
  if (typeof record.attempt === "number") event.attempt = record.attempt;
  const taskId = asOptionalString(record.taskId);
  if (taskId) event.taskId = taskId;
  const detail = asOptionalString(record.detail);
  if (detail) event.detail = detail;
  if (typeof record.pass === "boolean") event.pass = record.pass;
  const summary = asOptionalString(record.summary);
  if (summary) event.summary = summary;
  const artifactRefs = asArray(record.artifactRefs)
    .map((ref) => restoreWorkflowArtifactReference(ref))
    .filter((ref): ref is WorkflowArtifactReference => Boolean(ref));
  if (artifactRefs.length > 0) event.artifactRefs = artifactRefs;
  const error = asOptionalString(record.error);
  if (error) event.error = error;
  if (record.intervention !== undefined && isWorkflowV2HumanIntervention(record.intervention)) {
    event.intervention = structuredClone(record.intervention);
  }
  return event;
}

export function restoreEvent(raw: unknown): ChatEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isChatEventType(record.type) || typeof record.content !== "string") return null;
  const event: ChatEvent = {
    id: asOptionalString(record.id) ?? randomUUID(),
    type: record.type,
    content: record.content,
    timestamp: asNumber(record.timestamp, Date.now()),
  };
  if (isAgentId(record.agentId)) event.agentId = record.agentId;
  const name = asOptionalString(record.name);
  if (name) event.name = name;
  if (isAgentId(record.fromAgentId)) event.fromAgentId = record.fromAgentId;
  if (isAgentId(record.toAgentId)) event.toAgentId = record.toAgentId;
  const requestId = asOptionalString(record.requestId);
  if (requestId) event.requestId = requestId;
  if (isInteractionRequestState(record.requestState)) event.requestState = record.requestState;
  if (isApprovalDecision(record.decision)) event.decision = record.decision;
  const metadata = asRecord(record.metadata);
  if (metadata) event.metadata = metadata;
  return event;
}

export function restoreMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isMessageRole(record.role) || typeof record.content !== "string") return null;
  const message: ChatMessage = {
    id: asOptionalString(record.id) ?? randomUUID(),
    role: record.role,
    content: record.content,
    timestamp: asNumber(record.timestamp, Date.now()),
  };
  if (record.local === true) message.local = true;
  if (Array.isArray(record.events)) {
    const events = record.events.map((event) => restoreEvent(event)).filter((event): event is ChatEvent => Boolean(event));
    if (events.length > 0) message.events = events;
  }
  return message;
}

export function normalizeRestoredMessages(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "meta") {
      normalized.push(message);
      continue;
    }

    const event: ChatEvent = {
      id: message.id,
      type: "meta",
      content: message.content,
      timestamp: message.timestamp,
    };
    let target = [...normalized].reverse().find((item) => item.role === "assistant");
    if (!target) {
      target = createAssistantMessage();
      target.timestamp = message.timestamp;
      normalized.push(target);
    }
    target.events = [...(target.events ?? []), event];
  }
  return normalized;
}
