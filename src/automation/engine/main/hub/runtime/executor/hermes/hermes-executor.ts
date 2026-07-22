import { HermesRunner } from "../../../../agents/hermes/hermes-runner";
import type {
  AgentExecutionContext,
  AgentExecutor,
  RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";
import { modelFromRuntimeConfig } from "../agent-executor-types";
import { promptWithDeveloperInstructions } from "../runtime-instructions";

export class HermesAgentExecutor implements AgentExecutor {
  private runner: HermesRunner | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
  ) {}

  async start(): Promise<void> {
    const runner = new HermesRunner({
      executable: this.context.runtime.command || this.options.executables.hermes,
      cwd: this.context.workDir,
      prompt: promptWithDeveloperInstructions(
        this.context.prompt,
        this.context.developerInstructions,
      ),
      modelId: modelFromRuntimeConfig(this.context.runtimeConfig),
      onEvent: this.context.emit,
      onExit: (code) => {
        this.context.onExit(code);
      },
    });
    this.runner = runner;
    await runner.start();
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = undefined;
  }
}
