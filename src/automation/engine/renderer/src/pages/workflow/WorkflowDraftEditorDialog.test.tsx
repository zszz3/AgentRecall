import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { ConfiguredAgent, WorkflowV2Definition } from "../../../../shared/types";
import { updateWorkflowNodeAgentSelection, WorkflowDraftEditorDialog } from "./WorkflowDraftEditorDialog";

const agent: ConfiguredAgent = { id: "specialist", name: "Specialist", description: "", runtimeAgentId: "codex", channelId: "default", modelId: "gpt-specialist", tags: [], createdAt: 1, updatedAt: 1 };
const definition: WorkflowV2Definition = { workflowId: "wf", graphVersion: 1, objective: "Answer", nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: "specialist", prompt: "Answer.", outputFields: [{ key: "answer", required: true }] }], edges: [] };

describe("WorkflowDraftEditorDialog", () => {
  test("renders a configured-agent selector for every LLM node", () => {
    const html = renderToStaticMarkup(<WorkflowDraftEditorDialog definition={definition} configuredAgents={[agent]} onSave={() => undefined} onClose={() => undefined} />);
    expect(html).toContain("Agent for Answer");
    expect(html).toContain("Workflow default");
    expect(html).toContain("Specialist · gpt-specialist");
    expect(html).toContain('value="specialist" selected=""');
  });

  test("stores a node override and can restore workflow-default routing", () => {
    const withModel = structuredClone(definition);
    const node = withModel.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.modelId = "old-model";
    const selected = updateWorkflowNodeAgentSelection(withModel, "answer", "specialist");
    expect(selected.nodes[0]).toMatchObject({ configuredAgentId: "specialist" });
    expect(selected.nodes[0]).not.toHaveProperty("modelId");
    const inherited = updateWorkflowNodeAgentSelection(selected, "answer", "");
    expect(inherited.nodes[0]).not.toHaveProperty("configuredAgentId");
  });
});
