import { describe, expect, test } from "vitest";
import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import { parseWorkflowV2WorkerArtifact } from "./workflow-v2-output-parser";

const node: WorkflowV2LLMNode = {
  id: "web-search-answer",
  kind: "web-qa",
  title: "Answer",
  execModel: "llm",
  role: "executor",
  prompt: "Answer the question.",
  outputFields: [
    { key: "answer_markdown", description: "User-facing answer" },
    { key: "source_links", description: "Sources" },
  ],
};

describe("parseWorkflowV2WorkerArtifact", () => {
  test("extracts a standard worker packet after agent progress text", () => {
    const expected = {
      nodeId: node.id,
      summary: "Latest model verified",
      outputs: { answer_markdown: "# Latest model\n\nGPT-5.6 Sol", source_links: ["https://developers.openai.com/api/docs/models"] },
      evidence: ["Official models page"],
      risks: [],
      nextStepSuggestions: [],
      proposals: [],
    };
    const artifact = `The question is clear. I will read the official docs.\n\nUsing official docs first.${JSON.stringify(expected)}`;
    expect(parseWorkflowV2WorkerArtifact(node, artifact)).toEqual(expected);
  });
});
