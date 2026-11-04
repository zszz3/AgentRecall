import type { AgentOneShotResponse } from "../../../../../shared/types";
import type { RuntimeOneShotRequest } from "../../../../agents/runtime/runtime-driver";
import type { RuntimeAgentExecutorFactoryOptions } from "../agent-executor-types";
import { apiRequestBody, apiRequestUrl, extractApiContent, resolveApiModel } from "./api-protocol";
import { combineDeveloperInstructions } from "../runtime-instructions";

export async function runApiOneShot(
  input: RuntimeOneShotRequest,
  options: RuntimeAgentExecutorFactoryOptions,
): Promise<AgentOneShotResponse> {
  const channel = options.channelById(input.channelId);
  if (!channel?.baseUrl) throw new Error("API agent requires a provider base URL");
  const model = resolveApiModel(channel, input.runtimeConfig.model);
  if (!model) throw new Error("API agent requires a model");

  const response = await fetch(apiRequestUrl(channel), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(channel.httpHeaders ?? {}),
    },
    body: JSON.stringify(apiRequestBody(
      channel,
      model,
      input.prompt,
      combineDeveloperInstructions(input.developerInstructions),
    )),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`API request failed (${response.status}): ${text.slice(0, 800)}`);
  const content = extractApiContent(channel, text).trim();
  if (!content) throw new Error("API agent returned an empty response.");
  input.onEvent?.({ requestId: input.requestId, type: "delta", content });
  input.onEvent?.({ requestId: input.requestId, type: "completed", content });
  return { content };
}
