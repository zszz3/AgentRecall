import { describe, expect, test } from "vitest";
import { AgentHub } from "../agent-hub";
import type { WorkflowDraftState } from "../../../shared/types";
import { finishWorkflowRunState, startWorkflowRunState, updateWorkflowRunState } from "./agent-hub-workflow-run-state";

const workflowForRunState = (): WorkflowDraftState => ({
  workflowId: "workflow-run-state", sourceType: "user" as const, topologyLocked: false, title: "Workflow",
  status: "draft" as const, revision: 1, confirmedRevision: 1, configuredAgentId: "agent", modelId: "model", reviewerConfiguredAgentId: "agent", reviewerModelId: "model", objective: "Test",
  definition: { workflowId: "workflow-run-state", graphVersion: 1, objective: "Test", nodes: [], edges: [] },
  messages: [], reply: "", error: undefined, runProgress: [], runContextDocument: "", contextDocument: "", runIds: [],
  workflowV2Plan: { workflowId: "workflow-run-state", graphVersion: 1, objective: "Test", approvedBy: "test", frozenAt: 1, definition: { workflowId: "workflow-run-state", graphVersion: 1, objective: "Test", nodes: [], edges: [] }, nodes: [], acceptanceCriteria: [], roleDefaults: { orchestrator: { role: "orchestrator" as const, modelProfile: "expert" as const }, executor: { role: "executor" as const, modelProfile: "fast" as const }, reviewer: { role: "reviewer" as const, modelProfile: "expert" as const } }, budget: { context: { maxContextTokens: 1000, maxEvidenceItems: 10 } } },
  createdAt: 1, updatedAt: 1,
});

describe("workflow-v2 planner boundary", () => {
  test("keeps a waiting interactive run non-terminal with the same run id", () => {
    const workflow = workflowForRunState();
    const started = startWorkflowRunState({ workflow, request: { workflowId: workflow.workflowId }, runId: "run-1", cloneDraft: structuredClone, now: 2 });
    const waiting = updateWorkflowRunState({ workflow: started.nextWorkflow, run: started.nextRun, update: { workflowId: workflow.workflowId, runId: "run-1", status: "waiting_for_user" }, cloneDraft: structuredClone, now: 3 });
    expect(waiting.nextRun).toMatchObject({ runId: "run-1", status: "waiting_for_user", finishedAt: undefined });
    expect(waiting.nextWorkflow.status).toBe("waiting_for_user");
  });

  test("only terminal completion assigns finishedAt", () => {
    const workflow = workflowForRunState();
    const started = startWorkflowRunState({ workflow, request: { workflowId: workflow.workflowId }, runId: "run-1", cloneDraft: structuredClone, now: 2 });
    const finished = finishWorkflowRunState({ workflow: started.nextWorkflow, run: started.nextRun, request: { workflowId: workflow.workflowId, runId: "run-1", status: "completed" }, cloneDraft: structuredClone, now: 4 });
    expect(finished.nextRun.finishedAt).toBe(4);
  });
  test("builds a frozen workflow-v2 plan through the hub boundary", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });

    const result = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      contextBudget: { maxContextTokens: 3200, maxEvidenceItems: 7, maxUpstreamNodes: 3 },
      definition: {
        workflowId: "workflow-v2-hub",
        graphVersion: 2,
        objective: "Connect workflow v2 planning through the main hub boundary",
        nodes: [
          {
            id: "plan",
            kind: "planner",
            title: "Plan",
            execModel: "llm",
        executionMode: "one-shot",
            role: "orchestrator",
            prompt: "Build the frozen plan",
            outputFields: [{ key: "planDoc", required: true }],
          },
          {
            id: "execute",
            kind: "implementation",
            title: "Execute",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Implement the approved plan",
            outputFields: [{ key: "diff", required: true }],
          },
        ],
        edges: [{ fromNodeId: "plan", toNodeId: "execute" }],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        workflowId: "workflow-v2-hub",
        graphVersion: 2,
        approvedBy: "planner-agent",
        roleDefaults: {
          orchestrator: { role: "orchestrator", modelProfile: "expert" },
          executor: { role: "executor", modelProfile: "fast" },
          reviewer: { role: "reviewer", modelProfile: "expert" },
        },
        budget: {
          context: { maxContextTokens: 3200, maxEvidenceItems: 7, maxUpstreamNodes: 3 },
        },
      },
      validation: {
        valid: true,
        topologicalNodeIds: ["plan", "execute"],
      },
    });
    expect(
      result.plan?.nodes.map((node: { nodeId: string; role: string; modelProfile: string }) => ({
        nodeId: node.nodeId,
        role: node.role,
        modelProfile: node.modelProfile,
      })),
    ).toEqual([
      { nodeId: "plan", role: "orchestrator", modelProfile: "expert" },
      { nodeId: "execute", role: "executor", modelProfile: "fast" },
    ]);
  });

  test("returns structured validation failure when the workflow-v2 graph is not plannable", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });

    const result = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      definition: {
        workflowId: "workflow-v2-invalid",
        graphVersion: 1,
        objective: "Reject missing edge references before execution",
        nodes: [
          {
            id: "execute",
            kind: "implementation",
            title: "Execute",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Implement the approved plan",
            outputFields: [{ key: "diff", required: true }],
          },
        ],
        edges: [{ fromNodeId: "missing", toNodeId: "execute" }],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("references a missing node");
    expect(result.validation).toMatchObject({
      valid: false,
      errors: [expect.stringContaining("references a missing node")],
    });
  });

  test("returns a structured planner failure for invalid budget input without throwing", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });

    const result = await (hub as any).buildWorkflowV2Plan({
      approvedBy: "planner-agent",
      contextBudget: { maxContextTokens: 0 },
      definition: {
        workflowId: "workflow-v2-invalid-budget",
        graphVersion: 1,
        objective: "Reject invalid planner input at the hub boundary",
        nodes: [
          {
            id: "execute",
            kind: "implementation",
            title: "Execute",
            execModel: "llm",
        executionMode: "one-shot",
            prompt: "Implement the approved plan",
            outputFields: [{ key: "diff", required: true }],
          },
        ],
        edges: [],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Workflow V2 planner requires a valid context budget."),
      validation: { valid: true },
    });
  });

  test("builds an explicit workflow-v2 graph revision through the hub boundary", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });

    const result = await (hub as any).buildWorkflowV2GraphRevision({
      basedOnGraphVersion: 7,
      nextGraphVersion: 8,
      reason: "Human review widened the acceptance surface.",
      changesSummary: "Add a reviewer checkpoint before final completion.",
      approvedBy: "human-reviewer",
      now: 1720000000123,
    });

    expect(result).toEqual({
      ok: true,
      revision: {
        revisionId: "graph-revision-1720000000123",
        basedOnGraphVersion: 7,
        nextGraphVersion: 8,
        reason: "Human review widened the acceptance surface.",
        changesSummary: "Add a reviewer checkpoint before final completion.",
        approvedBy: "human-reviewer",
        createdAt: 1720000000123,
      },
    });
  });

  test.each([
    ["unsafe basedOnGraphVersion", { basedOnGraphVersion: Number.MAX_SAFE_INTEGER + 1 }, "basedOnGraphVersion"],
    ["unsafe nextGraphVersion", { nextGraphVersion: Number.MAX_SAFE_INTEGER + 1 }, "nextGraphVersion"],
    ["non-increasing nextGraphVersion", { nextGraphVersion: 7 }, "greater than basedOnGraphVersion"],
    ["non-string reason", { reason: 42 }, "reason"],
    ["blank changesSummary", { changesSummary: "   " }, "changesSummary"],
    ["non-string approvedBy", { approvedBy: null }, "approvedBy"],
    ["negative now", { now: -1 }, "now"],
    ["unsafe now", { now: Number.MAX_SAFE_INTEGER + 1 }, "now"],
  ])("returns a structured graph revision failure for %s", async (_name, override, expectedError) => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });

    const result = await (hub as any).buildWorkflowV2GraphRevision({
      basedOnGraphVersion: 7,
      nextGraphVersion: 8,
      reason: "Revise the graph.",
      changesSummary: "Add an execution node.",
      approvedBy: "human-reviewer",
      now: 1720000000100,
      ...override,
    });

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(expectedError) });
  });

  test("returns a structured graph revision failure for an unknown boundary error", async () => {
    const hub = new AgentHub({ codex: "missing-codex-for-test", claude: "missing-claude-for-test" });
    const request = {
      basedOnGraphVersion: 7,
      nextGraphVersion: 8,
      changesSummary: "Add an execution node.",
      approvedBy: "human-reviewer",
    };
    Object.defineProperty(request, "reason", {
      get() {
        throw "unexpected getter failure";
      },
    });

    await expect((hub as any).buildWorkflowV2GraphRevision(request)).resolves.toEqual({
      ok: false,
      error: "Workflow V2 graph revision build failed unexpectedly.",
    });
  });
});
