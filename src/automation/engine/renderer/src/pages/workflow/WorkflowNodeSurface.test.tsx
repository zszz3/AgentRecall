import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorkflowNodeSurface } from "./WorkflowNodeSurface";

describe("WorkflowNodeSurface", () => {
  test("passes an editable LLM node prompt into the agent surface", () => {
    const html = renderToStaticMarkup(<WorkflowNodeSurface
      node={{ id: "agent", kind: "analysis", title: "Analyze", execModel: "llm", executionMode: "one-shot", prompt: "Analyze the repository.", outputFields: [] }}
      editable
      onUpdateNode={() => undefined}
      onClose={() => undefined}
    />);
    expect(html).toContain("Agent node prompt editor");
    expect(html).toContain("Analyze the repository.");
    expect(html).toContain("Edit prompt");
  });

  test("dispatches script nodes to the script surface without agent UI", () => {
    const html = renderToStaticMarkup(<WorkflowNodeSurface
      node={{ id: "script", kind: "transform", title: "Transform", execModel: "script", executionMode: "script", script: { executable: { kind: "inline", language: "typescript", code: "return inputs;" }, parameters: [], capabilities: [], managerRisk: { level: "safe", rationale: "Pure transform." } }, outputFields: [] }}
      onClose={() => undefined}
    />);
    expect(html).toContain("Transform script details");
    expect(html).not.toContain("workflow-node-agent-window");
  });
});
