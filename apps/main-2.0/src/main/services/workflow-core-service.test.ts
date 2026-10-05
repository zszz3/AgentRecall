import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowReviewNode, WorkflowRun } from "../../automation/engine/shared/workflow/model";
import type { WorkflowEngine } from "../../automation/engine/main/workflows/workflow-engine";
import { parseWorkflowAgentOutputs, WorkflowCoreService } from "./workflow-core-service";
import { validateWorkflowNodeOutputs } from "../../automation/engine/shared/workflow/output";

function definition(agentId = "agent"): WorkflowDefinition {
  return {
    id: "workflow",
    name: "Workflow",
    description: "Workflow description",
    inputs: [],
    nodes: [{
      id: "answer",
      kind: "agent",
      title: "Answer",
      goal: "Answer.",
      agentId,
      instructions: [],
      constraints: [],
      inputs: [],
      outputs: [{ key: "answer", name: "Answer", description: "Answer", type: "text", required: true }],
      acceptanceCriteria: [],
    }],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("WorkflowCoreService", () => {
  test.each([["通过", "pass"], ["驳回", "revise"]])("normalizes the localized Review verdict %s", (verdict, expected) => {
    const node: WorkflowReviewNode = {
      ...definition().nodes[0]!, kind: "review", agentId: "agent", instructions: [], constraints: [],
      targetNodeIds: [], criteria: [], maxRevisions: 1, onReject: "revise",
      outputs: [
        { key: "verdict", name: "结论", description: "通过或驳回。", type: "text", required: true },
        { key: "feedback", name: "反馈", description: "反馈", type: "text", required: true },
      ],
    };
    const businessOutputs = { verdict, feedback: "检查依据保持不变。" };
    for (const value of [businessOutputs, { nodeId: node.id, summary: "已审查", outputs: businessOutputs, proposals: [] }]) {
      const parsed = parseWorkflowAgentOutputs(JSON.stringify(value), node);
      expect(parsed).toEqual({ ...businessOutputs, verdict: expected });
      expect(validateWorkflowNodeOutputs(node, parsed)).toEqual([]);
    }
    const unknown = parseWorkflowAgentOutputs('{"verdict":"approved","feedback":"检查"}', node);
    expect(validateWorkflowNodeOutputs(node, unknown)).toContainEqual({ path: "outputs.verdict", message: "Review verdict must be pass or revise." });
    expect(parseWorkflowAgentOutputs(JSON.stringify(businessOutputs))).toEqual(businessOutputs);
    expect(parseWorkflowAgentOutputs(JSON.stringify(businessOutputs), definition().nodes[0]!)).toEqual(businessOutputs);
  });

  test("validates business outputs from a matching completion packet", () => {
    const node = definition().nodes[0]!;
    const packet = { nodeId: node.id, summary: "Done", outputs: { answer: "Because." }, proposals: [] };
    const outputs = parseWorkflowAgentOutputs(JSON.stringify(packet), node);
    expect(outputs).toEqual(packet.outputs);
    expect(validateWorkflowNodeOutputs(node, outputs)).toEqual([]);
    expect(parseWorkflowAgentOutputs(JSON.stringify(packet))).toEqual(packet);
  });

  test("keeps declared business fields even when they resemble a completion packet", () => {
    const node = definition().nodes[0]!;
    node.outputs = [
      { key: "nodeId", name: "ID", description: "ID", type: "text", required: true },
      { key: "summary", name: "Summary", description: "Summary", type: "text", required: true },
      { key: "outputs", name: "Outputs", description: "Outputs", type: "object", required: true },
      { key: "proposals", name: "Proposals", description: "Proposals", type: "list", required: true },
    ];
    const outputs = { nodeId: "business-id", summary: "Business data", outputs: {}, proposals: [] };
    expect(parseWorkflowAgentOutputs(JSON.stringify(outputs), node)).toEqual(outputs);
  });

  test.each([
    { nodeId: "other", summary: "Done", outputs: { answer: "Because." }, proposals: [] },
    { nodeId: "answer", summary: "", outputs: { answer: "Because." }, proposals: [] },
    { nodeId: "answer", summary: "Done", outputs: [], proposals: [] },
    { nodeId: "answer", summary: "Done", outputs: { answer: "Because." }, proposals: [{ kind: "retry" }] },
    { nodeId: "answer", summary: "Done", outputs: { answer: "Because." }, proposals: [], unexpected: true },
  ])("rejects invalid completion packets: %j", (packet) => {
    expect(() => parseWorkflowAgentOutputs(JSON.stringify(packet), definition().nodes[0]!))
      .toThrow("Workflow completion packet");
  });

  test("keeps inner output validation after unwrapping a completion packet", () => {
    const node = definition().nodes[0]!;
    const packet = { nodeId: node.id, summary: "Done", outputs: { extra: true }, proposals: [] };
    expect(validateWorkflowNodeOutputs(node, parseWorkflowAgentOutputs(JSON.stringify(packet), node)))
      .toEqual([
        { path: "outputs.extra", message: "Output field is not declared by the node." },
        { path: "outputs.answer", message: "Required output is missing." },
      ]);
  });

  test("parses fenced structured Agent outputs", () => {
    expect(parseWorkflowAgentOutputs("```json\n{\"answer\":\"Because.\"}\n```"))
      .toEqual({ answer: "Because." });
    expect(() => parseWorkflowAgentOutputs("[]")).toThrow("one JSON object");
  });

  test("parses one fenced JSON object surrounded by Agent commentary", () => {
    const content = [
      "I inspected the repository and compiled the result.",
      "",
      "```json",
      '{"architecture":"Electron app","constraints":["Node 22"]}',
      "```",
      "",
      "Provide a requirement for a more targeted analysis.",
    ].join("\n");

    expect(parseWorkflowAgentOutputs(content)).toEqual({
      architecture: "Electron app",
      constraints: ["Node 22"],
    });
  });

  test("preserves long workflow output containing unescaped quotation marks", () => {
    const analysis = `${"需求分析。".repeat(450)}校验中文不乱码（"网页标题"可作断言）。`;
    const content = [
      "```json",
      "{",
      `  "analysis": "${analysis}",`,
      '  "implementationPlan": "运行检查，再交付实现。",',
      '  "acceptanceCriteria": ["标题正确", "输出可读取"]',
      "}",
      "```",
    ].join("\n");

    expect(parseWorkflowAgentOutputs(content)).toEqual({
      analysis,
      implementationPlan: "运行检查，再交付实现。",
      acceptanceCriteria: ["标题正确", "输出可读取"],
    });
  });

  test.each([
    '{"answer":"incomplete',
    '{"answer":"incomplete}',
    '{"answer":"done", "checks":["passed"]',
    '{"answer":"done" "checks":[]}',
    '{"answer":"done",}',
    '{"answer":"done"}\n{"answer":"other"}',
    '[{"answer":"done"}]',
  ])("rejects outputs that require changes beyond quote escaping: %s", (content) => {
    expect(() => parseWorkflowAgentOutputs(content)).toThrow("one JSON object");
  });

  test("saves valid definitions and exposes a fresh snapshot", async () => {
    const definitions: WorkflowDefinition[] = [];
    const repository = {
      listDefinitions: async () => structuredClone(definitions),
      listRuns: async () => [],
      getDefinition: async (id: string) => definitions.find((item) => item.id === id),
      saveDefinition: async (value: WorkflowDefinition) => { definitions.splice(0, definitions.length, structuredClone(value)); },
      deleteDefinition: async () => undefined,
      markInterruptedRunsFailed: async () => undefined,
    };
    const service = new WorkflowCoreService({
      repository,
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await service.saveDefinition(definition());
    await expect(service.snapshot()).resolves.toEqual({ definitions: [definition()], runs: [] });
  });

  test("rejects definitions that reference an unknown Agent", async () => {
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [],
        listRuns: async () => [],
        getDefinition: async () => undefined,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.saveDefinition(definition("missing"))).rejects.toThrow("nodes.answer.agentId: Configured agent does not exist");
  });

  test("starts the saved frozen definition through the engine", async () => {
    const saved = definition();
    const completed = { id: "run", workflowId: saved.id, definition: saved, inputs: {}, status: "completed", nodeRuns: {}, events: [], startedAt: 1, finishedAt: 2 } satisfies WorkflowRun;
    const start = async (value: WorkflowDefinition, inputs: Record<string, unknown>) => {
      expect(value).toEqual(saved);
      expect(inputs).toEqual({});
      return completed;
    };
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [saved],
        listRuns: async () => [],
        getDefinition: async () => saved,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: { start } as unknown as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.startRun(saved.id, {})).resolves.toEqual(completed);
  });

  test("adds missing bundled definitions without overwriting user edits", async () => {
    const existing = { ...definition(), name: "My edited Workflow" };
    const saved: WorkflowDefinition[] = [];
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [existing],
        listRuns: async () => [],
        getDefinition: async () => existing,
        saveDefinition: async (value) => { saved.push(value); },
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await service.ensureDefinitions([definition(), { ...definition(), id: "new-workflow" }]);

    expect(saved.map((item) => item.id)).toEqual(["new-workflow"]);
  });

  test("upgrades bundled definitions to read-only templates and preserves their original creation time", async () => {
    const existing = { ...definition(), name: "Previously seeded", createdAt: 9 };
    const saved: WorkflowDefinition[] = [];
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [existing],
        listRuns: async () => [],
        getDefinition: async () => existing,
        saveDefinition: async (value) => { saved.push(value); },
        deleteDefinition: async () => undefined,
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await service.ensureDefinitions([{ ...definition(), isTemplate: true }]);

    expect(saved).toEqual([{ ...definition(), isTemplate: true, createdAt: 9 }]);
  });

  test("does not delete read-only templates", async () => {
    let deleted = false;
    const template = { ...definition(), isTemplate: true };
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [template],
        listRuns: async () => [],
        getDefinition: async () => template,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => { deleted = true; },
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.deleteDefinition(template.id)).rejects.toThrow("read-only");
    expect(deleted).toBe(false);
  });

  test("does not delete a definition with an active run", async () => {
    let deleted = false;
    const saved = definition();
    const activeRun = {
      id: "run",
      workflowId: saved.id,
      definition: saved,
      inputs: {},
      status: "running",
      nodeRuns: {},
      events: [],
      startedAt: 1,
    } satisfies WorkflowRun;
    const service = new WorkflowCoreService({
      repository: {
        listDefinitions: async () => [saved],
        listRuns: async (workflowId) => workflowId === saved.id ? [activeRun] : [],
        getDefinition: async () => saved,
        saveDefinition: async () => undefined,
        deleteDefinition: async () => { deleted = true; },
        markInterruptedRunsFailed: async () => undefined,
      },
      engine: {} as WorkflowEngine,
      configuredAgentIds: () => new Set(["agent"]),
    });

    await expect(service.deleteDefinition(saved.id)).rejects.toThrow("Stop the active Workflow run");
    expect(deleted).toBe(false);
  });
});
