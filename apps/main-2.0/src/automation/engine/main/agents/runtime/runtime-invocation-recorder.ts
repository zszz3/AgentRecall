import type {
  AgentId,
  RuntimeInvocationRequest,
} from "../../../shared/types";

export type RuntimeInvocationStatus =
  | "pending"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type RuntimeSessionRelation = "created" | "continued";

export interface RuntimeInvocationStart {
  id: string;
  initiator: "agentrecall";
  invocation: RuntimeInvocationRequest;
  runtimeId: AgentId;
  channelId?: string;
  environmentId?: string;
  startedAt: number;
}

export interface RuntimeSessionBinding {
  runtimeId: AgentId;
  channelId?: string;
  environmentId?: string;
  sessionId: string;
  turnId?: string;
  relation: RuntimeSessionRelation;
  boundAt: number;
}

export interface RuntimeInvocationRecorder {
  begin(input: RuntimeInvocationStart): Promise<void>;
  bind(invocationId: string, binding: RuntimeSessionBinding): Promise<void>;
  finish(
    invocationId: string,
    status: Exclude<RuntimeInvocationStatus, "pending">,
    finishedAt: number,
    error?: string,
  ): Promise<void>;
}

export const NOOP_RUNTIME_INVOCATION_RECORDER: RuntimeInvocationRecorder = {
  begin: async () => undefined,
  bind: async () => undefined,
  finish: async () => undefined,
};
