import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { AgentChannel, AgentRuntime, ConfiguredAgent } from "../../../../shared/types";
import { ChatControls } from "./ChatControls";

const configuredAgent: ConfiguredAgent = {
  id: "reviewer",
  name: "Reviewer",
  description: "",
  runtimeAgentId: "codex",
  channelId: "codex-default",
  modelId: "gpt-5",
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

const channel: AgentChannel = {
  id: "codex-default",
  agentId: "codex",
  label: "Codex default",
  models: [{ id: "gpt-5", label: "GPT-5" }],
};

const runtime: AgentRuntime = {
  id: "codex",
  label: "Codex",
  command: "codex",
  version: "1.0.0",
  available: true,
};

function renderControls(showModelControl = true) {
  return renderToStaticMarkup(
    <ChatControls
      configuredAgentId={configuredAgent.id}
      modelId={configuredAgent.modelId}
      configuredAgents={[configuredAgent]}
      channels={[channel]}
      locked={false}
      running={false}
      workDir="C:\\workspace"
      runtimes={[runtime]}
      showModelControl={showModelControl}
      onSelectConfiguredAgent={() => undefined}
      onSelectModel={() => undefined}
      onChooseWorkDir={() => undefined}
    />,
  );
}

describe("ChatControls", () => {
  test("shows the model selector by default", () => {
    const markup = renderControls();

    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Configured agent"');
    expect(markup).toContain('aria-label="Agent model"');
  });

  test("can represent an agent profile with a single selector", () => {
    const markup = renderControls(false);

    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Configured agent"');
    expect(markup).not.toContain('aria-label="Agent model"');
  });
});
