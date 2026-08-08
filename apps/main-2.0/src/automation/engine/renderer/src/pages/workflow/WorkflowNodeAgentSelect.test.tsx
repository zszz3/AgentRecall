import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ConfiguredAgent } from "../../../../shared/types";
import { WorkflowNodeAgentSelect } from "./WorkflowNodeAgentSelect";

describe("WorkflowNodeAgentSelect", () => {
  test("selects one Agent Profile without a separate model selector", () => {
    const agent: ConfiguredAgent = {
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

    const markup = renderToStaticMarkup(
      <WorkflowNodeAgentSelect
        nodeTitle="Review"
        configuredAgentId={agent.id}
        configuredAgents={[agent]}
        onSelect={() => undefined}
      />,
    );

    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Agent for Review"');
    expect(markup).toContain("Reviewer · gpt-5");
    expect(markup).not.toContain("Select Model");
  });
});
