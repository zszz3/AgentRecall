import { describe, expect, test } from "vitest";
import type { AgentChannel } from "../../../shared/types";
import { claudeCliModelForChannel, claudeEnvironmentForChannel } from "./claude-env";

describe("claudeEnvironmentForChannel", () => {
  test("maps DeepSeek Anthropic channels to Claude Code environment variables", () => {
    const channel: AgentChannel = {
      id: "claude-code-deepseek",
      agentId: "claude",
      label: "Claude Code DeepSeek",
      providerName: "DeepSeek",
      modelProvider: "deepseek-anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      httpHeaders: { Authorization: "Bearer test-token" },
      models: [{ id: "claude-opus-4-8", label: "DeepSeek V4 Pro" }],
    };

    expect(claudeEnvironmentForChannel(channel, "claude-opus-4-8", { PATH: "/bin", ANTHROPIC_API_KEY: "old-key" })).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "test-token",
      ANTHROPIC_API_KEY: "test-token",
      ANTHROPIC_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-8",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    });
  });

  test("maps existing DeepSeek model selections to Claude names accepted by Claude Code", () => {
    const channel: AgentChannel = {
      id: "claude-code-deepseek",
      agentId: "claude",
      label: "Claude Code DeepSeek",
      providerName: "DeepSeek",
      modelProvider: "deepseek-anthropic",
      baseUrl: "https://api.deepseek.com/anthropic",
      httpHeaders: { Authorization: "Bearer test-token" },
      models: [
        { id: "default", label: "Default" },
        { id: "claude-sonnet-4-6", label: "Old Sonnet" },
        { id: "claude-haiku-4-5", label: "Old Haiku" },
      ],
    };

    expect(claudeEnvironmentForChannel(channel, "default", { PATH: "/bin" }).ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(claudeEnvironmentForChannel(channel, "claude-sonnet-4-6", { PATH: "/bin" }).ANTHROPIC_MODEL).toBe("claude-opus-4-8");
    expect(claudeEnvironmentForChannel(channel, "claude-haiku-4-5", { PATH: "/bin" }).ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
    expect(claudeEnvironmentForChannel(channel, "deepseek-v4-pro[1m]", { PATH: "/bin" }).ANTHROPIC_MODEL).toBe("claude-opus-4-8");
    expect(claudeEnvironmentForChannel(channel, "deepseek-v4-flash", { PATH: "/bin" }).ANTHROPIC_MODEL).toBe("claude-haiku-4-5");
  });

  test("passes provider model through CLI for Anthropic-compatible provider channels", () => {
    const channel: AgentChannel = {
      id: "claude-code-deepseek",
      agentId: "claude",
      label: "Claude Code DeepSeek",
      modelProvider: "deepseek-anthropic",
      models: [{ id: "claude-opus-4-8", label: "DeepSeek V4 Pro" }],
    };

    expect(claudeCliModelForChannel(channel, "deepseek-v4-pro[1m]")).toBe("claude-opus-4-8");
    expect(claudeCliModelForChannel(channel, "default")).toBe("claude-haiku-4-5");
    expect(claudeCliModelForChannel(undefined, "claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  test("maps other Anthropic-compatible Claude Code providers", () => {
    const channel: AgentChannel = {
      id: "claude-code-glm",
      agentId: "claude",
      label: "Claude Code GLM",
      providerName: "Zhipu GLM",
      modelProvider: "glm-anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic",
      httpHeaders: { Authorization: "Bearer glm-token" },
      models: [
        { id: "default", label: "Default" },
        { id: "glm-5.1", label: "GLM-5.1" },
      ],
    };

    expect(claudeEnvironmentForChannel(channel, "default", { PATH: "/bin" })).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "glm-token",
      ANTHROPIC_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.1",
      CLAUDE_CODE_SUBAGENT_MODEL: "glm-5.1",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    });
  });

  test("leaves plain Claude channels untouched", () => {
    const env = { PATH: "/bin" };
    const channel: AgentChannel = {
      id: "claude-code",
      agentId: "claude",
      label: "Claude Code",
      models: [{ id: "default", label: "Default" }],
    };

    expect(claudeEnvironmentForChannel(channel, "default", env)).toBe(env);
  });

  test("applies model roles to the official Claude channel", () => {
    const channel: AgentChannel = {
      id: "claude-code",
      agentId: "claude",
      label: "Claude Code",
      environment: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-custom" },
      models: [{ id: "default", label: "Default" }],
    };

    expect(claudeEnvironmentForChannel(channel, "default", { PATH: "/bin" })).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-custom",
    });
  });

  test("applies CC Switch compatible Claude provider fields", () => {
    const channel = {
      id: "claude-custom",
      agentId: "claude",
      label: "Claude Custom",
      modelProvider: "custom-anthropic",
      baseUrl: "https://claude.example/v1/messages",
      apiKeyField: "ANTHROPIC_API_KEY",
      customUserAgent: "multi-agent-chat/test",
      environment: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-opus",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "provider-sonnet",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-haiku",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "provider-fable",
        CLAUDE_CODE_SUBAGENT_MODEL: "provider-subagent",
        CLAUDE_CODE_EFFORT_LEVEL: "high",
      },
      httpHeaders: { Authorization: "Bearer provider-key" },
      models: [{ id: "provider-sonnet", label: "Provider Sonnet" }],
    } as AgentChannel;

    const result = claudeEnvironmentForChannel(channel, "provider-sonnet", { PATH: "/bin" });

    expect(result).toMatchObject({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "https://claude.example/v1/messages",
      ANTHROPIC_API_KEY: "provider-key",
      ANTHROPIC_MODEL: "provider-sonnet",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "provider-opus",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "provider-sonnet",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "provider-haiku",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "provider-fable",
      CLAUDE_CODE_SUBAGENT_MODEL: "provider-subagent",
      CLAUDE_CODE_EFFORT_LEVEL: "high",
      CLAUDE_AGENT_SDK_CLIENT_APP: "multi-agent-chat/test",
    });
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});
