import { OpenClawRunner } from "../../../../agents/openclaw/openclaw-runner";
import type { AgentExecutionContext, AgentExecutor, RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { modelFromRuntimeConfig } from "../agent-executor-types";
import { promptWithDeveloperInstructions } from "../runtime-instructions";

export class OpenClawAgentExecutor implements AgentExecutor {
  private runner: OpenClawRunner | undefined;
  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
  ) {}

  async start(): Promise<void> {
    const runner = new OpenClawRunner({
      executable: this.context.runtime.command || this.options.executables.openclaw,
      cwd: this.context.workDir,
      prompt: promptWithDeveloperInstructions(
        this.context.prompt,
        this.context.developerInstructions,
      ),
      sessionKey: `agent-recall-${this.context.runId}`,
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
