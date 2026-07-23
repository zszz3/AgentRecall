import { describe, expect, test } from "vitest";
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from "./usage";

describe("runtime usage normalization", () => {
  test("keeps OpenAI cached input separate from total prompt tokens", () => {
    expect(normalizeOpenAIUsage({
      input_tokens: 120,
      output_tokens: 30,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 10 },
    })).toEqual({
      provider: "openai",
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 10,
      cacheReadInputTokens: 80,
      totalTokens: 150,
    });
  });

  test("does not invent Anthropic cache totals when the provider omits them", () => {
    expect(normalizeAnthropicUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({
      provider: "anthropic",
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
