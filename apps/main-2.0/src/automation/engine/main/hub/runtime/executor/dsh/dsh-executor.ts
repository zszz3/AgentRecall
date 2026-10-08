import { dshRuntimeStateCodec } from "../../../../agents/dsh/dsh-runtime-state-codec";
import { DshRunner } from "../../../../agents/dsh/dsh-runner";
import type {
  AgentExecutionContext,
  AgentExecutor,
  RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";
import { modelFromRuntimeConfig } from "../agent-executor-types";
import { promptWithDeveloperInstructions } from "../runtime-instructions";
import { assertDshDefaultModel, dshEnvironment } from "./dsh-config";
import type {
  DshRunnerFactory,
  DshRunnerHandle,
} from "./dsh-runtime-lifecycle";

export class DshAgentExecutor implements AgentExecutor {
  private runner: DshRunnerHandle | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
    private readonly createRunner: DshRunnerFactory =
      (runnerOptions) => new DshRunner(runnerOptions),
  ) {}

  async start(): Promise<void> {
    try {
      assertDshDefaultModel(modelFromRuntimeConfig(this.context.runtimeConfig));
    } catch (error) {
      this.context.emit({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      this.context.onExit(1);
      return;
    }

    const runner = this.createRunner({
      executable: this.context.runtime.command || this.options.executables.dsh,
      cwd: this.context.workDir,
      env: dshEnvironment(this.options.channelById(this.context.channelId)),
      sessionId: this.context.continuationPolicy === "fresh" ? undefined
        : dshRuntimeStateCodec.decodeConversation(this.context.runtimeConversation)?.native.sessionId,
      prompt: promptWithDeveloperInstructions(
        this.context.prompt,
        this.context.developerInstructions,
      ),
      onEvent: this.context.emit,
      onExit: this.context.onExit,
    });
    this.runner = runner;
    try {
      await runner.start();
    } finally {
      if (this.runner === runner) this.runner = undefined;
    }
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
  }
}
