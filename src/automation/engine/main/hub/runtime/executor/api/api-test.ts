import type { RuntimeChannelTestContext } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { RUNTIME_CHANNEL_TEST_PROMPT, RUNTIME_CHANNEL_TEST_TIMEOUT_MS } from "../runtime-test-constants";
import { apiRequestBody, apiRequestUrl, extractApiContent, resolveApiModel } from "./api-protocol";

export async function runApiChannelTest(
  input: RuntimeChannelTestContext,
  options: RuntimeAgentExecutorFactoryOptions,
): Promise<string> {
  const channel = options.channelById(input.channelId);
  if (!channel) throw new Error(`Channel ${input.channelId} was not found.`);
  if (!channel.baseUrl) throw new Error("API agent requires a provider base URL.");
  const model = resolveApiModel(channel, input.modelId);
  if (!model) throw new Error("API agent requires a model.");
  input.emit({ type: "phase", content: `Sending HTTP request to ${apiRequestUrl(channel)} with model ${model}.` });
  const response = await fetch(apiRequestUrl(channel), {
    method: "POST",
    signal: AbortSignal.timeout(RUNTIME_CHANNEL_TEST_TIMEOUT_MS),
    headers: {
      "content-type": "application/json",
      ...(channel.httpHeaders ?? {}),
    },
    body: JSON.stringify(
      apiRequestBody(channel, model, RUNTIME_CHANNEL_TEST_PROMPT, "You are testing whether this configured agent can respond."),
    ),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API test failed (${response.status}): ${text.slice(0, 800)}`);
  const output = extractApiContent(channel, text).trim();
  if (!output) throw new Error("API returned an empty response.");
  input.emit({ type: "assistant", content: output });
  return output;
}
