import type {
  AgentEvent,
  AgentId,
  AgentRuntime,
  AgentTestEvent,
  ChatRuntimeSessionState,
  RuntimeContinuationPolicy,
  RuntimeConversation,
  RuntimeExecutionMode,
  RuntimeRequest,
  WorkflowAgentEvent,
  WorkflowAgentResponse,
} from "../../../shared/types";
import type { AgentExecutionContext, AgentExecutor } from "../../hub/runtime/executor/agent-executor";
import type { RuntimeCapabilities } from "./runtime-capabilities";
import type { RuntimeStateCodec } from "./runtime-state-codec";

export type RuntimeSurface = "chat" | "task" | "workflow" | "channel-test" | "cleanup";

export interface RuntimeSurfaceSupport {
  surface: RuntimeSurface;
  executionModes: RuntimeExecutionMode[];
  continuationPolicies: RuntimeContinuationPolicy[];
}

export interface InteractiveSessionSnapshot {
  runtimeState: ChatRuntimeSessionState;
  runtimeConversation?: RuntimeConversation;
}

export interface InteractiveSessionContext extends RuntimeRequest {
  chatId: string;
  configuredAgentId: string;
  runtime: AgentRuntime;
  channelId: string;
  workDir: string;
  planningWorkflowId?: string;
  developerInstructions: string;
  emit: (event: AgentEvent) => void;
  syncState?: (state: InteractiveSessionSnapshot) => void;
}

export interface RuntimeWorkflowRequestContext extends RuntimeRequest {
  planningWorkflowId?: string;
  requestId: string;
  prompt: string;
  runtime: AgentRuntime;
  channelId: string;
  workDir: string;
  onEvent?: ((event: WorkflowAgentEvent) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface RuntimeChannelTestContext {
  runtime: AgentRuntime;
  channelId: string;
  modelId: string;
  workDir: string;
  emit: (event: Omit<AgentTestEvent, "agentId" | "timestamp">) => void;
}

export interface RuntimeSessionCleanupContext {
  workDir: string;
  runtimeConversation?: RuntimeConversation;
}

export interface InteractiveSession {
  reconfigure(context: InteractiveSessionContext): void;
  ensureAttached(): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  detach(reason: "idle_timeout" | "app_shutdown" | "error"): Promise<void>;
  detachIfStillExpired(input: {
    expectedGeneration: number;
    expectedLastMeaningfulActivityAt: number;
    reason: "idle_timeout" | "app_shutdown" | "error";
  }): Promise<void>;
  snapshot(): InteractiveSessionSnapshot;
}

export interface RuntimeDriver {
  runtimeId: AgentId;
  surfaceSupport: RuntimeSurfaceSupport[];
  runtimeStateCodec?: RuntimeStateCodec<unknown> | undefined;
  getCapabilities(runtime: AgentRuntime): RuntimeCapabilities;
  createOneShotExecutor?: ((context: AgentExecutionContext) => AgentExecutor) | undefined;
  createInteractiveSession?: ((context: InteractiveSessionContext) => InteractiveSession) | undefined;
  askWorkflow?: ((input: RuntimeWorkflowRequestContext) => Promise<WorkflowAgentResponse>) | undefined;
  testChannel?: ((input: RuntimeChannelTestContext) => Promise<string>) | undefined;
  deleteSessionArtifacts?: ((input: RuntimeSessionCleanupContext) => Promise<void>) | undefined;
}

export class RuntimeDriverRegistry {
  constructor(private readonly drivers: RuntimeDriver[]) {
    for (const driver of drivers) {
      if (!Array.isArray(driver.surfaceSupport)) {
        throw new Error(`Runtime driver ${driver.runtimeId} must declare surfaceSupport explicitly.`);
      }
      if (driver.runtimeStateCodec && driver.runtimeStateCodec.runtimeId !== driver.runtimeId) {
        throw new Error(
          `Runtime driver ${driver.runtimeId} cannot register codec ${driver.runtimeStateCodec.runtimeId}.`,
        );
      }
    }
  }

  driverFor(agentId: AgentId): RuntimeDriver {
    const driver = this.maybeDriverFor(agentId);
    if (!driver) throw new Error(`No runtime driver registered for ${agentId}`);
    return driver;
  }

  maybeDriverFor(agentId: AgentId): RuntimeDriver | undefined {
    return this.drivers.find((item) => item.runtimeId === agentId);
  }
}
