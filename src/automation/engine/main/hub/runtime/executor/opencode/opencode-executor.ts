import { OpenCodeRunner } from "../../../../agents/opencode/opencode-runner";
import type { AgentExecutionContext, AgentExecutor, RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { modelFromRuntimeConfig } from "../agent-executor-types";

export class OpenCodeAgentExecutor implements AgentExecutor {
  private runner: OpenCodeRunner | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
  ) {}

  async start(): Promise<void> {
    const runner = new OpenCodeRunner({
      executable: this.context.runtime.command || this.options.executables.opencode,
      cwd: this.context.workDir,
      prompt: this.context.prompt,
      modelId: modelFromRuntimeConfig(this.context.runtimeConfig),
      onEvent: this.context.emit,
      onExit: this.context.onExit,
    });
    this.runner = runner;
    await runner.start();
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = undefined;
  }
}
