import { describe, expect, test } from "vitest";

import type { WorkflowV2LLMNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2TaskPacket } from "../../../shared/workflow-v2/planning";
import { workflowV2LlmNodePrompt } from "./workflow-v2-node-policy";

describe("workflow-v2 node prompt policy", () => {
  test("requires exact output keys for downstream script bindings", () => {
    const node: WorkflowV2LLMNode = {
      id: "research",
      kind: "research",
      title: "Research",
      execModel: "llm",
      executionMode: "one-shot",
      prompt: "Research the answer.",
      outputFields: [{ key: "answer", required: true, valueType: "json" }],
    };
    const taskPacket: WorkflowV2TaskPacket = {
      nodeId: node.id,
      title: node.title,
      role: "executor",
      execModel: "llm",
      executionMode: "one-shot",
      executionModeRationale: "No user input is required.",
      executionModeConfidence: 1,
      modelProfile: "balanced",
      objective: "Research an answer",
      acceptanceCriteria: [{ key: "answer", description: "Return the answer", required: true }],
      constraints: [],
      upstreamDigest: [],
      outputFields: node.outputFields,
      downstreamRequirements: [{ downstreamNodeId: "publish", downstreamNodeTitle: "Publish", parameterKey: "content", parameterLabel: "Content", upstreamOutputKey: "answer", location: "body", valueType: "json", required: true }],
      budget: { context: { maxContextTokens: 1_000 } },
    };

    const messages = workflowV2LlmNodePrompt({
      node,
      taskPacket,
      upstreamOutputs: [],
      baseWorkflowContextDocument: "",
      storagePlanDocument: "# Workflow Storage Plan",
    });

    expect(messages.developerInstructions).toContain("exact keys and value types declared in taskPacket.outputFields");
    expect(messages.developerInstructions).toContain("taskPacket.downstreamRequirements");
    expect(messages.developerInstructions).toContain('"answer": {}');
    expect(messages.contextDocument).toContain('"downstreamNodeId": "publish"');
    expect(messages.contextDocument).toContain('"valueType": "json"');
  });
});
