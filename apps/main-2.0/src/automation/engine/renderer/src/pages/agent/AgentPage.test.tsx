import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AgentChannel, ConfiguredAgent } from "../../../../shared/types";
import { AgentPage } from "./AgentPage";

describe("AgentPage", () => {
  test("uses one runtime configuration selector instead of separate runtime and channel selectors", () => {
    const channels: AgentChannel[] = [
      { id: "claude-default", agentId: "claude", label: "Claude default", models: [{ id: "default", label: "Default" }] },
      { id: "codex-default", agentId: "codex", label: "Codex default", models: [{ id: "default", label: "Default" }] },
    ];
    const agent: ConfiguredAgent = {
      id: "writer",
      name: "Writer",
      description: "",
      runtimeAgentId: "claude",
      channelId: "claude-default",
      modelId: "default",
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const markup = renderToStaticMarkup(<AgentPage
      channels={channels}
      configuredAgents={[agent]}
      selectedConfiguredAgentId={agent.id}
      status=""
      onSave={async () => undefined}
      onAddConfiguredAgent={() => undefined}
      onSelectConfiguredAgent={() => undefined}
      onUpdateConfiguredAgent={() => undefined}
    />);

    expect(markup.match(/aria-label="Agent runtime"/g)).toHaveLength(1);
    expect(markup).not.toContain("Agent execution config");
    expect(markup).toContain("Claude default · Claude Code");
    expect(markup).toContain("Codex default · Codex");
  });
});
