import { claudeCliModelForChannel } from "../../../../agents/claude/claude-env";
import type { ClaudeAgentSdkAdapter } from "../../../../agents/claude/claude-agent-sdk";
import type { RuntimeChannelTestContext } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { RUNTIME_CHANNEL_TEST_PROMPT } from "../runtime-test-constants";

export async function runClaudeChannelTest(
  input: RuntimeChannelTestContext,
  options: RuntimeAgentExecutorFactoryOptions,
  adapter: Pick<ClaudeAgentSdkAdapter, "runOneShot">,
): Promise<string> {
  const channel = options.channelById(input.channelId);
  if (!channel) throw new Error(`Channel ${input.channelId} was not found.`);
  const sdkModel = claudeCliModelForChannel(channel, input.modelId);
  input.emit({ type: "phase", content: `Launching Claude Code with model ${sdkModel ?? "default"}.` });

  let output = "";
  let completedContent: string | undefined;
  let emittedAssistant = false;
  let errorMessage: string | undefined;

  try {
    await adapter.runOneShot({
      prompt: RUNTIME_CHANNEL_TEST_PROMPT,
      cwd: input.workDir,
      ...(sdkModel ? { modelId: sdkModel } : {}),
      onEvent: (event) => {
        if (event.type === "delta") {
          output += event.content;
          input.emit({ type: "assistant_delta", content: event.content });
          return;
        }
        if (event.type === "completed") {
          if (event.content) {
            completedContent = event.content;
            if (!emittedAssistant) {
              input.emit({ type: "assistant", content: event.content });
              emittedAssistant = true;
            }
          }
          return;
        }
        if (event.type === "tool_call" || event.type === "tool_result") {
          input.emit({ type: "tool", content: event.content });
          return;
        }
        if (event.type === "error") {
          errorMessage = event.error;
          input.emit({ type: "error", content: event.error });
        }
      },
    });
  } catch (error) {
    throw errorMessage
      ? new Error(errorMessage)
      : error instanceof Error
        ? error
        : new Error(String(error));
  }

  const finalOutput = completedContent?.trim() || output.trim();
  if (finalOutput) return finalOutput;
  throw new Error("Claude completed without assistant text.");
}
