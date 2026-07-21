import type { AgentId, RuntimeConversation } from "../../../shared/types";

export interface RuntimeStateCodec<TState> {
  runtimeId: AgentId;
  restorePersistedConversation(raw: unknown): RuntimeConversation | undefined;
  cloneConversation(conversation: RuntimeConversation): RuntimeConversation | undefined;
  decodeConversation(conversation: RuntimeConversation | undefined): TState | undefined;
  encodeConversation(state: TState): RuntimeConversation;
}

export function asRuntimeStateRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asRuntimeStateString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asOptionalRuntimeStateStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => asRuntimeStateString(item))
    .filter((item): item is string => item !== undefined);
  return items.length === value.length ? items : undefined;
}

export function cloneRuntimeStateValue<T>(value: T): T {
  return structuredClone(value);
}

function asRuntimeConversationEnvelope(raw: unknown, runtimeId: AgentId): RuntimeConversation | undefined {
  const record = asRuntimeStateRecord(raw);
  if (!record) return undefined;
  if (record.runtimeId !== runtimeId) return undefined;
  if (record.codecVersion !== "v1") return undefined;
  if (!Object.prototype.hasOwnProperty.call(record, "payload")) return undefined;
  return {
    runtimeId,
    codecVersion: "v1",
    payload: cloneRuntimeStateValue(record.payload),
  };
}

function cloneEnvelope(runtimeId: AgentId, payload: unknown): RuntimeConversation {
  return {
    runtimeId,
    codecVersion: "v1",
    payload: cloneRuntimeStateValue(payload),
  };
}

export function createRuntimeStateCodec<TState>(input: {
  runtimeId: AgentId;
  decodePayload: (raw: unknown) => TState | undefined;
}): RuntimeStateCodec<TState> {
  return {
    runtimeId: input.runtimeId,
    restorePersistedConversation(raw: unknown): RuntimeConversation | undefined {
      const envelope = asRuntimeConversationEnvelope(raw, input.runtimeId);
      if (!envelope) return undefined;
      const decoded = input.decodePayload(envelope.payload);
      return decoded ? cloneEnvelope(input.runtimeId, decoded) : undefined;
    },
    cloneConversation(conversation: RuntimeConversation): RuntimeConversation | undefined {
      const decoded = this.decodeConversation(conversation);
      return decoded ? this.encodeConversation(decoded) : undefined;
    },
    decodeConversation(conversation: RuntimeConversation | undefined): TState | undefined {
      if (!conversation || conversation.runtimeId !== input.runtimeId || conversation.codecVersion !== "v1") return undefined;
      return input.decodePayload(conversation.payload);
    },
    encodeConversation(state: TState): RuntimeConversation {
      return cloneEnvelope(input.runtimeId, state);
    },
  };
}
