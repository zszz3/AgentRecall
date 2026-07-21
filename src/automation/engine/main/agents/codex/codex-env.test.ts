import { describe, expect, test } from "vitest";
import type { AgentChannel } from "../../../shared/types";
import { codexEnvironmentForChannel } from "./codex-env";

describe("codexEnvironmentForChannel", () => {
  test("maps channel authorization to per-process OPENAI_API_KEY", () => {
    const channel: AgentChannel = {
      id: "codex-deepseek",
      agentId: "codex",
      label: "Codex DeepSeek",
      modelProvider: "deepseek",
      httpHeaders: { Authorization: "Bearer provider-token" },
      models: [{ id: "default", label: "Default" }],
    };

    expect(codexEnvironmentForChannel(channel, { PATH: "/bin" })).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "provider-token",
    });
  });

  test("leaves non-Codex channels untouched", () => {
    const env = { PATH: "/bin" };
    const channel: AgentChannel = {
      id: "api-deepseek",
      agentId: "api",
      label: "DeepSeek API",
      httpHeaders: { Authorization: "Bearer provider-token" },
      models: [{ id: "default", label: "Default" }],
    };

    expect(codexEnvironmentForChannel(channel, env)).toEqual(env);
  });
});
