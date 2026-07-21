import { describe, expect, test } from "vitest";
import type { WorkflowV2Definition } from "./definition";
import {
  createWorkflowV2TaskPacket,
  deriveWorkflowV2AcceptanceCriteria,
  deriveWorkflowV2DownstreamRequirements,
  resolveWorkflowV2NodeModelProfile,
  resolveWorkflowV2NodeRole,
  workflowV2DefaultRoleRoutes,
} from "./planning";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-plan",
    graphVersion: 3,
    objective: "Ship workflow v2 planning contracts",
    nodes: [
      {
        id: "plan",
        kind: "planner",
        title: "Plan",
        execModel: "llm",
        executionMode: "one-shot",
        role: "orchestrator",
        modelProfile: "expert",
        prompt: "Plan the rollout",
        outputFields: [{ key: "planDoc", required: true }],
        constraints: [{ key: "stay_narrow", description: "Do not absorb execution scheduling." }],
      },
      {
        id: "execute",
        kind: "implementation",
        title: "Execute",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Implement the approved plan",
        outputFields: [{ key: "diff", required: true }],
        contextBudget: { maxContextTokens: 2000, maxEvidenceItems: 6 },
      },
    ],
    edges: [{ fromNodeId: "plan", toNodeId: "execute" }],
  };
}

describe("workflow-v2 planning contracts", () => {
  test("exposes visible default role routing", () => {
    expect(workflowV2DefaultRoleRoutes()).toEqual({
      orchestrator: { role: "orchestrator", modelProfile: "expert" },
      executor: { role: "executor", modelProfile: "fast" },
      reviewer: { role: "reviewer", modelProfile: "expert" },
    });
  });

  test("throws a clear error when a direct resolver receives an unsupported role", () => {
    const node = definition().nodes[0]!;
    node.role = "admin" as unknown as NonNullable<typeof node.role>;

    expect(() => resolveWorkflowV2NodeRole(node)).toThrow(
      "Workflow V2 node plan has unsupported role admin.",
    );
    expect(() => resolveWorkflowV2NodeModelProfile(node, workflowV2DefaultRoleRoutes())).toThrow(
      "Workflow V2 node plan has unsupported role admin.",
    );
  });

  test("throws a clear error when a direct resolver receives an unsupported model profile", () => {
    const node = definition().nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.modelProfile = "turbo" as unknown as NonNullable<typeof node.modelProfile>;

    expect(() => resolveWorkflowV2NodeModelProfile(node, workflowV2DefaultRoleRoutes())).toThrow(
      "Workflow V2 llm node plan has unsupported model profile turbo.",
    );
  });

  test("derives acceptance criteria from output fields and constraints", () => {
    expect(deriveWorkflowV2AcceptanceCriteria(definition())).toEqual([
      {
        key: "plan.planDoc",
        description: "Node Plan must produce output field planDoc.",
        required: true,
      },
      {
        key: "plan.constraint.stay_narrow",
        description: "Do not absorb execution scheduling.",
        required: true,
      },
      {
        key: "execute.diff",
        description: "Node Execute must produce output field diff.",
        required: true,
      },
    ]);
  });

  test("creates packetized context with explicit role, budget, and upstream digest", () => {
    const graph = definition();
    const packet = createWorkflowV2TaskPacket({
      node: graph.nodes[1]!,
      workflowObjective: graph.objective,
      acceptanceCriteria: deriveWorkflowV2AcceptanceCriteria(graph),
      roleRoutes: workflowV2DefaultRoleRoutes(),
      defaultContextBudget: { maxContextTokens: 1200, maxEvidenceItems: 4, maxUpstreamNodes: 2 },
      upstreamDigest: [{ nodeId: "plan", title: "Plan", summary: "Approved execution outline.", outputKeys: ["planDoc"] }],
    });

    expect(packet).toEqual({
      nodeId: "execute",
      title: "Execute",
      role: "executor",
      execModel: "llm",
      executionMode: "one-shot",
      executionModeRationale: "The node has bounded inputs and can complete in one agent turn.",
      executionModeConfidence: 1,
      modelProfile: "fast",
      objective: "Ship workflow v2 planning contracts",
      acceptanceCriteria: [
        {
          key: "execute.diff",
          description: "Node Execute must produce output field diff.",
          required: true,
        },
      ],
      constraints: [],
      upstreamDigest: [{ nodeId: "plan", title: "Plan", summary: "Approved execution outline.", outputKeys: ["planDoc"] }],
      outputFields: [{ key: "diff", required: true }],
      budget: {
        context: { maxContextTokens: 2000, maxEvidenceItems: 6 },
      },
    });
  });

  test("adds direct downstream script requirements to an agent task packet", () => {
    const graph = definition();
    graph.nodes.push({
      id: "publish",
      kind: "publish",
      title: "Publish",
      execModel: "script",
      executionMode: "script",
      outputFields: [{ key: "published", required: true, valueType: "boolean" }],
      script: {
        executable: { kind: "inline", language: "typescript", code: "return { published: Boolean(inputs.content) };" },
        parameters: [{ key: "content", label: "Content", location: "body", valueType: "string", source: "upstream", required: true, upstreamNodeId: "execute", upstreamOutputKey: "diff", description: "Content to publish." }],
        capabilities: [],
        managerRisk: { level: "safe", rationale: "Pure in-memory test transform." },
      },
    });
    graph.edges.push({ fromNodeId: "execute", toNodeId: "publish" });
    const downstreamRequirements = deriveWorkflowV2DownstreamRequirements(graph, "execute");

    const packet = createWorkflowV2TaskPacket({
      node: graph.nodes[1]!,
      workflowObjective: graph.objective,
      acceptanceCriteria: deriveWorkflowV2AcceptanceCriteria(graph),
      roleRoutes: workflowV2DefaultRoleRoutes(),
      defaultContextBudget: { maxContextTokens: 1200 },
      downstreamRequirements,
    });

    expect(packet.downstreamRequirements).toEqual([{
      downstreamNodeId: "publish",
      downstreamNodeTitle: "Publish",
      parameterKey: "content",
      parameterLabel: "Content",
      upstreamOutputKey: "diff",
      location: "body",
      valueType: "string",
      required: true,
      description: "Content to publish.",
    }]);
  });
});
