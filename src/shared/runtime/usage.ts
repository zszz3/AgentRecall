export interface RuntimeUsage {
  provider?: "openai" | "anthropic" | string;
  /** OpenAI prompt/input tokens include cached input; Anthropic input_tokens excludes cache read/write. */
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheWrite5mInputTokens?: number;
  cacheWrite1hInputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
}

export function mergeRuntimeUsage(current: RuntimeUsage, next: RuntimeUsage): RuntimeUsage {
  const merged: RuntimeUsage = { ...current, ...(next.provider ? { provider: next.provider } : {}) };
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadInputTokens", "cacheWriteInputTokens", "cacheWrite5mInputTokens", "cacheWrite1hInputTokens", "totalTokens", "estimatedCost"] as const) {
    if (next[key] !== undefined) merged[key] = (current[key] ?? 0) + next[key];
  }
  return merged;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function numberAt(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function hasUsage(value: RuntimeUsage): boolean {
  return Object.keys(value).some((key) => key !== "provider");
}

function compactUsage(value: RuntimeUsage): RuntimeUsage {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as RuntimeUsage;
}

export function normalizeOpenAIUsage(value: unknown): RuntimeUsage | undefined {
  const usage = recordOf(value);
  if (!usage) return undefined;
  const inputDetails = recordOf(usage.prompt_tokens_details) ?? recordOf(usage.input_tokens_details);
  const outputDetails = recordOf(usage.completion_tokens_details) ?? recordOf(usage.output_tokens_details);
  const normalized: RuntimeUsage = {
    provider: "openai",
    inputTokens: numberAt(usage, "prompt_tokens", "input_tokens"),
    outputTokens: numberAt(usage, "completion_tokens", "output_tokens"),
    reasoningTokens: numberAt(outputDetails, "reasoning_tokens"),
    cacheReadInputTokens: numberAt(inputDetails, "cached_tokens"),
    totalTokens: numberAt(usage, "total_tokens", "totalTokens"),
  };
  const compacted = compactUsage(normalized);
  return hasUsage(compacted) ? compacted : undefined;
}

export function normalizeAnthropicUsage(value: unknown): RuntimeUsage | undefined {
  const usage = recordOf(value);
  if (!usage) return undefined;
  const cacheCreation = recordOf(usage.cache_creation);
  const normalized: RuntimeUsage = {
    provider: "anthropic",
    inputTokens: numberAt(usage, "input_tokens"),
    outputTokens: numberAt(usage, "output_tokens"),
    cacheReadInputTokens: numberAt(usage, "cache_read_input_tokens"),
    cacheWriteInputTokens: numberAt(usage, "cache_creation_input_tokens"),
    cacheWrite5mInputTokens: numberAt(cacheCreation, "ephemeral_5m_input_tokens"),
    cacheWrite1hInputTokens: numberAt(cacheCreation, "ephemeral_1h_input_tokens"),
    totalTokens: numberAt(usage, "total_tokens", "totalTokens"),
  };
  const compacted = compactUsage(normalized);
  return hasUsage(compacted) ? compacted : undefined;
}
