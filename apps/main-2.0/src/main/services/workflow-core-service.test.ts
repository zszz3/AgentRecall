import { describe, expect, test } from "vitest";
import type { WorkflowDefinition, WorkflowRun } from "../../automation/engine/shared/workflow/model";
import type { WorkflowEngine } from "../../automation/engine/main/workflows/workflow-engine";
import { parseWorkflowAgentOutputs, WorkflowCoreService } from "./workflow-core-service";

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
