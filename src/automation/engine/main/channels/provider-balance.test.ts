import { describe, expect, test, vi } from "vitest";
import { queryProviderBalance } from "./provider-balance";
import type { AgentChannel } from "../../shared/types";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("provider balance queries", () => {
  test("queries Codex OpenAI subscription quota from OAuth auth data", async () => {
    const codexUsageFetcher = vi.fn(async () => ({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 25, reset_after_seconds: 3600 },
        secondary_window: { percent_left: 80, reset_after_seconds: 86_400 },
      },
      code_review_rate_limit: {
        primary_window: { remaining_percent: 90, reset_after_seconds: 7200 },
      },
    }));

    const result = await queryProviderBalance(
      {
        id: "codex-openai",
        agentId: "codex",
        label: "Codex OpenAI",
        providerName: "OpenAI",
        modelProvider: "openai",
        models: [],
      },
      {
        now: () => 1710000000000,
        codexAuth: { tokens: { access_token: "codex-token", account_id: "acct-1" } },
        codexUsageFetcher,
      },
    );

    expect(codexUsageFetcher).toHaveBeenCalledWith("codex-token", "acct-1");
    expect(result).toMatchObject({
      channelId: "codex-openai",
      providerName: "Codex",
      supported: true,
      status: "success",
      message: "Codex subscription quota loaded.",
      items: [
        { label: "Plus · 5h", remaining: 75, used: 25, total: 100, unit: "%", isValid: true },
        { label: "Plus · 7d", remaining: 80, used: 20, total: 100, unit: "%", isValid: true },
        { label: "Plus · Review", remaining: 90, used: 10, total: 100, unit: "%", isValid: true },
      ],
    });
  });

  test("queries DeepSeek balance using the configured bearer token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
      }),
    );
    const channel: AgentChannel = {
      id: "deepseek-api",
      agentId: "api",
      label: "DeepSeek API",
      providerName: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      httpHeaders: { Authorization: "Bearer sk-deepseek" },
      models: [],
    };

    const result = await queryProviderBalance(channel, { fetch: fetchImpl, now: () => 1710000000000 });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk-deepseek", Accept: "application/json" }),
      }),
    );
    expect(result).toMatchObject({
      channelId: "deepseek-api",
      supported: true,
      status: "success",
      queriedAt: 1710000000000,
      items: [{ label: "CNY", remaining: 12.34, unit: "CNY", isValid: true }],
    });
  });

  test("computes OpenRouter remaining credits from total credits and usage", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: { total_credits: 20, total_usage: 7.5 },
      }),
    );

    const result = await queryProviderBalance(
      {
        id: "openrouter",
        agentId: "api",
        label: "OpenRouter",
        providerName: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        httpHeaders: { Authorization: "Bearer sk-openrouter" },
        models: [],
      },
      { fetch: fetchImpl, now: () => 1710000000000 },
    );

    expect(result).toMatchObject({
      supported: true,
      status: "success",
      items: [{ label: "OpenRouter", remaining: 12.5, total: 20, used: 7.5, unit: "USD", isValid: true }],
    });
  });

  test("returns a missing key state without calling the provider", async () => {
    const fetchImpl = vi.fn();

    const result = await queryProviderBalance(
      {
        id: "deepseek-api",
        agentId: "api",
        label: "DeepSeek API",
        providerName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        models: [],
      },
      { fetch: fetchImpl, now: () => 1710000000000 },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      supported: true,
      status: "missing_key",
      message: "API Key is not configured.",
      items: [],
    });
  });

  test("returns unsupported state for providers without a known balance endpoint", async () => {
    const fetchImpl = vi.fn();

    const result = await queryProviderBalance(
      {
        id: "volcengine",
        agentId: "api",
        label: "Volcengine",
        providerName: "Volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        httpHeaders: { Authorization: "Bearer sk-volc" },
        models: [],
      },
      { fetch: fetchImpl, now: () => 1710000000000 },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      supported: false,
      status: "unsupported",
      message: "Balance query is not supported for this provider.",
      items: [],
    });
  });
});
