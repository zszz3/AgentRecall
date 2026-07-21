import { RuntimeRouter } from "../../../agents/runtime/runtime-router";
import { RuntimeDriverRegistry } from "../../../agents/runtime/runtime-driver";
import type {
  AgentExecutionContext,
  AgentExecutor,
  AgentExecutorFactory,
  RuntimeAgentExecutorFactoryOptions,
} from "./agent-executor-types";
import { createApiDriver } from "./api/create-api-driver";
import { createClaudeDriver } from "./claude/create-claude-driver";
import { createCodexDriver } from "./codex/create-codex-driver";
import { createHermesDriver } from "./hermes/create-hermes-driver";
import { createOpenCodeDriver } from "./opencode/create-opencode-driver";
import { createOpenClawDriver } from "./openclaw/create-openclaw-driver";

export { RuntimeDriverRegistry } from "../../../agents/runtime/runtime-driver";
export type {
  AgentExecutionContext,
  AgentExecutor,
  AgentExecutorFactory,
  RuntimeAgentExecutorFactoryOptions,
} from "./agent-executor-types";

export function createRuntimeDriverRegistry(options: RuntimeAgentExecutorFactoryOptions): RuntimeDriverRegistry {
  return new RuntimeDriverRegistry([
    createCodexDriver(options),
    createClaudeDriver(options),
    createApiDriver(options),
    createHermesDriver(options),
    createOpenCodeDriver(options),
    createOpenClawDriver(options),
  ]);
}

export class RuntimeAgentExecutorFactory implements AgentExecutorFactory {
  constructor(private readonly router: RuntimeRouter) {}

  create(context: AgentExecutionContext): AgentExecutor {
    return this.router.createOneShotExecutor(context);
  }
}
