import { describe, expect, test } from "vitest";
import type { AgentChannel, ConfiguredAgent, McpServerDefinition, WorkflowDraftState } from "../../../shared/types";
import { inspectWorkflowReadiness } from "./workflow-readiness";

const channel: AgentChannel = { id: "channel-a", agentId: "codex", label: "Codex", models: [{ id: "model-a", label: "Model A" }] };
const agent: ConfiguredAgent = {
  id: "agent-a", name: "Agent A", description: "", runtimeAgentId: "codex", channelId: "channel-a", modelId: "model-a", tags: [],
  mcpBindings: [{ serverId: "server-a", toolAllowlist: ["search"] }], createdAt: 1, updatedAt: 1,
};
const server: McpServerDefinition = {
  id: "server-a", name: "Server", transport: "stdio", command: "synthetic", args: [], env: {}, enabled: true,
  tools: [{ name: "search", inputSchema: {}, readOnly: true }], status: "connected", createdAt: 1, updatedAt: 1,
};

function workflow(): Pick<WorkflowDraftState, "configuredAgentId" | "modelId" | "reviewerConfiguredAgentId" | "reviewerModelId" | "definition"> {
  return {
    configuredAgentId: "agent-a",
    modelId: "model-a",
    reviewerConfiguredAgentId: "agent-a",
    reviewerModelId: "model-a",
    definition: {
      workflowId: "wf-ready",
      graphVersion: 1,
      objective: "Ready",
      reviewEnabled: true,
      nodes: [{ id: "answer", kind: "answer", title: "Answer", execModel: "llm", executionMode: "one-shot", configuredAgentId: "agent-a", prompt: "Answer", outputFields: [{ key: "answer" }], requiredTools: ["search"] }],
      edges: [],
    },
  };
}

describe("workflow readiness", () => {
  test("accepts exact Agent, model, and tool identifiers", () => {
    expect(inspectWorkflowReadiness({ workflow: workflow(), configuredAgents: [agent], channels: [channel], mcpServers: [server] })).toEqual({ ready: true, issues: [] });
  });

  test("does not require a reviewer while Review is disabled", () => {
    const draft = workflow();
    draft.definition.reviewEnabled = false;
    draft.reviewerConfiguredAgentId = "";
    draft.reviewerModelId = "";

    expect(inspectWorkflowReadiness({ workflow: draft, configuredAgents: [agent], channels: [channel], mcpServers: [server] })).toEqual({ ready: true, issues: [] });
  });

  test("treats an empty MCP allowlist as all server tools, matching runtime routing", () => {
    const unrestrictedAgent = { ...agent, mcpBindings: [{ serverId: "server-a", toolAllowlist: [] }] };
    expect(inspectWorkflowReadiness({ workflow: workflow(), configuredAgents: [unrestrictedAgent], channels: [channel], mcpServers: [server] })).toEqual({ ready: true, issues: [] });
  });

  test("checks each Review Gate Agent without a separate tool route", () => {
    const draft = workflow();
    draft.definition.reviewEnabled = false;
    draft.definition.reviewGates = [{ id: "review-answer", targetNodeId: "answer", configuredAgentId: "missing-reviewer", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Check quality." }], maxQualityRetries: 2 }];
    const result = inspectWorkflowReadiness({ workflow: draft, configuredAgents: [agent], channels: [channel], mcpServers: [server] });
    expect(result.issues).toEqual([expect.objectContaining({ code: "AGENT_MISSING", scope: "reviewer", nodeId: "answer", configuredAgentId: "missing-reviewer" })]);
  });

  test("reports missing dependencies without guessing by display name", () => {
    const draft = workflow();
    draft.reviewerConfiguredAgentId = "Agent A";
    draft.reviewerModelId = "model-missing";
    const node = draft.definition.nodes[0];
    if (node?.execModel !== "llm") throw new Error("expected llm fixture");
    node.configuredAgentId = "agent-a";
    node.modelId = "model-missing";
    node.requiredTools = ["publish"];
    const result = inspectWorkflowReadiness({ workflow: draft, configuredAgents: [agent], channels: [channel], mcpServers: [server] });

    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["AGENT_MISSING", "MODEL_UNAVAILABLE", "REQUIRED_TOOL_MISSING"]));
  });

  test("requires only literal Secret values before confirmation", () => {
    const draft = workflow();
    draft.definition.nodes = [{
      id: "script", kind: "script", title: "Script", execModel: "script", executionMode: "script", outputFields: [{ key: "result" }],
      script: {
        executable: { kind: "inline", language: "typescript", code: "return inputs;" }, capabilities: [], managerRisk: { level: "safe", rationale: "Pure" },
        parameters: [
          { key: "literal", label: "Literal", location: "environment", valueType: "secret", source: "literal", required: true },
          { key: "user", label: "User", location: "stdin", valueType: "secret", source: "user", required: true },
        ],
      },
    }];
    const result = inspectWorkflowReadiness({ workflow: draft, configuredAgents: [agent], channels: [channel], mcpServers: [server] });

    expect(result.issues).toEqual([expect.objectContaining({ code: "SECRET_VALUE_REQUIRED", field: "script.parameters.literal" })]);
  });
});
