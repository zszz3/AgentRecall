import { apiRequestBody, apiRequestUrl, extractApiContent, extractApiUsage, resolveApiModel } from "./api-protocol";
import type {
  AgentExecutionContext,
  AgentExecutor,
  RuntimeAgentExecutorFactoryOptions,
} from "../agent-executor-types";
import { modelFromRuntimeConfig } from "../agent-executor-types";

export class ApiAgentExecutor implements AgentExecutor {
  private controller: AbortController | undefined;

  constructor(
    private readonly context: AgentExecutionContext,
    private readonly options: RuntimeAgentExecutorFactoryOptions,
  ) {}

  async start(): Promise<void> {
    const channel = this.options.channelById(this.context.channelId);
    if (!channel?.baseUrl) {
      this.context.emit({ type: "error", error: "API agent requires a provider base URL." });
      this.context.onExit(1);
      return;
    }

    const model = resolveApiModel(channel, modelFromRuntimeConfig(this.context.runtimeConfig));
    if (!model) {
      this.context.emit({ type: "error", error: "API agent requires a model." });
      this.context.onExit(1);
      return;
    }

    const controller = new AbortController();
    this.controller = controller;

    try {
      const response = await fetch(apiRequestUrl(channel), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(channel.httpHeaders ?? {}),
        },
        body: JSON.stringify(
          apiRequestBody(channel, model, this.context.prompt, this.context.developerInstructions),
        ),
      });

      const text = await response.text();
      if (!response.ok) {
        this.context.emit({ type: "error", error: `API request failed (${response.status}): ${text.slice(0, 800)}` });
        this.context.onExit(1);
        return;
      }

      const content = extractApiContent(channel, text);
      const usage = extractApiUsage(channel, text);
      this.context.emit({ type: "delta", content });
      if (usage) this.context.emit({ type: "usage", usage });
      this.context.emit({ type: "completed", content });
      this.context.onExit(0);
    } catch (error) {
      if (controller.signal.aborted) {
        this.context.onExit(null);
        return;
      }
      this.context.emit({ type: "error", error: error instanceof Error ? error.message : String(error) });
      this.context.onExit(1);
    }
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = undefined;
  }
}
