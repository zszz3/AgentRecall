import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition } from "../../../shared/workflow-v2/definition";
import { buildWorkflowV2GraphRevision, buildWorkflowV2Plan, WorkflowV2PlanBuildError } from "./workflow-v2-planner";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-plan",
    graphVersion: 7,
    objective: "Promote workflow v2 planning into main-process contracts",
    nodes: [
      {
        id: "orchestrate",
        kind: "planner",
        title: "Orchestrate",
        execModel: "llm",
        executionMode: "one-shot",
        role: "orchestrator",
        prompt: "Build the frozen graph",
        outputFields: [{ key: "planDoc", required: true }],
      },
      {
        id: "implement",
        kind: "implementation",
        title: "Implement",
        execModel: "llm",
        executionMode: "one-shot",
        configuredAgentId: "implementation-agent",
        modelId: "implementation-model",
        prompt: "Implement the approved plan",
        outputFields: [{ key: "diff", required: true }],
        constraints: [{ key: "follow_spec_order", description: "Do not skip unfinished earlier phases." }],
      },
      {
        id: "review",
        kind: "review",
        title: "Review",
        execModel: "llm",
        executionMode: "one-shot",
        role: "reviewer",
        prompt: "Review the diff",
        outputFields: [{ key: "reviewVerdict", required: true }],
      },
    ],
    edges: [
      { fromNodeId: "orchestrate", toNodeId: "implement" },
      { fromNodeId: "implement", toNodeId: "review" },
    ],
  };
}

describe("workflow-v2 planner", () => {
  test("builds an execution-ready frozen plan with visible routing defaults", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "planner-agent",
      contextBudget: { maxContextTokens: 3000, maxEvidenceItems: 8, maxUpstreamNodes: 3 },
      costBudget: { maxModelCalls: 9, maxPromptTokens: 12000 },
      now: 1720000000000,
    });

    expect(plan.workflowId).toBe("workflow-v2-plan");
    expect(plan.graphVersion).toBe(7);
    expect(plan.approvedBy).toBe("planner-agent");
    expect(plan.frozenAt).toBe(1720000000000);
    expect(plan.roleDefaults.executor).toEqual({ role: "executor", modelProfile: "fast" });
    expect(plan.budget).toEqual({
      context: { maxContextTokens: 3000, maxEvidenceItems: 8, maxUpstreamNodes: 3 },
      cost: { maxModelCalls: 9, maxPromptTokens: 12000 },
    });
    expect(plan.nodes.map((node) => ({ nodeId: node.nodeId, role: node.role, modelProfile: node.modelProfile }))).toEqual([
      { nodeId: "orchestrate", role: "orchestrator", modelProfile: "expert" },
      { nodeId: "implement", role: "executor", modelProfile: "fast" },
      { nodeId: "review", role: "reviewer", modelProfile: "expert" },
    ]);
    expect(plan.nodes[1]?.taskPacket.acceptanceCriteria).toEqual([
      {
        key: "implement.diff",
        description: "Node Implement must produce output field diff.",
        required: true,
      },
      {
        key: "implement.constraint.follow_spec_order",
        description: "Do not skip unfinished earlier phases.",
        required: true,
      },
    ]);
    expect(plan.nodes[1]).toMatchObject({ configuredAgentId: "implementation-agent", modelId: "implementation-model", taskPacket: { configuredAgentId: "implementation-agent", modelId: "implementation-model" } });
  });

  test("normalizes parallel terminal branches into one final summary node", async () => {
    const source = definition();
    source.edges = [{ fromNodeId: "orchestrate", toNodeId: "implement" }];

    const plan = await buildWorkflowV2Plan({
      definition: source,
      approvedBy: "planner-agent",
      now: 1,
    });

    expect(plan.nodes.at(-1)?.nodeId).toBe("workflow-summary");
    expect(plan.nodes.slice(0, -1).map((node) => node.nodeId)).toEqual(expect.arrayContaining([
      "orchestrate",
      "implement",
      "review",
    ]));
    expect(plan.definition.edges).toEqual([
      { fromNodeId: "orchestrate", toNodeId: "implement" },
      { fromNodeId: "implement", toNodeId: "workflow-summary" },
      { fromNodeId: "review", toNodeId: "workflow-summary" },
    ]);
    expect(plan.definition.nodes.at(-1)).toMatchObject({
      id: "workflow-summary",
      outputFields: [{ key: "answer_markdown", required: true }],
    });
  });

  test("freezes explicit and compatibility execution modes with rationale", async () => {
    const source = definition();
    const implement = source.nodes.find((node) => node.id === "implement");
    if (!implement || implement.execModel !== "llm") throw new Error("expected implement llm node");
    implement.executionMode = "interactive";
    implement.executionModeRationale = "Collect multiple implementation constraints from the user.";
    implement.executionModeConfidence = 0.9;
    source.nodes.push({
      id: "format",
      kind: "format",
      title: "Format",
      execModel: "script",
        executionMode: "script",
      script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return input", timeoutMs: 1_000 }),
      outputFields: [{ key: "formatted", required: true }],
    });
    source.edges.push({ fromNodeId: "review", toNodeId: "format" });

    const plan = await buildWorkflowV2Plan({ definition: source, approvedBy: "planner-agent", now: 2 });

    expect(plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      executionMode: node.executionMode,
      rationale: node.executionModeRationale,
      confidence: node.executionModeConfidence,
    }))).toEqual([
      expect.objectContaining({ nodeId: "orchestrate", executionMode: "one-shot" }),
      {
        nodeId: "implement",
        executionMode: "interactive",
        rationale: "Collect multiple implementation constraints from the user.",
        confidence: 0.9,
      },
      expect.objectContaining({ nodeId: "review", executionMode: "one-shot" }),
      expect.objectContaining({ nodeId: "format", executionMode: "script" }),
    ]);
  });
  test("normalizes plan identity and custom criteria at the planner boundary", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      objective: "   ",
      approvedBy: "  planner-agent  ",
      acceptanceCriteria: [{ key: "  release.ready  ", description: "  Release is ready.  ", required: false }],
      now: 0,
    });

    expect(plan.objective).toBe(definition().objective);
    expect(plan.approvedBy).toBe("planner-agent");
    expect(plan.frozenAt).toBe(0);
    expect(plan.acceptanceCriteria).toEqual([
      { key: "release.ready", description: "Release is ready.", required: false },
    ]);
  });

  test("deep-freezes the planned definition from later caller mutations", async () => {
    const sourceDefinition = definition();
    const plan = await buildWorkflowV2Plan({
      definition: sourceDefinition,
      approvedBy: "planner-agent",
      now: 1,
    });

    sourceDefinition.nodes[0]!.outputFields[0]!.key = "mutated-after-approval";
    const implementNode = sourceDefinition.nodes[1]!;
    if (implementNode.execModel !== "llm") throw new Error("expected llm node");
    implementNode.constraints![0]!.description = "Mutated after approval.";

    expect(plan.definition.nodes[0]!.outputFields[0]!.key).toBe("planDoc");
    const frozenImplementNode = plan.definition.nodes[1]!;
    if (frozenImplementNode.execModel !== "llm") throw new Error("expected llm node");
    expect(frozenImplementNode.constraints![0]!.description).toBe("Do not skip unfinished earlier phases.");
  });

  test("rejects structurally invalid definitions instead of planning ad hoc", async () => {
    await expect(
      buildWorkflowV2Plan({
        definition: {
          ...definition(),
          edges: [{ fromNodeId: "missing", toNodeId: "implement" }],
        },
        approvedBy: "planner-agent",
      }),
    ).rejects.toBeInstanceOf(WorkflowV2PlanBuildError);
  });

  test.each([
    ["zero context tokens", { contextBudget: { maxContextTokens: 0 } }],
    ["fractional evidence items", { contextBudget: { maxContextTokens: 1_000, maxEvidenceItems: 1.5 } }],
    ["non-finite model calls", { costBudget: { maxModelCalls: Number.NaN } }],
    ["negative prompt tokens", { costBudget: { maxPromptTokens: -1 } }],
    ["unsafe wall-clock milliseconds", { costBudget: { maxWallClockMs: Number.MAX_SAFE_INTEGER + 1 } }],
  ])("rejects invalid top-level budget input: %s", async (_name, budgetInput) => {
    await expect(buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "planner-agent",
      ...budgetInput,
    })).rejects.toBeInstanceOf(WorkflowV2PlanBuildError);
  });

  test("rejects a blank approver with a structured build error", async () => {
    await expect(buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "   ",
    })).rejects.toMatchObject({
      name: "WorkflowV2PlanBuildError",
      details: {
        errors: expect.arrayContaining(["Workflow V2 planner requires a non-empty approvedBy."]),
      },
    });
  });

  test.each([
    ["negative", -1],
    ["non-finite", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s frozen timestamp before planning", async (_name, now) => {
    await expect(buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "planner-agent",
      now,
    })).rejects.toMatchObject({
      name: "WorkflowV2PlanBuildError",
      details: {
        errors: expect.arrayContaining(["Workflow V2 planner requires now to be a non-negative safe integer."]),
      },
    });
  });

  test.each([
    ["empty list", []],
    ["blank key", [{ key: "   ", description: "Ready" }]],
    ["blank description", [{ key: "ready", description: "   " }]],
    ["duplicate trimmed key", [
      { key: "release.ready", description: "Ready" },
      { key: " release.ready ", description: "Still ready" },
    ]],
    ["non-boolean required", [{ key: "ready", description: "Ready", required: "yes" }]],
  ])("rejects custom acceptance criteria with a %s", async (_name, acceptanceCriteria) => {
    await expect(buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "planner-agent",
      acceptanceCriteria: acceptanceCriteria as unknown as NonNullable<Parameters<typeof buildWorkflowV2Plan>[0]["acceptanceCriteria"]>,
    })).rejects.toMatchObject({
      name: "WorkflowV2PlanBuildError",
      details: {
        errors: expect.arrayContaining([expect.stringContaining("acceptance criteria")]),
      },
    });
  });

  test("rejects an invalid role model profile supplied through an untrusted caller", async () => {
    await expect(buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "planner-agent",
      roleModelProfiles: { executor: "turbo" } as unknown as NonNullable<Parameters<typeof buildWorkflowV2Plan>[0]["roleModelProfiles"]>,
    })).rejects.toMatchObject({
      name: "WorkflowV2PlanBuildError",
      details: {
        errors: expect.arrayContaining(["Workflow V2 planner role executor requires a valid model profile."]),
      },
    });
  });

  test("builds explicit graph revisions instead of overloading retries", () => {
    expect(
      buildWorkflowV2GraphRevision({
        basedOnGraphVersion: 7,
        nextGraphVersion: 8,
        reason: "Objective widened after review feedback.",
        changesSummary: "Add a reviewer branch for release-readiness checks.",
        approvedBy: "human-reviewer",
        now: 1720000000100,
      }),
    ).toEqual({
      revisionId: "graph-revision-1720000000100",
      basedOnGraphVersion: 7,
      nextGraphVersion: 8,
      reason: "Objective widened after review feedback.",
      changesSummary: "Add a reviewer branch for release-readiness checks.",
      approvedBy: "human-reviewer",
      createdAt: 1720000000100,
    });
  });

  test.each([
    ["unsafe basedOnGraphVersion", { basedOnGraphVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ["non-increasing nextGraphVersion", { nextGraphVersion: 7 }],
    ["non-string reason", { reason: 42 }],
    ["blank changesSummary", { changesSummary: "   " }],
    ["non-string approvedBy", { approvedBy: null }],
    ["negative now", { now: -1 }],
  ])("rejects graph revision input with %s", (_name, override) => {
    expect(() => buildWorkflowV2GraphRevision({
      basedOnGraphVersion: 7,
      nextGraphVersion: 8,
      reason: "Revise the graph.",
      changesSummary: "Add an execution node.",
      approvedBy: "human-reviewer",
      now: 1720000000100,
      ...override,
    } as Parameters<typeof buildWorkflowV2GraphRevision>[0])).toThrow(WorkflowV2PlanBuildError);
  });
});
