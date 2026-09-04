import type {
  AgentId,
  RuntimeInvocationRequest,
} from "../../../shared/types";
import { sanitizeWorkflowTransactionValue } from "../../../shared/workflow-v2/transaction";

const MAX_RUNTIME_INVOCATION_ERROR_CHARACTERS = 4_000;
const TRUNCATED_RUNTIME_INVOCATION_ERROR_SUFFIX = "\n...";

/** Durable lifecycle state for one AgentRecall Runtime dispatch. */
export type RuntimeInvocationStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Whether a dispatch created its bound Runtime Session or resumed an existing one. */
export type RuntimeSessionRelation = "created" | "continued";

/** Data written before a Runtime process is dispatched. */
export interface RuntimeInvocationStart {
  /** Stable identifier shared by the invocation row and all bindings. */
  id: string;
  /** Product process that owns the invocation record. */
  initiator: "agentrecall";
  /** Business surface and owner identifiers supplied by the caller. */
  invocation: RuntimeInvocationRequest;
  /** Runtime driver that receives the dispatch. */
  runtimeId: AgentId;
  /** Optional channel selected for this dispatch. */
  channelId?: string;
  /** Execution environment containing the native Runtime Session. */
  environmentId?: string;
  /** Unix epoch timestamp when the pending record is created. */
  startedAt: number;
}

/** Explicit link between a Runtime invocation and its native Session or Turn. */
export interface RuntimeSessionBinding {
  /** Runtime driver that owns the native Session identifier. */
  runtimeId: AgentId;
  /** Optional channel selected for this Session. */
  channelId?: string;
  /** Execution environment containing the native Session. */
  environmentId?: string;
  /** Native Session identifier emitted by the Runtime. */
  sessionId: string;
  /** Optional native Turn identifier emitted with the Session reference. */
  turnId?: string;
  /** Whether the invocation created or continued the Session. */
  relation: RuntimeSessionRelation;
  /** Unix epoch timestamp when the binding was observed. */
  boundAt: number;
}

/** Persistence boundary for Runtime invocation lifecycle and Session bindings. */
export interface RuntimeInvocationRecorder {
  /** Persists a pending invocation before dispatch begins. */
  begin(input: RuntimeInvocationStart): Promise<void>;
  /** Persists an explicit native Session or Turn binding. */
  bind(invocationId: string, binding: RuntimeSessionBinding): Promise<void>;
  /** Persists the terminal status and optional failure message. */
  finish(
    invocationId: string,
    status: Exclude<RuntimeInvocationStatus, "pending">,
    finishedAt: number,
    error?: string,
  ): Promise<void>;
}

/** Redacts credential-shaped data and bounds errors before they enter durable history. */
export function runtimeInvocationErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = sanitizeWorkflowTransactionValue(raw);
  const value = typeof sanitized === "string" ? sanitized : String(sanitized);
  return value.length <= MAX_RUNTIME_INVOCATION_ERROR_CHARACTERS
    ? value
    : `${value.slice(
        0,
        MAX_RUNTIME_INVOCATION_ERROR_CHARACTERS
          - TRUNCATED_RUNTIME_INVOCATION_ERROR_SUFFIX.length,
      )}${TRUNCATED_RUNTIME_INVOCATION_ERROR_SUFFIX}`;
}

/** No-op recorder used only by isolated tests without a database owner. */
export const NOOP_RUNTIME_INVOCATION_RECORDER: RuntimeInvocationRecorder = {
  begin: async () => undefined,
  bind: async () => undefined,
  finish: async () => undefined,
};

const missingRecorder = async (): Promise<never> => {
  throw new Error("A durable Runtime invocation recorder is required before dispatch.");
};

/** Fails before dispatch when production wiring omitted the durable ledger. */
export const MISSING_RUNTIME_INVOCATION_RECORDER: RuntimeInvocationRecorder = {
  begin: missingRecorder,
  bind: missingRecorder,
  finish: missingRecorder,
};
