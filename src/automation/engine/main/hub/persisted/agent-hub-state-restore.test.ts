import { describe, expect, test } from "vitest";
import { restoreConfiguredAgentState } from "./agent-hub-state-restore";

const channels = [{
  id: "codex-openai",
  label: "Codex",
  agentId: "codex" as const,
  models: [{ id: "default", label: "Default" }],
}];

describe("restoreConfiguredAgentState", () => {
  test("preserves valid MCP bindings and drops malformed entries", () => {
    const restored = restoreConfiguredAgentState({
      id: "agent",
      name: "Agent",
      runtimeAgentId: "codex",
      channelId: "codex-openai",
      modelId: "default",
      agentType: "composed",
      instructions: "Use the project conventions.",
      baseAgentId: "base-agent",
      currentRevisionId: "revision-3",
      revision: 3,
      mcpBindings: [
        { serverId: "filesystem", toolAllowlist: ["read_file", "read_file", 42] },
        { serverId: "", toolAllowlist: [] },
        null,
      ],
    }, {
      channels,
      channelById: (id) => channels.find((channel) => channel.id === id),
      defaultAgentId: "codex",
    }, 1);

    expect(restored?.mcpBindings).toEqual([
      { serverId: "filesystem", toolAllowlist: ["read_file"] },
    ]);
    expect(restored).toMatchObject({
      agentType: "composed",
      instructions: "Use the project conventions.",
      baseAgentId: "base-agent",
      currentRevisionId: "revision-3",
      revision: 3,
    });
  });
});
