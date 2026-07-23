import { describe, expect, test } from "vitest";
import type {
  AppSnapshot,
  FinishWorkflowRunRequest,
  RunTaskRequest,
  TaskRun,
  WorkflowDraftState,
  WorkflowEvent,
  WorkflowRunState,
  WorkflowRunProgressItem,
} from "../../shared/types";
import {
  createWorkflowV2InlineScriptSpec,
  type WorkflowV2ContextBudget,
  type WorkflowV2Definition,
  type WorkflowV2ScriptNode,
} from "../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../shared/workflow-v2/packets";
import type { WorkflowNodeConversation } from "../../shared/workflow-v2/conversation";
import { createWorkflowV2RunState } from "../../shared/workflow-v2/state";
import { WORKFLOW_V2_STORAGE_SCHEMA_VERSION, type WorkflowV2PersistedRunState } from "../../shared/workflow-v2/storage";
import type { WorkflowV2CostBudget, WorkflowV2Plan, WorkflowV2ResultPacket } from "../../shared/workflow-v2/planning";
import { buildWorkflowV2Plan } from "./v2/workflow-v2-planner";
import { freezeWorkflowV2ScriptGovernance } from "./v2/workflow-v2-script-governance";
import { transitionWorkflowV2NodeState } from "./v2/workflow-v2-scheduler";
import {
  type ExecuteWorkflowV2ScriptRequest,
  type WorkflowV2StorePort,
  parseWorkflowV2WorkerArtifact,
  resolveWorkflowNodeAgent,
  WorkflowRuntime,
  workflowV2LlmNodePrompt,
} from "./workflow-runtime";

const AGENTS = [
  { id: "agent-a", modelId: "model-a" },
  { id: "agent-b", modelId: "model-b" },
];
const WORKFLOW_DEFAULTS = { configuredAgentId: "agent-a", modelId: "model-a" };

describe("resolveWorkflowNodeAgent", () => {
  test("uses the workflow default when the node has no override", () => {
    expect(resolveWorkflowNodeAgent({}, WORKFLOW_DEFAULTS, AGENTS)).toEqual({ configuredAgentId: "agent-a", modelId: "model-a" });
  });

  test("uses the node's agent and that agent's default model when only the agent is overridden", () => {
    expect(resolveWorkflowNodeAgent({ configuredAgentId: "agent-b" }, WORKFLOW_DEFAULTS, AGENTS)).toEqual({
      configuredAgentId: "agent-b",
      modelId: "model-b",
    });
  });

  test("honours an explicit per-node model override", () => {
    expect(resolveWorkflowNodeAgent({ configuredAgentId: "agent-b", modelId: "model-x" }, WORKFLOW_DEFAULTS, AGENTS)).toEqual({
      configuredAgentId: "agent-b",
      modelId: "model-x",
    });
  });

  test("falls back to the workflow default model when the node overrides only the model", () => {
    expect(resolveWorkflowNodeAgent({ modelId: "model-x" }, WORKFLOW_DEFAULTS, AGENTS)).toEqual({
      configuredAgentId: "agent-a",
      modelId: "model-x",
    });
  });
});

describe("parseWorkflowV2WorkerArtifact", () => {
  test("uses plain text only as the single declared output field", () => {
    const node = workflowV2Definition().nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");

    expect(parseWorkflowV2WorkerArtifact(node, "A narrow plain-text result.")).toEqual({
      nodeId: "draft",
      summary: "A narrow plain-text result.",
      outputs: { draft: "A narrow plain-text result." },
      proposals: [],
    });
  });

  test("rejects plain text when the node declares multiple output fields", () => {
    const baseNode = workflowV2Definition().nodes[0]!;
    if (baseNode.execModel !== "llm") throw new Error("expected llm node");
    const node = {
      ...baseNode,
      outputFields: [{ key: "draft", required: true }, { key: "notes", required: true }],
    };

    expect(() => parseWorkflowV2WorkerArtifact(node, "Ambiguous plain text.")).toThrow(
      "must return structured JSON for multiple output fields",
    );
  });

  test("rejects malformed content that presents itself as a structured packet", () => {
    const node = workflowV2Definition().nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");

    expect(() => parseWorkflowV2WorkerArtifact(node, '{"nodeId":"draft","summary":')).toThrow(
      "invalid structured worker-output packet",
    );
  });
});

describe("workflowV2LlmNodePrompt", () => {
  async function promptInput(input: {
    summaryFallbackPolicy?: WorkflowV2ContextBudget["summaryFallbackPolicy"];
    baseWorkflowContextDocument: string;
    maxContextTokens?: number;
    maxPromptTokens?: number;
  }): Promise<Parameters<typeof workflowV2LlmNodePrompt>[0]> {
    const definition = workflowV2Definition();
    const plan = await buildWorkflowV2Plan({
      definition,
      approvedBy: "prompt-budget-test",
      now: 10,
    });
    const node = definition.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    const taskPacket = structuredClone(plan.nodes[0]!.taskPacket);
    taskPacket.budget.context.maxContextTokens = input.maxContextTokens ?? 1_000;
    if (input.summaryFallbackPolicy === undefined) {
      delete taskPacket.budget.context.summaryFallbackPolicy;
    } else {
      taskPacket.budget.context.summaryFallbackPolicy = input.summaryFallbackPolicy;
    }
    taskPacket.budget.cost = { maxPromptTokens: input.maxPromptTokens ?? 4_000 };

    return {
      node,
      taskPacket,
      upstreamOutputs: [],
      baseWorkflowContextDocument: input.baseWorkflowContextDocument,
      storagePlanDocument: "FIXED_STORAGE_PLAN_MUST_REMAIN",
    };
  }

  test.each([
    ["undefined", undefined],
    ["truncate", "truncate"],
  ] as const)("clips oversized dynamic context when fallback policy is %s", async (_name, summaryFallbackPolicy) => {
    const contextPrefix = "DYNAMIC_CONTEXT_PREFIX_MUST_REMAIN";
    const contextSentinel = "OVERSIZED_DYNAMIC_CONTEXT_SENTINEL_MUST_NOT_LEAK";

    const prompt = workflowV2LlmNodePrompt(await promptInput({
      summaryFallbackPolicy,
      baseWorkflowContextDocument: `${contextPrefix}${"x".repeat(10_000)}${contextSentinel}`,
    }));

    expect(prompt.prompt).toBe("Produce the implementation draft from the approved packet.");
    expect(prompt.developerInstructions).toContain("FIXED_STORAGE_PLAN_MUST_REMAIN");
    expect(prompt.developerInstructions).not.toContain(contextPrefix);
    expect(prompt.contextDocument).toContain("Workflow V2 task packet");
    expect(prompt.contextDocument).toContain("approximate character budget");
    expect(prompt.contextDocument).toContain(contextPrefix);
    expect(prompt.contextDocument).not.toContain(contextSentinel);
  });

  test("fails closed when summarize fallback is required for oversized dynamic context", async () => {
    const contextSentinel = "SUMMARIZE_SENTINEL_MUST_NOT_LEAK";
    const input = await promptInput({
      summaryFallbackPolicy: "summarize",
      baseWorkflowContextDocument: `${"x".repeat(10_000)}${contextSentinel}`,
    });

    expect(() => workflowV2LlmNodePrompt(input)).toThrow("summarize fallback is unavailable");
  });

  test("fails closed into the Phase 04 boundary when ask_human fallback is required", async () => {
    const input = await promptInput({
      summaryFallbackPolicy: "ask_human",
      baseWorkflowContextDocument: "x".repeat(10_000),
    });

    expect(() => workflowV2LlmNodePrompt(input)).toThrow("Phase 04 human intervention");
  });

  test.each(["summarize", "ask_human"] as const)(
    "keeps fitting dynamic context unchanged without triggering %s fallback",
    async (summaryFallbackPolicy) => {
      const contextSentinel = `${summaryFallbackPolicy.toUpperCase()}_FITTING_CONTEXT_SENTINEL`;

      const prompt = workflowV2LlmNodePrompt(await promptInput({
        summaryFallbackPolicy,
        baseWorkflowContextDocument: contextSentinel,
      }));

      expect(prompt.contextDocument).toContain(contextSentinel);
    },
  );

  test("keeps fixed task-packet overflow fail-fast ahead of fallback selection", async () => {
    const input = await promptInput({
      summaryFallbackPolicy: "summarize",
      baseWorkflowContextDocument: "x".repeat(10_000),
      maxContextTokens: 1,
    });

    expect(() => workflowV2LlmNodePrompt(input)).toThrow("fixed context exceeds maxContextTokens");
  });

  test("keeps full prompt overflow fail-fast ahead of unavailable fallback selection", async () => {
    const input = await promptInput({
      summaryFallbackPolicy: "summarize",
      baseWorkflowContextDocument: "x".repeat(10_000),
      maxPromptTokens: 0,
    });

    expect(() => workflowV2LlmNodePrompt(input)).toThrow("prompt budget exceeded maxPromptTokens");
  });
});

function workflowV2Definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-runtime",
    graphVersion: 3,
    objective: "Execute a frozen V2 plan through the actual workflow runtime",
    nodes: [
      {
        id: "draft",
        kind: "implementation",
        title: "Draft",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Produce the implementation draft from the approved packet.",
        outputFields: [{ key: "draft", required: true }],
      },
      {
        id: "verify",
        kind: "verification",
        title: "Verify",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "printf verified", timeoutMs: 5_000 }),
        outputFields: [{ key: "verified", required: true }],
      },
    ],
    edges: [{ fromNodeId: "draft", toNodeId: "verify" }],
  };
}

async function workflowV2RuntimeFixture(input: {
  definition?: WorkflowV2Definition;
  contextBudget?: WorkflowV2ContextBudget;
  costBudget?: WorkflowV2CostBudget;
  llmArtifact?: string;
  taskFactory?: (request: RunTaskRequest, index: number) => TaskRun;
  startWorkflowNodeConversation?: (input: {
    workflowId: string;
    runId: string;
    nodeId: string;
    configuredAgentId: string;
    modelId: string;
    workDir: string;
    initialPrompt: string;
    developerInstructions?: string;
    contextDocument?: string;
  }) => Promise<WorkflowNodeConversation>;
  markWorkflowNodeConversationWaiting?: (conversationId: string, question: string) => WorkflowNodeConversation;
  store?: WorkflowV2StorePort;
  executeScript: (request: ExecuteWorkflowV2ScriptRequest) => Promise<WorkflowV2WorkerOutput>;
}): Promise<{
  runtime: WorkflowRuntime;
  workflow: WorkflowDraftState;
  taskRequests: RunTaskRequest[];
  updates: Array<{ status?: "running" | "waiting_for_user"; progress?: WorkflowRunProgressItem[]; appendEvents?: WorkflowEvent[] }>;
  startRequests: string[];
  stopTaskIds: string[];
  deleteTaskRequests: Array<{ taskId: string; preserveRuntimeConversation: boolean }>;
  setRuns: (runs: WorkflowRunState[]) => void;
  finished: Promise<FinishWorkflowRunRequest>;
}> {
  const definition = input.definition ?? workflowV2Definition();
  const basePlan = await buildWorkflowV2Plan({
    definition,
    approvedBy: "runtime-test",
    now: 1_000,
    ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
    ...(input.costBudget ? { costBudget: input.costBudget } : {}),
  });
  const plan = freezeWorkflowV2ScriptGovernance({
    plan: basePlan,
    reviewedRevision: 1,
    reviewerRisks: Object.fromEntries(definition.nodes.filter((node): node is WorkflowV2ScriptNode => node.execModel === "script").map((node) => [node.id, { level: node.script.managerRisk.level, rationale: "Runtime fixture reviewer assessment." }])),
  });
  const workflow = {
    workflowId: definition.workflowId,
    title: "Workflow V2 runtime",
    status: "draft",
    revision: 1,
    configuredAgentId: "agent-a",
    modelId: "model-a",
    reviewerConfiguredAgentId: "agent-a",
    reviewerModelId: "model-a",
    objective: definition.objective,
    workDir: "/tmp/workflow-v2-runtime",
    definition,
    messages: [],
    reply: "",
    error: undefined,
    runProgress: [],
    runContextDocument: "",
    contextDocument: "",
    workflowV2Plan: plan,
    runIds: [],
    createdAt: 1,
    updatedAt: 1,
  } satisfies WorkflowDraftState;
  const taskRequests: RunTaskRequest[] = [];
  const updates: Array<{ status?: "running" | "waiting_for_user"; progress?: WorkflowRunProgressItem[]; appendEvents?: WorkflowEvent[] }> = [];
  const startRequests: string[] = [];
  const stopTaskIds: string[] = [];
  const deleteTaskRequests: Array<{ taskId: string; preserveRuntimeConversation: boolean }> = [];
  let tasks: TaskRun[] = [];
  let runs: WorkflowRunState[] = [];
  let finishRun!: (request: FinishWorkflowRunRequest) => void;
  const finished = new Promise<FinishWorkflowRunRequest>((resolve) => {
    finishRun = resolve;
  });
  const snapshot = (): AppSnapshot => ({
    workDir: "/tmp/app-workdir",
    configuredAgents: [{ id: "agent-a", modelId: "model-a" }, { id: "agent-b", modelId: "model-b" }],
    tasks,
    workflowStore: { activeWorkflowId: workflow.workflowId, workflows: [workflow], runs },
  }) as unknown as AppSnapshot;

  const runtime = new WorkflowRuntime({
    snapshot,
    startWorkflowRun: ({ workflowId }) => {
      startRequests.push(workflowId);
      return { ok: true, workflowId, runId: "run-v2-runtime" };
    },
    finishWorkflowRun: (request) => {
      finishRun(request);
      return { ok: true, workflowId: request.workflowId, runId: request.runId };
    },
    updateWorkflowRunState: (request) => {
      updates.push({
        ...(request.status ? { status: request.status } : {}),
        ...(request.progress ? { progress: structuredClone(request.progress) } : {}),
        ...(request.appendEvents ? { appendEvents: structuredClone(request.appendEvents) } : {}),
      });
    },
    runTask: async (request) => {
      taskRequests.push(request);
      const task = input.taskFactory?.(request, taskRequests.length) ?? ({
        id: `task-${taskRequests.length}`,
        title: "Workflow V2 LLM node",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{ role: "assistant", content: input.llmArtifact ?? JSON.stringify({
          nodeId: "draft",
          summary: "Draft ready",
          outputs: { draft: "const ready = true;" },
          evidence: ["draft evidence"],
          proposals: [],
        }) }],
        createdAt: taskRequests.length,
        updatedAt: taskRequests.length,
      } as TaskRun);
      tasks = [...tasks, task];
      return snapshot();
    },
    stopTask: async (taskId) => {
      stopTaskIds.push(taskId);
      tasks = tasks.map((task) => task.id === taskId
        ? { ...task, status: "stopped", running: false, lastError: "Stopped", updatedAt: Date.now() }
        : task);
    },
    deleteTask: async (taskId, options) => {
      deleteTaskRequests.push({
        taskId,
        preserveRuntimeConversation: options?.preserveRuntimeConversation === true,
      });
      tasks = tasks.filter((task) => task.id !== taskId);
      return snapshot();
    },
    executeWorkflowV2Script: input.executeScript,
    startWorkflowNodeConversation: input.startWorkflowNodeConversation ?? (async () => { throw new Error("Unexpected interactive workflow node in test."); }),
    markWorkflowNodeConversationWaiting: input.markWorkflowNodeConversationWaiting ?? (() => { throw new Error("Unexpected interactive workflow node wait state in test."); }),
    stopWorkflowNodeConversations: async () => undefined,
    ...(input.store ? { createWorkflowV2Store: () => input.store! } : {}),
  });

  return {
    runtime,
    workflow,
    taskRequests,
    updates,
    startRequests,
    stopTaskIds,
    deleteTaskRequests,
    setRuns: (nextRuns) => {
      runs = nextRuns;
    },
    finished,
  };
}

function workflowV2InterventionRun(
  workflow: WorkflowDraftState,
  status: WorkflowRunState["status"],
  nodeStatus: WorkflowRunProgressItem["status"],
): WorkflowRunState {
  return {
    runId: "run-v2-intervention",
    workflowId: workflow.workflowId,
    status,
    workflowV2Plan: workflow.workflowV2Plan!,
    progress: [{ nodeId: "draft", title: "Draft", status: nodeStatus, taskId: "task-v2-intervention" }],
    events: nodeStatus === "awaiting_input"
      ? [{ type: "gate_opened", nodeId: "draft", at: 1, question: "Continue?" }]
      : [],
    contextDocument: "# V2 context",
    startedAt: 1,
    finishedAt: undefined,
    lastError: undefined,
  };
}

describe("WorkflowRuntime typed script input", () => {
  test("persists a typed input request and pauses before executing the script", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{
      id: "submit",
      kind: "request",
      title: "Submit request",
      execModel: "script",
      executionMode: "script",
      script: {
        ...createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { ok: true };" }),
        parameters: [
          { key: "body", label: "Request body", location: "body", valueType: "json", source: "user", required: true },
          { key: "authorization", label: "Authorization", location: "header", valueType: "string", source: "user", required: false },
        ],
      },
      outputFields: [{ key: "ok", required: true }],
    }];
    definition.edges = [];
    const persisted: WorkflowV2PersistedRunState[] = [];
    let executeCount = 0;
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => { persisted.push(structuredClone(state)); },
        appendEvents: async () => undefined,
      },
      executeScript: async () => { executeCount += 1; throw new Error("must not execute"); },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(executeCount).toBe(0);
    expect(fixture.updates.flatMap((update) => update.progress ?? []).filter((item) => item.nodeId === "submit").at(-1)).toMatchObject({
      status: "awaiting_input",
      detail: "Waiting for Request body, Authorization",
      inputRequest: {
        kind: "script_parameters",
        parameters: [
          { key: "body", label: "Request body", location: "body", valueType: "json", source: "user", required: true },
          { key: "authorization", label: "Authorization", location: "header", valueType: "string", source: "user", required: false },
        ],
      },
    });
    expect(persisted.at(-1)?.nodeControl.submit?.scriptInput).toMatchObject({ requestedParameters: [{ key: "body", location: "body", valueType: "json" }, { key: "authorization", location: "header", valueType: "string" }], submittedValues: {} });
  });
  test("validates submitted values, persists them, and resumes with frozen inputs", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{ id: "submit", kind: "request", title: "Submit request", execModel: "script", executionMode: "script", script: { ...createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { ok: true };" }), parameters: [{ key: "body", label: "Request body", location: "body", valueType: "json", source: "user", required: true }] }, outputFields: [{ key: "ok", required: true }] }];
    definition.edges = [];
    let persistedPlan!: WorkflowV2Plan;
    let persistedState!: WorkflowV2PersistedRunState;
    const observedInputs: Array<Readonly<Record<string, unknown>>> = [];
    const store: WorkflowV2StorePort = {
      persistRunState: async (state) => { persistedState = structuredClone(state); },
      appendEvents: async () => undefined,
      readRunState: async () => persistedState,
    };
    const fixture = await workflowV2RuntimeFixture({ definition, store, executeScript: async (request) => { observedInputs.push(request.inputs); return { nodeId: request.node.id, summary: "Submitted", outputs: { ok: true }, proposals: [] }; } });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    let pausedRunState = createWorkflowV2RunState({ definition });
    pausedRunState = transitionWorkflowV2NodeState(pausedRunState, { nodeId: "submit", status: "running", now: 1 });
    pausedRunState = transitionWorkflowV2NodeState(pausedRunState, { nodeId: "submit", status: "paused", now: 2, intervention: { nodeId: "submit", source: "supervision_pause", reason: "Script node is waiting for required typed input.", allowedActions: ["continue"], requestedAt: 2 } });
    persistedState = { schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION, workflowId: definition.workflowId, runId: "run-v2-runtime", graphVersion: definition.graphVersion, savedAt: 2, eventCount: 0, plan: persistedPlan, runState: pausedRunState, workerOutputs: [], nodeControl: { submit: { extensionCount: 0, scriptInput: { requestedParameters: definition.nodes[0]!.execModel === "script" ? definition.nodes[0]!.script.parameters : [], submittedValues: {}, auditValues: {}, requestedAt: 1 } } } };
    fixture.setRuns([{ runId: "run-v2-runtime", workflowId: definition.workflowId, status: "waiting_for_user", workflowV2Plan: persistedPlan, progress: [{ nodeId: "submit", title: "Submit request", status: "awaiting_input" }], events: [], contextDocument: "", startedAt: 1, finishedAt: undefined, lastError: undefined }]);

    const result = await fixture.runtime.submitWorkflowScriptInput({ workflowId: definition.workflowId, runId: "run-v2-runtime", nodeId: "submit", values: { body: { question: "hello" } } });
    const finished = await fixture.finished;

    expect(result.ok).toBe(true);
    expect(observedInputs).toEqual([{ body: { question: "hello" } }]);
    expect(finished.status).toBe("completed");
    expect(persistedState.nodeControl.submit?.scriptInput).toMatchObject({ auditValues: { body: { question: "hello" } }, submittedAt: expect.any(Number) });
    const completedProgress = fixture.updates.flatMap((update) => update.progress ?? []).filter((item) => item.nodeId === "submit").at(-1);
    expect(completedProgress?.inputRequest).toBeUndefined();
    expect(completedProgress?.outputs).toEqual({ ok: true });
  });

  test("rejects a node override whose configured agent no longer exists", () => {
    expect(() => resolveWorkflowNodeAgent({ configuredAgentId: "missing" }, WORKFLOW_DEFAULTS, AGENTS)).toThrow("configured agent missing was not found");
  });
});

describe("WorkflowRuntime script permissions", () => {
  test("pauses when the frozen reviewer risk upgrades a safe script to write", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{ id: "reviewed", kind: "transform", title: "Reviewed", execModel: "script", executionMode: "script", script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { ok: true };", risk: "safe" }), outputFields: [{ key: "ok", required: true }] }];
    definition.edges = [];
    const fixture = await workflowV2RuntimeFixture({ definition, executeScript: async () => { throw new Error("must not execute"); } });
    fixture.workflow.workflowV2Plan = freezeWorkflowV2ScriptGovernance({ plan: fixture.workflow.workflowV2Plan!, reviewedRevision: 1, reviewerRisks: { reviewed: { level: "write", rationale: "Reviewer identified mutation risk." } } });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(JSON.stringify(fixture.updates)).toContain("Approve write script node Reviewed?");
  });

  test("fails closed when a command script is mislabeled safe", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{ id: "command", kind: "transform", title: "Run command", execModel: "script", executionMode: "script", script: { executable: { kind: "command", command: "tool", args: [] }, parameters: [], capabilities: [], managerRisk: { level: "safe", rationale: "Incorrectly labeled safe." } }, outputFields: [{ key: "stdout", required: true }] }];
    definition.edges = [];
    let executeCount = 0;
    const fixture = await workflowV2RuntimeFixture({ definition, executeScript: async () => { executeCount += 1; throw new Error("must not execute"); } });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 5));

    expect(executeCount).toBe(0);
    expect(fixture.updates.flatMap((update) => update.progress ?? []).filter((item) => item.nodeId === "command").at(-1)).toMatchObject({ status: "paused" });
    expect(JSON.stringify(fixture.updates)).toContain("dangerous");
  });

  test("executes the exact dangerous operation once after explicit approval", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{ id: "command", kind: "transform", title: "Run command", execModel: "script", executionMode: "script", script: { executable: { kind: "command", command: "tool", args: ["--write"] }, parameters: [], capabilities: ["workspace_write"], managerRisk: { level: "dangerous", rationale: "Writes workspace files." } }, outputFields: [{ key: "stdout", required: true }] }];
    definition.edges = [];
    let persistedState!: WorkflowV2PersistedRunState;
    const durableEvents: import("../../shared/workflow-v2/storage").WorkflowV2DurableEvent[] = [];
    const authorizations: ExecuteWorkflowV2ScriptRequest["authorization"][] = [];
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => { persistedState = structuredClone(state); },
        appendEvents: async ({ events }) => { durableEvents.push(...structuredClone(events)); },
        readRunState: async () => persistedState,
        readCacheEntry: async () => undefined,
      },
      executeScript: async (request) => {
        authorizations.push(structuredClone(request.authorization));
        return { nodeId: request.node.id, summary: "Command completed", outputs: { stdout: "ok" }, proposals: [] };
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 5));
    while (fixture.runtime.isRunning("run-v2-runtime")) await new Promise((resolve) => setTimeout(resolve, 0));
    const progress = fixture.updates.flatMap((update) => update.progress ?? []).filter((item) => item.nodeId === "command").at(-1)!;
    const requestId = progress.intervention?.scriptApproval?.requestId;
    fixture.setRuns([{ runId: "run-v2-runtime", workflowId: definition.workflowId, status: "waiting_for_user", workflowV2Plan: fixture.workflow.workflowV2Plan!, progress: [progress], events: [], contextDocument: "", startedAt: 1, finishedAt: undefined, lastError: undefined }]);

    const result = await fixture.runtime.resolveWorkflowV2Intervention({ workflowId: definition.workflowId, runId: "run-v2-runtime", nodeId: "command", action: "approve_once" });
    const finished = await fixture.finished;

    expect(result.ok).toBe(true);
    expect(finished.status).toBe("completed");
    expect(authorizations).toHaveLength(1);
    expect(authorizations[0]).toMatchObject({ decision: "allow_once", approvalRequestId: requestId, nodeId: "command", runId: "run-v2-runtime" });
    expect(authorizations[0]?.operationDigest).toBe(progress.intervention?.scriptApproval?.operationDigest);
    expect(durableEvents.some((event) => event.type === "intervention_approve_once")).toBe(true);
  });

  test("rejects a dangerous operation without calling the script executor", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [{ id: "command", kind: "transform", title: "Delete files", execModel: "script", executionMode: "script", script: { executable: { kind: "command", command: "tool", args: ["--delete"] }, parameters: [], capabilities: ["workspace_delete"], managerRisk: { level: "dangerous", rationale: "Deletes workspace files." } }, outputFields: [{ key: "stdout", required: true }] }];
    definition.edges = [];
    let persistedState!: WorkflowV2PersistedRunState;
    let executeCount = 0;
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => { persistedState = structuredClone(state); },
        appendEvents: async () => undefined,
        readRunState: async () => persistedState,
      },
      executeScript: async () => { executeCount += 1; throw new Error("must not execute"); },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 5));
    while (fixture.runtime.isRunning("run-v2-runtime")) await new Promise((resolve) => setTimeout(resolve, 0));
    const progress = fixture.updates.flatMap((update) => update.progress ?? []).filter((item) => item.nodeId === "command").at(-1)!;
    fixture.setRuns([{ runId: "run-v2-runtime", workflowId: definition.workflowId, status: "waiting_for_user", workflowV2Plan: fixture.workflow.workflowV2Plan!, progress: [progress], events: [], contextDocument: "", startedAt: 1, finishedAt: undefined, lastError: undefined }]);

    const result = await fixture.runtime.resolveWorkflowV2Intervention({ workflowId: definition.workflowId, runId: "run-v2-runtime", nodeId: "command", action: "reject", reason: "User rejected destructive behavior." });
    const finished = await fixture.finished;

    expect(result.ok).toBe(true);
    expect(executeCount).toBe(0);
    expect(finished).toMatchObject({ status: "failed", lastError: "User rejected destructive behavior." });
    expect(persistedState.runState.nodes.command).toMatchObject({ status: "failed", lastError: "User rejected destructive behavior." });
    expect(persistedState.nodeControl.command?.interventionResolution?.action).toBe("reject");
  });
});

describe("WorkflowRuntime Workflow V2 bridge", () => {
  test("routes an LLM node through its selected configured agent", async () => {
    const definition = workflowV2Definition();
    const node = definition.nodes[0]!;
    if (node.execModel !== "llm") throw new Error("expected llm node");
    node.configuredAgentId = "agent-b";
    const fixture = await workflowV2RuntimeFixture({ definition, executeScript: async ({ node: scriptNode }) => ({ nodeId: scriptNode.id, summary: "Verified", outputs: { verified: true }, proposals: [] }) });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    await fixture.finished;

    expect(fixture.taskRequests[0]).toMatchObject({ configuredAgentId: "agent-b", modelId: "model-b" });
  });

  test("keeps an interactive node on the same non-terminal run while awaiting user confirmation", async () => {
    const definition = workflowV2Definition();
    const interactiveNode = definition.nodes[0]!;
    if (interactiveNode.execModel !== "llm") throw new Error("expected llm node");
    interactiveNode.executionMode = "interactive";
    definition.nodes = [interactiveNode];
    definition.edges = [];
    const conversationStarts: string[] = [];
    const fixture = await workflowV2RuntimeFixture({
      definition,
      startWorkflowNodeConversation: async (input) => {
        conversationStarts.push(input.runId);
        return { conversationId: `${input.runId}::${input.nodeId}`, workflowId: input.workflowId, runId: input.runId, nodeId: input.nodeId, configuredAgentId: input.configuredAgentId, modelId: input.modelId, workDir: input.workDir, status: "active", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
      },
      executeScript: async () => { throw new Error("script runner should not be called"); },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) await new Promise((resolve) => setTimeout(resolve, 1));

    expect(conversationStarts).toEqual(["run-v2-runtime"]);
    expect(fixture.updates.at(-1)?.status).toBe("waiting_for_user");
  });
  test("stops a running run without advancing queued descendants", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => ({ nodeId: "verify", summary: "unused", outputs: {}, evidence: [], proposals: [] }),
    });
    fixture.setRuns([{
      runId: "run-v2-runtime",
      workflowId: fixture.workflow.workflowId,
      status: "running",
      workflowV2Plan: fixture.workflow.workflowV2Plan!,
      progress: [
        { nodeId: "draft", title: "Draft", status: "running", taskId: "task-running" },
        { nodeId: "verify", title: "Verify", status: "queued" },
      ],
      events: [],
      contextDocument: "# Preserved context",
      startedAt: 1,
      finishedAt: undefined,
      lastError: undefined,
    }]);

    const result = await fixture.runtime.stopWorkflowRun({ workflowId: fixture.workflow.workflowId, runId: "run-v2-runtime" });
    const finished = await fixture.finished;

    expect(result).toMatchObject({ ok: true, workflowId: fixture.workflow.workflowId, runId: "run-v2-runtime" });
    expect(fixture.stopTaskIds).toEqual(["task-running"]);
    expect(finished).toMatchObject({
      status: "stopped",
      contextDocument: "# Preserved context",
      progress: [
        { nodeId: "draft", status: "paused", taskId: "task-running" },
        { nodeId: "verify", status: "queued" },
      ],
    });
  });
  test("rejects a duplicate run when the run store is running even if the draft status was reset", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    fixture.workflow.status = "draft";
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "running", "running")]);

    const result = fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });

    expect(result).toEqual({
      ok: false,
      workflowId: fixture.workflow.workflowId,
      error: "Workflow is already running.",
    });
    expect(fixture.startRequests).toEqual([]);
    expect(fixture.taskRequests).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  test.each(["stopped", "completed"] as const)("allows a new run after a previous run is %s", async (previousStatus) => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async ({ node }) => ({
        nodeId: node.id,
        summary: "Verification complete",
        outputs: { verified: true },
        proposals: [],
      }),
    });
    fixture.setRuns([
      workflowV2InterventionRun(fixture.workflow, previousStatus, previousStatus === "stopped" ? "queued" : "completed"),
    ]);

    const result = fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    await fixture.finished;

    expect(result).toMatchObject({ ok: true, workflowId: fixture.workflow.workflowId });
    expect(fixture.startRequests).toEqual([fixture.workflow.workflowId]);
  });

  test("runs an independent structured reviewer before accepting an important node", async () => {
    const definition = workflowV2Definition();
    const draftNode = definition.nodes[0]!;
    if (draftNode.execModel !== "llm") throw new Error("test requires an llm node");
    draftNode.judgeDimensions = [{ key: "correctness", description: "The draft must satisfy the objective." }];
    definition.nodes = [draftNode];
    definition.edges = [];
    const fixture = await workflowV2RuntimeFixture({
      definition,
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: request.prompt.includes("independent Workflow V2 reviewer") ? "Independent reviewer" : "Workflow worker",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{
          role: "assistant",
          content: request.prompt.includes("independent Workflow V2 reviewer")
            ? JSON.stringify({
                reviewerNodeId: "reviewer:draft",
                verdict: {
                  decision: "accept",
                  reasons: ["The draft output is supported by concrete evidence."],
                  riskLevel: "low",
                  evidence: ["draft evidence"],
                  confidence: "high",
                },
              })
            : JSON.stringify({
                nodeId: "draft",
                summary: "Draft ready for review",
                outputs: { draft: "const reviewed = true;" },
                evidence: ["draft evidence"],
                proposals: [],
              }),
        }],
        createdAt: index,
        updatedAt: index,
      } as TaskRun),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("completed");
    expect(fixture.taskRequests).toHaveLength(2);
    expect(fixture.taskRequests[1]?.prompt).toContain("independent Workflow V2 reviewer");
    expect(fixture.taskRequests[1]?.prompt).toContain('"executorNodeId":"draft"');
  });

  test("executes hooks around a real node TaskRun and durably accumulates hook variables", async () => {
    const definition = workflowV2Definition();
    const draftNode = definition.nodes[0]!;
    if (draftNode.execModel !== "llm") throw new Error("test requires an llm node");
    draftNode.hooks = {
      beforeExecute: [
        { kind: "setVariable", config: { key: "scope", value: "HOOK_CONTEXT_SENTINEL" } },
        { kind: "injectContext", config: { fromVariable: "scope" } },
      ],
      afterOutput: [{
        kind: "llmHook",
        config: {
          readOnly: true,
          modelProfile: "fast",
          prompt: "Extract the output risk.",
          outputVariable: "risk",
        },
      }],
      afterComplete: [{ kind: "setVariable", config: { key: "complete", value: true } }],
    };
    definition.nodes = [draftNode];
    definition.edges = [];
    const persistedStates: import("../../shared/workflow-v2/storage").WorkflowV2PersistedRunState[] = [];
    const durableEvents: import("../../shared/workflow-v2/storage").WorkflowV2DurableEvent[] = [];
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => {
          persistedStates.push(structuredClone(state));
        },
        appendEvents: async ({ events }) => {
          durableEvents.push(...structuredClone(events));
        },
      },
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: request.developerInstructions?.includes("read-only, low-cost Workflow V2 llmHook") ? "Read-only hook" : "Workflow worker",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{
          role: "assistant",
          content: request.developerInstructions?.includes("read-only, low-cost Workflow V2 llmHook")
            ? JSON.stringify({ severity: "low" })
            : JSON.stringify({
                nodeId: "draft",
                summary: "Hooked draft ready",
                outputs: { draft: "const hooked = true;" },
                proposals: [],
              }),
        }],
        createdAt: index,
        updatedAt: index,
      } as TaskRun),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("completed");
    expect(fixture.taskRequests).toHaveLength(2);
    expect(fixture.taskRequests[0]?.contextDocument).toContain("# Hook-injected context");
    expect(fixture.taskRequests[0]?.contextDocument).toContain("HOOK_CONTEXT_SENTINEL");
    expect(fixture.taskRequests[1]?.developerInstructions).toContain("Do not call tools, modify files, navigate the graph");
    expect(fixture.taskRequests[1]?.developerInstructions).toContain("Model profile: fast");
    expect(persistedStates.at(-1)?.nodeControl.draft?.hookVariables).toEqual({
      scope: "HOOK_CONTEXT_SENTINEL",
      risk: { severity: "low" },
      complete: true,
    });
    expect(durableEvents.map((event) => event.type)).toEqual(expect.arrayContaining([
      "hooks_beforeExecute",
      "hooks_afterOutput",
      "hooks_afterComplete",
    ]));
  });

  test("probes, supervises, and resumes an llm task after its execution lease becomes inactive", async () => {
    const definition = workflowV2Definition();
    const draftNode = definition.nodes[0]!;
    draftNode.executionLease = {
      inactivityTimeoutMs: 5,
      softTimeoutMs: 50,
      hardTimeoutMs: 2_000,
      progressProbeTimeoutMs: 500,
      maxExtensions: 1,
      maxExtensionMs: 500,
    };
    definition.nodes = [draftNode];
    definition.edges = [];
    const conversation = (threadId: string) => ({
      runtimeId: "codex" as const,
      codecVersion: "1",
      payload: { native: { threadId } },
    });

    const fixture = await workflowV2RuntimeFixture({
      definition,
      taskFactory: (request, index) => {
        const base = {
          id: `task-${index}`,
          title: "Workflow V2 supervised task",
          prompt: request.prompt,
          configuredAgentId: request.configuredAgentId,
          modelId: request.modelId ?? "model-a",
          workDir: request.workDir ?? "/tmp/workflow-v2-runtime",
          progress: "in_progress" as const,
          pendingAssistantMessageId: undefined,
          lastError: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        if (request.prompt.includes("Report progress only")) {
          return {
            ...base,
            status: "completed",
            running: false,
            runtimeConversation: conversation("progress-thread"),
            messages: [{ role: "assistant", content: JSON.stringify({
              nodeId: "draft",
              attempt: 1,
              phase: "implementation",
              completedItems: ["drafted implementation"],
              remainingItems: ["return final packet"],
              blockers: [],
              evidence: ["partial implementation exists"],
              checkpoint: "checkpoint-1",
              estimatedRemainingMs: 100,
              safeToInterrupt: true,
              requestedAction: "continue",
              reportedAt: Date.now(),
            }) }],
          } as TaskRun;
        }
        if (request.prompt.includes("Act as the Workflow V2 orchestrator")) {
          return {
            ...base,
            status: "completed",
            running: false,
            messages: [{ role: "assistant", content: JSON.stringify({
              action: "continue",
              extensionMs: 200,
              reason: "The report contains concrete new evidence.",
            }) }],
          } as TaskRun;
        }
        if (request.prompt.includes("Continue the interrupted work")) {
          return {
            ...base,
            status: "completed",
            running: false,
            runtimeConversation: conversation("progress-thread"),
            messages: [{ role: "assistant", content: JSON.stringify({
              nodeId: "draft",
              summary: "Draft completed after supervised continuation",
              outputs: { draft: "const resumed = true;" },
              proposals: [],
            }) }],
          } as TaskRun;
        }
        return {
          ...base,
          status: "running",
          running: true,
          runtimeConversation: conversation("initial-thread"),
          messages: [{ role: "assistant", content: "partial implementation" }],
        } as TaskRun;
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    const started = fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(started).toMatchObject({ ok: true, workflowId: fixture.workflow.workflowId });
    expect(finished.status).toBe("completed");
    expect(fixture.stopTaskIds).toEqual(["task-1"]);
    expect(fixture.taskRequests).toHaveLength(4);
    expect(fixture.taskRequests[1]).toMatchObject({
      continuationPolicy: "resume-required",
      runtimeConversation: conversation("initial-thread"),
    });
    expect(fixture.taskRequests[2]?.continuationPolicy).toBeUndefined();
    expect(fixture.taskRequests[3]).toMatchObject({
      continuationPolicy: "resume-required",
      runtimeConversation: conversation("progress-thread"),
    });
    expect(fixture.deleteTaskRequests).toEqual([
      { taskId: "task-1", preserveRuntimeConversation: true },
      { taskId: "task-2", preserveRuntimeConversation: true },
      { taskId: "task-3", preserveRuntimeConversation: false },
      { taskId: "task-4", preserveRuntimeConversation: false },
    ]);
  });

  test("pauses with durable recovery context when a progress probe does not respond", async () => {
    const definition = workflowV2Definition();
    const draftNode = definition.nodes[0]!;
    draftNode.executionLease = {
      inactivityTimeoutMs: 5,
      softTimeoutMs: 20,
      hardTimeoutMs: 500,
      progressProbeTimeoutMs: 10,
      maxExtensions: 1,
      maxExtensionMs: 50,
    };
    definition.nodes = [draftNode];
    definition.edges = [];
    const persistedStates: import("../../shared/workflow-v2/storage").WorkflowV2PersistedRunState[] = [];
    const conversation = {
      runtimeId: "codex" as const,
      codecVersion: "1",
      payload: { native: { threadId: "probe-timeout-thread" } },
    };
    const fixture = await workflowV2RuntimeFixture({
      definition,
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: request.prompt.includes("Report progress only") ? "Unresponsive progress probe" : "Running worker",
        status: "running",
        running: true,
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        runtimeConversation: conversation,
        messages: [{ role: "assistant", content: "partial evidence" }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as TaskRun),
      store: {
        persistRunState: async (state) => {
          persistedStates.push(structuredClone(state));
        },
        appendEvents: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (!fixture.updates.some((update) => update.status === "waiting_for_user")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    expect(fixture.updates.at(-1)?.status).toBe("waiting_for_user");
    expect(fixture.taskRequests).toHaveLength(2);
    expect(fixture.stopTaskIds).toEqual(["task-1", "task-2"]);
    expect(persistedStates.at(-1)?.runState.nodes.draft).toMatchObject({
      status: "paused",
      intervention: {
        source: "supervision_pause",
        resumeConversation: conversation,
      },
    });
    expect(persistedStates.at(-1)?.nodeControl.draft?.stopReason).toContain("timed out");
  });

  test("persists incremental executor checkpoints and ordered durable events", async () => {
    const persistedStates: import("../../shared/workflow-v2/storage").WorkflowV2PersistedRunState[] = [];
    const persistedEvents: import("../../shared/workflow-v2/storage").WorkflowV2DurableEvent[] = [];
    const cacheEntries: import("../../shared/workflow-v2/storage").WorkflowV2CacheEntryMetadata[] = [];
    const store: WorkflowV2StorePort = {
      persistRunState: async (state) => {
        persistedStates.push(structuredClone(state));
      },
      appendEvents: async ({ events }) => {
        persistedEvents.push(...structuredClone(events));
      },
      persistCacheEntry: async (entry) => {
        cacheEntries.push(structuredClone(entry));
      },
    };
    const fixture = await workflowV2RuntimeFixture({
      store,
      executeScript: async ({ node }) => ({
        nodeId: node.id,
        summary: "Verification complete",
        outputs: { verified: true },
        proposals: [],
      }),
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("completed");
    expect(persistedStates.length).toBeGreaterThanOrEqual(5);
    expect(persistedStates[0]?.runState.nodes.draft?.status).toBe("ready");
    expect(persistedStates.at(-1)?.runState.status).toBe("completed");
    expect(persistedStates.at(-1)?.workerOutputs.map((output) => output.nodeId)).toEqual(["draft", "verify"]);
    expect(persistedStates.at(-1)?.eventCount).toBe(persistedEvents.length);
    expect(persistedEvents.map((event) => event.sequence)).toEqual(
      persistedEvents.map((_event, index) => index),
    );
    expect(cacheEntries.map((entry) => entry.nodeId)).toEqual(["draft", "verify"]);
    expect(cacheEntries.every(
      (entry) => entry.fingerprint.graphVersion === fixture.workflow.workflowV2Plan!.graphVersion,
    )).toBe(true);
  });

  test("fails the run before node execution when the authoritative checkpoint cannot be written", async () => {
    const fixture = await workflowV2RuntimeFixture({
      store: {
        persistRunState: async () => {
          throw new Error("durable store unavailable");
        },
        appendEvents: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("failed");
    expect(finished.lastError).toContain("durable store unavailable");
    expect(fixture.taskRequests).toEqual([]);
  });

  test("pauses a running V2 task through the unified intervention boundary", async () => {
    const fixture = await workflowV2RuntimeFixture({
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: "Running Workflow V2 task",
        status: "running",
        running: true,
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{ role: "assistant", content: "Partial work" }],
        createdAt: index,
        updatedAt: index,
      } as TaskRun),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    while (fixture.taskRequests.length === 0) await Promise.resolve();
    const running = workflowV2InterventionRun(fixture.workflow, "running", "running");
    running.runId = "run-v2-runtime";
    running.progress[0]!.taskId = "task-1";
    fixture.setRuns([running]);

    const result = await fixture.runtime.pauseWorkflowNode({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-runtime",
      nodeId: "draft",
    });
    for (let attempt = 0; attempt < 20 && fixture.updates.filter((update) => update.status === "waiting_for_user").length < 2; attempt += 1) await Promise.resolve();
    expect(result).toEqual({ ok: true, workflowId: fixture.workflow.workflowId, runId: "run-v2-runtime" });
    const waitingUpdates = fixture.updates.filter((update) => update.status === "waiting_for_user");
    expect(waitingUpdates).toHaveLength(2);
    expect(waitingUpdates.at(-1)?.progress).toContainEqual(expect.objectContaining({ nodeId: "draft", status: "paused" }));
    expect(fixture.stopTaskIds).toEqual(["task-1"]);
    expect(fixture.updates).toContainEqual(expect.objectContaining({ appendEvents: expect.arrayContaining([
      expect.objectContaining({ type: "node_paused", nodeId: "draft" }),
    ]) }));
  });

  test("fails V2 start intervention before resuming through the legacy executor", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "queued")]);

    const result = await fixture.runtime.startWorkflowNode({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
    });
    await Promise.resolve();

    expect(result).toEqual({
      ok: false,
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      error: "Workflow V2 durable state is unavailable.",
    });
    expect(fixture.stopTaskIds).toEqual([]);
    expect(fixture.taskRequests).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  test("recovers reusable nodes and reruns only unfinished work from durable state", async () => {
    let scriptCalls = 0;
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition: workflowV2Definition(), maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "running", now: 1_100 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "completed", now: 1_200 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "verify", status: "running", now: 1_300 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "verify",
      status: "paused",
      now: 1_400,
      error: "Interrupted",
    });
    const fixture = await workflowV2RuntimeFixture({
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: workflowV2Definition().workflowId,
          runId,
          graphVersion: workflowV2Definition().graphVersion,
          savedAt: 1_500,
          eventCount: 4,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [{
            nodeId: "draft",
            summary: "Recovered draft",
            outputs: { draft: "const recovered = true;" },
            proposals: [],
          }],
          nodeControl: { draft: { extensionCount: 0 }, verify: { extensionCount: 0 } },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        scriptCalls += 1;
        expect(upstreamOutputs[0]?.summary).toBe("Recovered draft");
        return {
          nodeId: node.id,
          summary: "Recovered verification complete",
          outputs: { verified: true },
          proposals: [],
        };
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resumed = await fixture.runtime.startWorkflowNode({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "verify",
    });
    const finished = await fixture.finished;

    expect(resumed).toMatchObject({ ok: true, runId: "run-v2-intervention" });
    expect(finished.status).toBe("completed");
    expect(scriptCalls).toBe(1);
    expect(fixture.taskRequests).toEqual([]);
  });

  test("resumes an interrupted LLM node with its checkpoint and runtime conversation", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [definition.nodes[0]!];
    definition.edges = [];
    const resumeConversation = {
      runtimeId: "codex" as const,
      codecVersion: "1",
      payload: { native: { threadId: "recovery-thread" } },
    };
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition, maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "running",
      now: 1_100,
    });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "paused",
      now: 1_200,
      error: "Interrupted after progress probe",
      intervention: {
        nodeId: "draft",
        source: "supervision_pause",
        reason: "Continue from the captured checkpoint.",
        allowedActions: ["continue"],
        requestedAt: 1_200,
        resumeConversation,
      },
    });
    const fixture = await workflowV2RuntimeFixture({
      definition,
      llmArtifact: JSON.stringify({
        nodeId: "draft",
        summary: "Recovered draft complete",
        outputs: { draft: "const resumed = true;" },
        proposals: [],
      }),
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: definition.workflowId,
          runId,
          graphVersion: definition.graphVersion,
          savedAt: 1_300,
          eventCount: 2,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [],
          nodeControl: {
            draft: {
              extensionCount: 1,
              checkpoint: "checkpoint-from-progress-probe",
              stopReason: "supervision_pause",
            },
          },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resumed = await fixture.runtime.startWorkflowNode({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
    });
    const finished = await fixture.finished;

    expect(resumed).toMatchObject({ ok: true, runId: "run-v2-intervention" });
    expect(finished.status).toBe("completed");
    expect(fixture.taskRequests).toHaveLength(1);
    expect(fixture.taskRequests[0]).toMatchObject({
      continuationPolicy: "resume-required",
      runtimeConversation: resumeConversation,
    });
    expect(fixture.taskRequests[0]?.contextDocument).toContain("# Recovery checkpoint");
    expect(fixture.taskRequests[0]?.contextDocument).toContain("checkpoint-from-progress-probe");
  });

  test("skips an intervened node and continues eligible downstream work", async () => {
    const definition = workflowV2Definition();
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition, maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "running", now: 1_100 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "paused",
      now: 1_200,
      intervention: {
        nodeId: "draft",
        source: "validation",
        reason: "Human decision required.",
        allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
        requestedAt: 1_200,
      },
    });
    const durableEvents: import("../../shared/workflow-v2/storage").WorkflowV2DurableEvent[] = [];
    const persistedStates: import("../../shared/workflow-v2/storage").WorkflowV2PersistedRunState[] = [];
    let scriptCalls = 0;
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => {
          persistedStates.push(structuredClone(state));
        },
        appendEvents: async ({ events }) => {
          durableEvents.push(...structuredClone(events));
        },
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: definition.workflowId,
          runId,
          graphVersion: definition.graphVersion,
          savedAt: 1_300,
          eventCount: 3,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [],
          nodeControl: { draft: { extensionCount: 0 }, verify: { extensionCount: 0 } },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        scriptCalls += 1;
        expect(upstreamOutputs).toEqual([
          expect.objectContaining({ nodeId: "draft", summary: expect.stringContaining("Skipped by human intervention") }),
        ]);
        return { nodeId: node.id, summary: "Verified after skip", outputs: { verified: true }, proposals: [] };
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resolved = await fixture.runtime.resolveWorkflowV2Intervention({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
      action: "skip",
      reason: "The draft is optional for this recovery.",
    });
    const finished = await fixture.finished;

    expect(resolved).toMatchObject({ ok: true, runId: "run-v2-intervention" });
    expect(finished.lastError).toBeUndefined();
    expect(finished.status).toBe("completed");
    expect(scriptCalls).toBe(1);
    expect(fixture.taskRequests).toEqual([]);
    expect(durableEvents[0]).toMatchObject({ sequence: 3, type: "intervention_skip", nodeId: "draft" });
    expect(persistedStates.at(-1)?.nodeControl.draft?.interventionResolution).toMatchObject({
      action: "skip",
      reason: "The draft is optional for this recovery.",
    });
  });

  test("answers a V2 user-input node by rerunning with the human answer injected into the prompt", async () => {
    const definition = workflowV2Definition();
    definition.nodes = [definition.nodes[0]!];
    definition.edges = [];
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition, maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "running", now: 1_100 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "paused",
      now: 1_200,
      intervention: {
        nodeId: "draft",
        source: "validation",
        reason: "Need a concrete environment choice before continuing.",
        allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
        requestedAt: 1_200,
      },
    });
    const humanAnswer = "Use the staging environment and continue from the existing draft.";
    const fixture = await workflowV2RuntimeFixture({
      definition,
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: "Worker",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{
          role: "assistant",
          content: JSON.stringify({
            nodeId: "draft",
            summary: "Recovered with the provided environment choice",
            outputs: { draft: "const target = 'staging';" },
            evidence: ["human input consumed"],
            proposals: [],
          }),
        }],
        createdAt: index,
        updatedAt: index,
      } as TaskRun),
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: definition.workflowId,
          runId,
          graphVersion: definition.graphVersion,
          savedAt: 1_300,
          eventCount: 2,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [],
          nodeControl: { draft: { extensionCount: 0 } },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resolved = await fixture.runtime.answerWorkflowGate({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
      answer: humanAnswer,
    });
    const finished = await fixture.finished;

    expect(resolved.ok).toBe(true);
    expect(finished.status).toBe("completed");
    expect(fixture.taskRequests).toHaveLength(1);
    expect(fixture.taskRequests[0]?.prompt).toContain(humanAnswer);
    expect(fixture.taskRequests[0]?.developerInstructions).toContain(humanAnswer);
  });

  test.each([
    ["escalate", true],
    ["increase_review_strength", false],
  ] as const)("resolves %s by rerunning with mandatory independent review", async (action, expectsExpertProfile) => {
    const definition = workflowV2Definition();
    definition.nodes = [definition.nodes[0]!];
    definition.edges = [];
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition, maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "running", now: 1_100 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "paused",
      now: 1_200,
      intervention: {
        nodeId: "draft",
        source: "review_escalation",
        reason: "Review requires a human decision.",
        allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
        requestedAt: 1_200,
      },
    });
    const fixture = await workflowV2RuntimeFixture({
      definition,
      taskFactory: (request, index) => ({
        id: `task-${index}`,
        title: request.prompt.includes("independent Workflow V2 reviewer") ? "Reviewer" : "Worker",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{
          role: "assistant",
          content: request.prompt.includes("independent Workflow V2 reviewer")
            ? JSON.stringify({
                reviewerNodeId: "reviewer:draft",
                verdict: {
                  decision: "accept",
                  reasons: ["The strengthened review passed."],
                  riskLevel: "low",
                  confidence: "high",
                },
              })
            : JSON.stringify({
                nodeId: "draft",
                summary: "Recovered under stronger controls",
                outputs: { draft: "const strengthened = true;" },
                evidence: ["strong evidence"],
                proposals: [],
              }),
        }],
        createdAt: index,
        updatedAt: index,
      } as TaskRun),
      store: {
        persistRunState: async () => undefined,
        appendEvents: async () => undefined,
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: definition.workflowId,
          runId,
          graphVersion: definition.graphVersion,
          savedAt: 1_300,
          eventCount: 2,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [],
          nodeControl: { draft: { extensionCount: 0 } },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resolved = await fixture.runtime.resolveWorkflowV2Intervention({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
      action,
    });
    const finished = await fixture.finished;

    expect(resolved.ok).toBe(true);
    expect(finished.status).toBe("completed");
    expect(fixture.taskRequests).toHaveLength(2);
    expect(fixture.taskRequests[0]?.developerInstructions).toContain("mandatory independent review");
    expect(/"modelProfile":\s*"expert"/.test(fixture.taskRequests[0]?.contextDocument ?? "")).toBe(expectsExpertProfile);
    expect(fixture.taskRequests[1]?.prompt).toContain("independent Workflow V2 reviewer");
  });

  test("records replan without mutating or rerunning the frozen plan", async () => {
    const definition = workflowV2Definition();
    let persistedPlan!: NonNullable<WorkflowDraftState["workflowV2Plan"]>;
    let persistedRunState = createWorkflowV2RunState({ definition, maxParallelNodes: 4 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, { nodeId: "draft", status: "running", now: 1_100 });
    persistedRunState = transitionWorkflowV2NodeState(persistedRunState, {
      nodeId: "draft",
      status: "paused",
      now: 1_200,
      intervention: {
        nodeId: "draft",
        source: "supervision_pause",
        reason: "The approved graph is no longer sufficient.",
        allowedActions: ["replan"],
        requestedAt: 1_200,
      },
    });
    const persistedStates: import("../../shared/workflow-v2/storage").WorkflowV2PersistedRunState[] = [];
    const fixture = await workflowV2RuntimeFixture({
      definition,
      store: {
        persistRunState: async (state) => {
          persistedStates.push(structuredClone(state));
        },
        appendEvents: async () => undefined,
        readRunState: async (_workflowId, runId) => ({
          schemaVersion: WORKFLOW_V2_STORAGE_SCHEMA_VERSION,
          workflowId: definition.workflowId,
          runId,
          graphVersion: definition.graphVersion,
          savedAt: 1_300,
          eventCount: 2,
          plan: persistedPlan,
          runState: persistedRunState,
          workerOutputs: [],
          nodeControl: { draft: { extensionCount: 0 }, verify: { extensionCount: 0 } },
        }),
        readCacheEntry: async () => undefined,
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    persistedPlan = fixture.workflow.workflowV2Plan!;
    const frozenPlanBefore = structuredClone(persistedPlan);
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "paused")]);

    const resolved = await fixture.runtime.resolveWorkflowV2Intervention({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
      action: "replan",
    });
    const finished = await fixture.finished;

    expect(resolved.ok).toBe(true);
    expect(finished).toMatchObject({ status: "stopped", progress: [expect.objectContaining({ nodeId: "draft", status: "paused" })] });
    expect(fixture.taskRequests).toEqual([]);
    expect(persistedStates[0]?.plan).toEqual(frozenPlanBefore);
    expect(persistedStates[0]?.nodeControl.draft?.interventionResolution?.action).toBe("replan");
  });

  test("routes a legacy V2 gate answer through the unified intervention surface", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    fixture.setRuns([workflowV2InterventionRun(fixture.workflow, "stopped", "awaiting_input")]);

    const result = await fixture.runtime.answerWorkflowGate({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      nodeId: "draft",
      answer: "Continue",
    });
    await Promise.resolve();

    expect(result).toEqual({
      ok: false,
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-intervention",
      error: "Workflow V2 durable state is unavailable.",
    });
    expect(fixture.stopTaskIds).toEqual([]);
    expect(fixture.taskRequests).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  test("rejects a frozen plan that duplicates one plan node and omits another before starting a run", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    const plan = fixture.workflow.workflowV2Plan!;
    plan.nodes = [structuredClone(plan.nodes[0]!), structuredClone(plan.nodes[0]!)];

    const result = fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });

    expect(result).toEqual({
      ok: false,
      workflowId: fixture.workflow.workflowId,
      error: "Workflow V2 plan nodes do not match the frozen definition.",
    });
    expect(fixture.startRequests).toEqual([]);
  });

  test.each([
    ["blank approvedBy", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.approvedBy = "   ";
    }],
    ["negative frozenAt", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.frozenAt = -1;
    }],
    ["non-finite frozenAt", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.frozenAt = Number.NaN;
    }],
    ["blank objective", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.objective = " ";
    }],
    ["tampered task constraints", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.nodes[0]!.taskPacket.constraints = [{ key: "injected", description: "Injected after approval." }];
    }],
    ["tampered direct upstream digest", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.nodes[1]!.taskPacket.upstreamDigest = [];
    }],
    ["tampered node budget", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.nodes[0]!.budget.context.maxContextTokens += 1;
    }],
    ["tampered node acceptance criteria", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.nodes[0]!.acceptanceCriteria[0]!.description = "Injected acceptance criterion.";
    }],
    ["invalid top-level budget", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.budget.context.maxContextTokens = Number.NaN;
    }],
    ["invalid top-level acceptance criteria", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.acceptanceCriteria = [{ key: "", description: "Invalid criterion" }];
    }],
    ["duplicate trimmed top-level acceptance criteria", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.acceptanceCriteria = [
        { key: "release.ready", description: "Ready" },
        { key: " release.ready ", description: "Still ready" },
      ];
    }],
    ["invalid role defaults", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.roleDefaults.executor = { role: "reviewer", modelProfile: "fast" };
    }],
    ["non-topological node order", (plan: NonNullable<WorkflowDraftState["workflowV2Plan"]>) => {
      plan.nodes.reverse();
    }],
  ])("rejects a frozen plan with %s before starting a run", async (_name, mutatePlan) => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    mutatePlan(fixture.workflow.workflowV2Plan!);

    const result = fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });

    expect(result).toMatchObject({
      ok: false,
      workflowId: fixture.workflow.workflowId,
      error: expect.stringContaining("Workflow V2"),
    });
    expect(fixture.startRequests).toEqual([]);
    expect(fixture.taskRequests).toEqual([]);
    expect(fixture.updates).toEqual([]);
  });

  test("fails a zero maxModelCalls budget before starting an LLM task", async () => {
    let scriptCalls = 0;
    const fixture = await workflowV2RuntimeFixture({
      costBudget: { maxModelCalls: 0 },
      executeScript: async ({ node }) => {
        scriptCalls += 1;
        return { nodeId: node.id, summary: "unexpected", outputs: { verified: true }, proposals: [] };
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(fixture.taskRequests).toEqual([]);
    expect(scriptCalls).toBe(0);
    expect(finished).toMatchObject({
      status: "failed",
      progress: [
        { nodeId: "draft", status: "failed", detail: "Workflow V2 model-call budget exhausted before node draft." },
        { nodeId: "verify", status: "queued" },
      ],
      lastError: "Workflow V2 model-call budget exhausted before node draft.",
    });
  });

  test("fails a zero maxPromptTokens budget before starting an LLM task", async () => {
    const fixture = await workflowV2RuntimeFixture({
      costBudget: { maxPromptTokens: 0 },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(fixture.taskRequests).toEqual([]);
    expect(finished).toMatchObject({
      status: "failed",
      progress: [
        { nodeId: "draft", status: "failed", detail: expect.stringContaining("prompt budget") },
        { nodeId: "verify", status: "queued" },
      ],
      lastError: expect.stringContaining("prompt budget"),
    });
  });

  test("fails when fixed task context exceeds maxContextTokens before starting an LLM task", async () => {
    const fixture = await workflowV2RuntimeFixture({
      definition: workflowV2Definition(),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });
    const plan = fixture.workflow.workflowV2Plan!;
    plan.budget.context.maxContextTokens = 1;
    for (const planNode of plan.nodes) {
      planNode.budget.context.maxContextTokens = 1;
      planNode.taskPacket.budget.context.maxContextTokens = 1;
    }

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(fixture.taskRequests).toEqual([]);
    expect(finished).toMatchObject({
      status: "failed",
      progress: [
        { nodeId: "draft", status: "failed", detail: expect.stringContaining("fixed context") },
        { nodeId: "verify", status: "queued" },
      ],
      lastError: expect.stringContaining("fixed context"),
    });
  });

  test.each([
    ["summarize", "summarize fallback is unavailable", "SUMMARIZE_RUNTIME_SENTINEL_MUST_NOT_REACH_RUN_TASK"],
    ["ask_human", "Phase 04 human intervention", "ASK_HUMAN_RUNTIME_SENTINEL_MUST_NOT_REACH_RUN_TASK"],
  ] as const)(
    "fails the node and run without task or intervention state when %s fallback is required",
    async (summaryFallbackPolicy, expectedError, contextSentinel) => {
      const fixture = await workflowV2RuntimeFixture({
        contextBudget: {
          maxContextTokens: 1_000,
          summaryFallbackPolicy,
        },
        executeScript: async () => {
          throw new Error("script runner should not be called");
        },
      });

      fixture.runtime.runWorkflow({
        workflowId: fixture.workflow.workflowId,
        contextDocument: `${"x".repeat(10_000)}${contextSentinel}`,
      });
      const finished = await fixture.finished;

      expect(fixture.taskRequests).toEqual([]);
      expect(JSON.stringify(fixture.taskRequests)).not.toContain(contextSentinel);
      expect(finished).toMatchObject({
        status: "failed",
        progress: [
          { nodeId: "draft", status: "failed", detail: expect.stringContaining(expectedError) },
          { nodeId: "verify", status: "queued" },
        ],
        lastError: expect.stringContaining(expectedError),
      });
      const events = fixture.updates.flatMap((update) => update.appendEvents ?? []);
      expect(events.map((event) => event.type)).toEqual(["node_started", "node_failed"]);
      expect(events.some((event) => event.type === "gate_opened" || event.type === "node_paused")).toBe(false);
      expect(fixture.updates.flatMap((update) => update.progress ?? []).some(
        (progress) => progress.status === "paused" || progress.status === "awaiting_input",
      )).toBe(false);
    },
  );

  test("fails a zero maxWallClockMs budget before starting a script dependency", async () => {
    const scriptDefinition: WorkflowV2Definition = {
      workflowId: "workflow-v2-runtime",
      graphVersion: 5,
      objective: "Enforce wall-clock budget before script start",
      nodes: [{
        id: "script-only",
        kind: "verification",
        title: "Script only",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "printf should-not-run" }),
        outputFields: [{ key: "verified", required: true }],
      }],
      edges: [],
    };
    let scriptCalls = 0;
    const fixture = await workflowV2RuntimeFixture({
      definition: scriptDefinition,
      costBudget: { maxWallClockMs: 0 },
      executeScript: async ({ node }) => {
        scriptCalls += 1;
        return { nodeId: node.id, summary: "unexpected", outputs: { verified: true }, proposals: [] };
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(fixture.taskRequests).toEqual([]);
    expect(scriptCalls).toBe(0);
    expect(finished).toMatchObject({
      status: "failed",
      progress: [{
        nodeId: "script-only",
        status: "failed",
        detail: "Workflow V2 wall-clock budget exhausted before node script-only.",
      }],
      lastError: "Workflow V2 wall-clock budget exhausted before node script-only.",
    });
  });

  test("aborts an in-flight script at the wall-clock deadline and rejects its late completion", async () => {
    const scriptDefinition: WorkflowV2Definition = {
      workflowId: "workflow-v2-runtime",
      graphVersion: 6,
      objective: "Abort an in-flight script at the run deadline",
      nodes: [{
        id: "script-only",
        kind: "verification",
        title: "Script only",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "printf late", timeoutMs: 5_000 }),
        outputFields: [{ key: "verified", required: true }],
      }],
      edges: [],
    };
    let aborted = false;
    let observedTimeoutMs: number | undefined;
    const fixture = await workflowV2RuntimeFixture({
      definition: scriptDefinition,
      costBudget: { maxWallClockMs: 100 },
      executeScript: async (request) => {
        observedTimeoutMs = request.timeoutMs;
        if (!(request.signal instanceof AbortSignal)) throw new Error("expected an AbortSignal");
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
        return {
          nodeId: request.node.id,
          summary: "late completion must be ignored",
          outputs: { verified: true },
          proposals: [],
        };
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(observedTimeoutMs).toBeGreaterThan(0);
    expect(observedTimeoutMs).toBeLessThanOrEqual(100);
    expect(aborted).toBe(true);
    expect(finished).toMatchObject({
      status: "failed",
      progress: [{ nodeId: "script-only", status: "failed", detail: expect.stringContaining("timed out") }],
      lastError: expect.stringContaining("timed out"),
    });
    expect(finished.finalReport).not.toContain("late completion must be ignored");
  });

  test("bounds an oversized script timeout to the platform timer range", async () => {
    const scriptDefinition: WorkflowV2Definition = {
      workflowId: "workflow-v2-runtime",
      graphVersion: 7,
      objective: "Bound an oversized script timer",
      nodes: [{
        id: "script-only",
        kind: "verification",
        title: "Script only",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "printf bounded", timeoutMs: Number.MAX_SAFE_INTEGER }),
        outputFields: [{ key: "verified", required: true }],
      }],
      edges: [],
    };
    let observedTimeoutMs: number | undefined;
    const fixture = await workflowV2RuntimeFixture({
      definition: scriptDefinition,
      executeScript: async (request) => {
        observedTimeoutMs = request.timeoutMs;
        return {
          nodeId: request.node.id,
          summary: "bounded timer completed",
          outputs: { verified: true },
          proposals: [],
        };
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(observedTimeoutMs).toBeGreaterThan(0);
    expect(observedTimeoutMs).toBeLessThanOrEqual(2_147_483_647);
    expect(finished.status).toBe("completed");
  });

  test("fails a one-shot node that requests user input and blocks downstream execution", async () => {
    const conversationStarts: Array<{ initialPrompt: string; developerInstructions?: string; contextDocument?: string }> = [];
    const waitingQuestions: string[] = [];
    const scriptRequests: ExecuteWorkflowV2ScriptRequest[] = [];
    const question = "Which deployment region and retention policy should I use?";
    const fixture = await workflowV2RuntimeFixture({
      taskFactory: (request) => ({
        id: "task-input-request", title: "Workflow V2 LLM node", status: "running", running: true,
        progress: "in_progress", prompt: request.prompt, configuredAgentId: request.configuredAgentId,
        modelId: request.modelId ?? "model-a", workDir: request.workDir ?? "/tmp/workflow-v2-runtime",
        messages: [{ id: "assistant-input-request", role: "assistant", content: question, timestamp: 1, events: [{
          id: "event-input-request", type: "user_input_request", content: question, timestamp: 1,
          requestId: "request-1", requestState: "live",
        }] }],
        pendingAssistantMessageId: undefined, lastError: undefined, createdAt: 1, updatedAt: 1,
      }),
      startWorkflowNodeConversation: async (input) => {
        conversationStarts.push(input);
        return { conversationId: "workflow-node-conversation", workflowId: input.workflowId, runId: input.runId,
          nodeId: input.nodeId, configuredAgentId: input.configuredAgentId, modelId: input.modelId, workDir: input.workDir,
          status: "active", messages: [], createdAt: 1, updatedAt: 1, lastActivityAt: 1 };
      },
      markWorkflowNodeConversationWaiting: (_conversationId, prompt) => {
        waitingQuestions.push(prompt);
        return { conversationId: "workflow-node-conversation" } as WorkflowNodeConversation;
      },
      executeScript: async (request) => { scriptRequests.push(request); throw new Error("downstream script must remain blocked"); },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("failed");
    expect(fixture.stopTaskIds).toContain("task-input-request");
    expect(conversationStarts).toHaveLength(0);
    expect(waitingQuestions).toHaveLength(0);
    expect(scriptRequests).toHaveLength(0);
  });

  test("branches before legacy execution and runs llm then script nodes with direct upstream outputs", async () => {
    const proposalReason = "runtime-control-only";
    const scriptRequests: ExecuteWorkflowV2ScriptRequest[] = [];
    const fixture = await workflowV2RuntimeFixture({
      costBudget: {
        maxModelCalls: 1,
        maxPromptTokens: 4_000,
        maxCompletionTokens: 321,
        maxWallClockMs: 10_000,
      },
      llmArtifact: JSON.stringify({
        nodeId: "draft",
        summary: "Draft ready",
        outputs: { draft: "const ready = true;" },
        evidence: ["draft evidence"],
        proposals: [{ kind: "escalate", reason: proposalReason }],
      }),
      executeScript: async (request) => {
        scriptRequests.push(request);
        return {
          nodeId: request.node.id,
          summary: "Verification passed",
          outputs: { verified: true },
          evidence: ["script evidence"],
          proposals: [],
        };
      },
    });

    const started = fixture.runtime.runWorkflow({
      workflowId: fixture.workflow.workflowId,
      contextDocument: "# Base context\nUse the approved implementation constraints.",
    });
    const finished = await fixture.finished;

    expect(started).toEqual({ ok: true, workflowId: fixture.workflow.workflowId, runId: "run-v2-runtime" });
    expect(fixture.taskRequests).toHaveLength(1);
    expect(fixture.taskRequests[0]).toMatchObject({
    configuredAgentId: "agent-a",
    modelId: "model-a",
      workDir: "/tmp/workflow-v2-runtime",
    });
    expect(fixture.taskRequests[0]?.prompt).toBe("Produce the implementation draft from the approved packet.");
    expect(fixture.taskRequests[0]?.developerInstructions).toContain("Workflow Storage Plan");
    expect(fixture.taskRequests[0]?.developerInstructions).toContain("MUST call that tool exactly once");
    expect(fixture.taskRequests[0]?.developerInstructions).toContain("Do not print the worker-output JSON");
    expect(fixture.taskRequests[0]?.contextDocument).toContain("Workflow V2 task packet");
    expect(fixture.taskRequests[0]?.contextDocument).toContain('"nodeId": "draft"');
    expect(fixture.taskRequests[0]?.contextDocument).toContain('"upstreamOutputs": []');
    expect(fixture.taskRequests[0]?.contextDocument).toContain("# Base context");
    expect(fixture.taskRequests[0]?.contextDocument).toContain('"maxCompletionTokens": 321');
    expect(fixture.taskRequests[0]?.prompt).not.toContain("workflow judge");
    expect(fixture.taskRequests[0]?.prompt).not.toContain("main workflow agent");

    expect(scriptRequests).toHaveLength(1);
    expect(scriptRequests[0]).toMatchObject({
      node: { id: "verify" },
      workDir: "/tmp/workflow-v2-runtime",
      authorization: expect.objectContaining({ decision: "auto_allow", nodeId: "verify", risk: "safe" }),
      upstreamOutputs: [{
        nodeId: "draft",
        outputs: { draft: "const ready = true;" },
      }],
      signal: expect.any(AbortSignal),
      timeoutMs: 5_000,
    });
    expect(Object.hasOwn(scriptRequests[0]!.upstreamOutputs[0]!, "proposals")).toBe(false);
    expect(JSON.stringify(scriptRequests)).not.toContain(proposalReason);
    expect(finished).toMatchObject({
      workflowId: fixture.workflow.workflowId,
      runId: "run-v2-runtime",
      status: "completed",
      progress: [
        { nodeId: "draft", status: "completed" },
        { nodeId: "verify", status: "completed" },
      ],
      finalReport: expect.stringContaining("# Workflow V2 Run Summary"),
    });
    expect(finished.progress!.some((item) => item.nodeId === "__final_review__")).toBe(false);
    expect(finished.progress?.find((item) => item.nodeId === "draft")?.messages).toEqual([
      expect.objectContaining({ role: "assistant", content: expect.stringContaining('"nodeId":"draft"') }),
    ]);
    const events = fixture.updates.flatMap((update) => update.appendEvents ?? []);
    expect(events.map((event) => `${event.nodeId}:${event.type}`)).toEqual([
      "draft:node_started",
      "draft:node_output",
      "draft:node_completed",
      "verify:node_started",
      "verify:node_output",
      "verify:node_completed",
    ]);
    expect(events.filter((event) => event.nodeId === "draft").map((event) => event.type)).toEqual([
      "node_started",
      "node_output",
      "node_completed",
    ]);
    expect(events.filter((event) => event.nodeId === "verify").map((event) => event.type)).toEqual([
      "node_started",
      "node_output",
      "node_completed",
    ]);
  });

  test("keeps one-shot message history when structured output parsing fails", async () => {
    const fixture = await workflowV2RuntimeFixture({
      taskFactory: (request) => ({
        id: "task-malformed-output",
        title: "Workflow V2 LLM node",
        status: "completed",
        prompt: request.prompt,
        configuredAgentId: request.configuredAgentId,
        messages: [{
          id: "assistant-malformed-output",
          role: "assistant",
          content: '{"nodeId":"draft","summary":',
          timestamp: 2,
          events: [
            { id: "tool-call", type: "tool_call", name: "read_file", content: '{"path":"README.md"}', timestamp: 3 },
            { id: "tool-result", type: "tool_result", name: "read_file", content: "README contents", timestamp: 4 },
          ],
        }],
        createdAt: 1,
        updatedAt: 4,
      } as TaskRun),
      executeScript: async () => ({ nodeId: "verify", summary: "not reached", outputs: { verified: false }, proposals: [] }),
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished.status).toBe("failed");
    expect(finished.progress?.find((item) => item.nodeId === "draft")?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: '{"nodeId":"draft","summary":',
      }),
      expect.objectContaining({
        role: "tool",
        eventType: "tool_call",
        name: "read_file",
        content: '{"path":"README.md"}',
      }),
      expect.objectContaining({
        role: "tool",
        eventType: "tool_result",
        name: "read_file",
        content: "README contents",
      }),
    ]);
  });

  test("fails the current script node and run when the injected sandbox policy rejects execution", async () => {
    const fixture = await workflowV2RuntimeFixture({
      executeScript: async () => {
        throw new Error("Workflow V2 workspace sandbox policy is unavailable on this platform.");
      },
    });

    fixture.runtime.runWorkflow({ workflowId: fixture.workflow.workflowId });
    const finished = await fixture.finished;

    expect(finished).toMatchObject({
      status: "failed",
      progress: [
        { nodeId: "draft", status: "completed" },
        {
          nodeId: "verify",
          status: "failed",
          detail: "Workflow V2 workspace sandbox policy is unavailable on this platform.",
        },
      ],
      lastError: "Workflow V2 workspace sandbox policy is unavailable on this platform.",
    });
    const events = fixture.updates.flatMap((update) => update.appendEvents ?? []);
    expect(events.filter((event) => event.nodeId === "verify").map((event) => event.type)).toEqual([
      "node_started",
      "node_failed",
    ]);
  });
});
