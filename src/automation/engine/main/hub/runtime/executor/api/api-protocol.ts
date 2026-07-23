import { DEFAULT_MODEL_ID, runtimeModelId } from "../../../../../shared/models";
import type { AgentChannel } from "../../../../../shared/types";
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from "../../../../../../../shared/runtime/usage";

export function resolveApiModel(channel: AgentChannel, modelId: string): string | undefined {
  const model = runtimeModelId(modelId);
  if (model) return model;
  return channel.models.find((item) => item.id !== DEFAULT_MODEL_ID)?.id;
}

export function apiRequestUrl(channel: AgentChannel): string {
  if (channel.modelProvider === "anthropic-api") {
    const normalized = (channel.baseUrl ?? "").replace(/\/+$/, "");
    if (normalized.endsWith("/messages")) return normalized;
    return `${normalized}/messages`;
  }
  return chatCompletionsUrl(channel.baseUrl ?? "");
}

export function apiRequestBody(
  channel: AgentChannel,
  model: string,
  prompt: string,
  system?: string,
): Record<string, unknown> {
  if (channel.modelProvider === "anthropic-api") {
    return {
      model,
      max_tokens: 4096,
      system: system || undefined,
      messages: [{ role: "user", content: prompt }],
    };
  }
  return {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: prompt },
    ],
    stream: false,
  };
}

export function extractApiContent(channel: AgentChannel, text: string): string {
  if (channel.modelProvider === "anthropic-api") {
    const parsed = JSON.parse(text) as { content?: Array<{ type?: string; text?: unknown }> };
    const content = parsed.content
      ?.map((item) => (typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("");
    if (content) return content;
    return JSON.stringify(parsed, null, 2);
  }
  const parsed = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    output_text?: unknown;
  };
  const first = parsed.choices?.[0];
  const content = first?.message?.content ?? first?.text ?? parsed.output_text;
  return typeof content === "string" ? content : JSON.stringify(parsed, null, 2);
}

export function extractApiUsage(channel: AgentChannel, text: string) {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return channel.modelProvider === "anthropic-api"
    ? normalizeAnthropicUsage(parsed.usage)
    : normalizeOpenAIUsage(parsed.usage);
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}
