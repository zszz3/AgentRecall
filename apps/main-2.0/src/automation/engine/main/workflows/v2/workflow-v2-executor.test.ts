import { describe, expect, test } from "vitest";
import { createWorkflowV2InlineScriptSpec, type WorkflowV2Definition, type WorkflowV2LLMNode, type WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import type { WorkflowV2WorkerOutput } from "../../../shared/workflow-v2/packets";
import { createWorkflowV2RunState } from "../../../shared/workflow-v2/state";
import { buildWorkflowV2Plan } from "./workflow-v2-planner";
import { executeWorkflowV2Plan } from "./workflow-v2-executor";
import { WorkflowV2HookSignal } from "./workflow-v2-hooks";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";
import { transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";

function definition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-executor",
    graphVersion: 7,
    objective: "Execute the frozen plan through llm and script nodes",
    nodes: [
      {
        id: "draft",
        kind: "draft",
        title: "Draft implementation",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Produce a concise implementation draft",
        outputFields: [{ key: "draft", required: true }],
      },
      {
        id: "verify",
        kind: "verify",
        title: "Verify implementation",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "bash", code: "echo verify", timeoutMs: 5_000 }),
        outputFields: [{ key: "verification", required: true }],
      },
    ],
    edges: [{ fromNodeId: "draft", toNodeId: "verify" }],
  };
}

function independentDefinition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-parallel-executor",
    graphVersion: 1,
    objective: "Execute independent nodes with bounded parallelism",
    nodes: [
      {
        id: "first",
        kind: "worker",
        title: "First worker",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Run the first task",
        outputFields: [{ key: "value", required: true }],
      },
      {
        id: "second",
        kind: "worker",
        title: "Second worker",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Run the second task",
        outputFields: [{ key: "value", required: true }],
      },
    ],
    edges: [],
  };
}

function failingParallelDefinition(): WorkflowV2Definition {
  const workflow = independentDefinition();
  return {
    ...workflow,
    workflowId: "workflow-v2-failing-parallel-executor",
    nodes: [
      ...workflow.nodes,
      {
        id: "third",
        kind: "worker",
        title: "Third worker",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Run only after the second task",
        outputFields: [{ key: "value", required: true }],
      },
    ],
    edges: [{ fromNodeId: "second", toNodeId: "third" }],
  };
}

function fanInDefinition(): WorkflowV2Definition {
  return {
    workflowId: "workflow-v2-upstream-dataflow",
    graphVersion: 1,
    objective: "Pass direct upstream worker outputs to a downstream runner",
    nodes: [
      {
        id: "first",
        kind: "worker",
        title: "First worker",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Produce the first result",
        outputFields: [{ key: "value", required: true }],
      },
      {
        id: "second",
        kind: "worker",
        title: "Second worker",
        execModel: "llm",
        executionMode: "one-shot",
        prompt: "Produce the second result",
        outputFields: [{ key: "value", required: true }],
      },
      {
        id: "combine",
        kind: "worker",
        title: "Combine results",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "combine upstream results" }),
        outputFields: [{ key: "combined", required: true }],
      },
    ],
    edges: [
      { fromNodeId: "second", toNodeId: "combine" },
      { fromNodeId: "first", toNodeId: "combine" },
    ],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("workflow-v2 executor", () => {
  test("starts every independent node in a scheduler batch before the first node resolves", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: independentDefinition(),
      approvedBy: "tester",
      now: 500,
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const startedNodeIds: string[] = [];

    const execution = executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 2,
      runLlmNode: async ({ node }) => {
        startedNodeIds.push(node.id);
        if (node.id === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          nodeId: node.id,
          summary: `${node.title} completed`,
          outputs: { value: node.id },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    await firstStarted.promise;
    const startedBeforeFirstResolved = [...startedNodeIds];
    releaseFirst.resolve();
    const result = await execution;

    expect(startedBeforeFirstResolved).toEqual(["first", "second"]);
    expect(result.workerOutputs.map((output) => output.nodeId)).toEqual(["first", "second"]);
  });

  test("does not start a second independent node while the max-parallel slot is occupied", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: independentDefinition(),
      approvedBy: "tester",
      now: 750,
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const startedNodeIds: string[] = [];

    const execution = executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 1,
      runLlmNode: async ({ node }) => {
        startedNodeIds.push(node.id);
        if (node.id === "first") {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return {
          nodeId: node.id,
          summary: `${node.title} completed`,
          outputs: { value: node.id },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    await firstStarted.promise;
    const startedBeforeFirstResolved = [...startedNodeIds];
    releaseFirst.resolve();
    await execution;

    expect(startedBeforeFirstResolved).toEqual(["first"]);
    expect(startedNodeIds).toEqual(["first", "second", "workflow-summary"]);
  });

  test("requests cancellation for running siblings, settles the batch, and does not schedule another batch", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: failingParallelDefinition(),
      approvedBy: "tester",
      now: 900,
    });
    const releaseSecond = deferred();
    const startedNodeIds: string[] = [];
    const cancellations: Array<{ failedNodeId: string; runningNodeIds: string[]; reason: string }> = [];

    const execution = executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 2,
      runLlmNode: async ({ node }) => {
        startedNodeIds.push(node.id);
        if (node.id === "first") throw new Error("First worker failed");
        if (node.id === "second") await releaseSecond.promise;
        return {
          nodeId: node.id,
          summary: `${node.title} completed`,
          outputs: { value: node.id },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      cancelRunningNodes: async (input) => {
        cancellations.push(input);
        releaseSecond.resolve();
      },
    });

    await Promise.resolve();
    const startedBeforeSecondResolved = [...startedNodeIds];
    const result = await execution;

    expect(startedBeforeSecondResolved).toEqual(["first", "second"]);
    expect(cancellations).toEqual([{ failedNodeId: "first", runningNodeIds: ["second"], reason: "First worker failed" }]);
    expect(startedNodeIds).toEqual(["first", "second"]);
    expect(result.runState.status).toBe("failed");
    expect(result.runState.nodes.first?.status).toBe("failed");
    expect(result.runState.nodes.second?.status).toBe("completed");
    expect(result.runState.nodes.third?.status).toBe("ready");
    expect(result.workerOutputs.map((output) => output.nodeId)).toEqual(["second"]);
  });

  test("runs llm then script nodes in dependency order and returns worker outputs plus leader navigation", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_000,
    });
    const calls: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ taskPacket }) => {
        calls.push(`llm:${taskPacket.nodeId}`);
        return {
          nodeId: taskPacket.nodeId,
          summary: "Draft completed",
          outputs: { draft: "const ok = true;" },
          proposals: [{ kind: "continue", reason: "Draft is ready", targetNodeIds: ["verify"] }],
        };
      },
      executeScript: async ({ node, taskPacket }) => {
        calls.push(`script:${node.id}`);
        expect(taskPacket.nodeId).toBe("verify");
        return {
          nodeId: node.id,
          summary: "Verification completed",
          outputs: { verification: "passed" },
          proposals: [{ kind: "continue", reason: "Verification passed" }],
        };
      },
    });

    expect(calls).toEqual(["llm:draft", "script:verify"]);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.status).toBe("completed");
    expect(result.runState.nodes.verify?.status).toBe("completed");
    expect(result.workerOutputs.map((output) => output.nodeId)).toEqual(["draft", "verify"]);
    expect(result.leaderNavigation).toEqual(expect.objectContaining({
      nextNodeIds: [],
      priorityNodeIds: [],
      escalationHints: [],
      planHealth: "healthy",
    }));
  });

  test("notifies runtime transitions before a completed node unlocks its downstream runner", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_100,
    });
    const sequence: string[] = [];

    await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        sequence.push(`runner:${node.id}`);
        return {
          nodeId: node.id,
          summary: "Draft completed",
          outputs: { draft: "const ok = true;" },
          proposals: [],
        };
      },
      executeScript: async ({ node }) => {
        sequence.push(`runner:${node.id}`);
        return {
          nodeId: node.id,
          summary: "Verification completed",
          outputs: { verification: "passed" },
          proposals: [],
        };
      },
      onNodeStateTransition: ({ nodeId, status }: { nodeId: string; status: "running" | "completed" | "failed" }) => {
        sequence.push(`transition:${nodeId}:${status}`);
      },
    } as Parameters<typeof executeWorkflowV2Plan>[0] & {
      onNodeStateTransition: (input: { nodeId: string; status: "running" | "completed" | "failed" }) => void;
    });

    expect(sequence).toEqual([
      "transition:draft:running",
      "runner:draft",
      "transition:draft:completed",
      "transition:verify:running",
      "runner:verify",
      "transition:verify:completed",
    ]);
  });

  test("transition observer never sees more running nodes than the finite batch ceiling across multiple batches", async () => {
    const definitionWithSixNodes: WorkflowV2Definition = {
      workflowId: "workflow-v2-observed-parallelism",
      graphVersion: 1,
      objective: "Observe bounded execution across multiple scheduler batches",
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `node-${index + 1}`,
        kind: "worker",
        title: `Node ${index + 1}`,
        execModel: "llm" as const,
        executionMode: "one-shot" as const,
        prompt: `Run node ${index + 1}`,
        outputFields: [{ key: "value", required: true }],
      })),
      edges: [],
    };
    const plan = await buildWorkflowV2Plan({
      definition: definitionWithSixNodes,
      approvedBy: "tester",
      now: 1_150,
    });
    const runningNodeIds = new Set<string>();
    let maxObservedRunningNodes = 0;

    await executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 4,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: `${node.title} completed`,
        outputs: { value: node.id },
        proposals: [],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      onNodeStateTransition: ({ nodeId, status }: { nodeId: string; status: "running" | "completed" | "failed" }) => {
        if (status === "running") runningNodeIds.add(nodeId);
        else runningNodeIds.delete(nodeId);
        maxObservedRunningNodes = Math.max(maxObservedRunningNodes, runningNodeIds.size);
      },
    } as Parameters<typeof executeWorkflowV2Plan>[0] & {
      onNodeStateTransition: (input: { nodeId: string; status: "running" | "completed" | "failed" }) => void;
    });

    expect(maxObservedRunningNodes).toBe(4);
    expect(runningNodeIds.size).toBe(0);
  });

  test("passes cloned direct upstream worker outputs to the downstream runner in definition edge order", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: fanInDefinition(),
      approvedBy: "tester",
      now: 1_250,
    });
    const combineTaskPacketBeforeExecution = structuredClone(plan.nodes.find((node) => node.nodeId === "combine")!.taskPacket);
    const producedOutputs = new Map<string, WorkflowV2WorkerOutput>();

    const result = await executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 2,
      runLlmNode: async ({ node, upstreamOutputs }) => {
        expect(upstreamOutputs).toEqual([]);
        const output = {
          nodeId: node.id,
          summary: `${node.title} completed`,
          outputs: { value: { source: node.id } },
          evidence: [`evidence:${node.id}`],
          risks: [`risk:${node.id}`],
          proposals: [],
        };
        producedOutputs.set(node.id, output);
        return output;
      },
      executeScript: async ({ node, taskPacket, upstreamOutputs }) => {
        expect(taskPacket).toEqual(combineTaskPacketBeforeExecution);
        expect(upstreamOutputs).toEqual([
          {
            nodeId: "second",
            summary: "Second worker completed",
            outputs: { value: { source: "second" } },
            evidence: ["evidence:second"],
            risks: ["risk:second"],
          },
          {
            nodeId: "first",
            summary: "First worker completed",
            outputs: { value: { source: "first" } },
            evidence: ["evidence:first"],
            risks: ["risk:first"],
          },
        ]);
        expect(upstreamOutputs[0]).not.toBe(producedOutputs.get("second"));
        expect(upstreamOutputs[0]?.outputs).not.toBe(producedOutputs.get("second")?.outputs);
        expect(upstreamOutputs[0]?.evidence).not.toBe(producedOutputs.get("second")?.evidence);
        expect(upstreamOutputs[0]?.risks).not.toBe(producedOutputs.get("second")?.risks);
        expect(upstreamOutputs[1]).not.toBe(producedOutputs.get("first"));

        return {
          nodeId: node.id,
          summary: "Combined upstream results",
          outputs: { combined: true },
          proposals: [],
        };
      },
    });

    expect(result.runState.status).toBe("completed");
    expect(plan.nodes.find((node) => node.nodeId === "combine")?.taskPacket).toEqual(combineTaskPacketBeforeExecution);
  });

  test.each([
    [1, ["second"]],
    [0, []],
  ] as const)("limits direct upstream packets to maxUpstreamNodes=%s without changing dependency execution", async (maxUpstreamNodes, expectedNodeIds) => {
    const plan = await buildWorkflowV2Plan({
      definition: fanInDefinition(),
      approvedBy: "tester",
      now: 1_255,
    });
    plan.nodes.find((node) => node.nodeId === "combine")!.taskPacket.budget.context.maxUpstreamNodes = maxUpstreamNodes;
    const executedUpstreamNodeIds: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 2,
      runLlmNode: async ({ node }) => {
        executedUpstreamNodeIds.push(node.id);
        return {
          nodeId: node.id,
          summary: `${node.title} completed`,
          outputs: { value: node.id },
          proposals: [],
        };
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        expect(upstreamOutputs.map((output) => output.nodeId)).toEqual(expectedNodeIds);
        return {
          nodeId: node.id,
          summary: "Combined one budgeted upstream packet",
          outputs: { combined: true },
          proposals: [],
        };
      },
    });

    expect(executedUpstreamNodeIds).toEqual(["first", "second"]);
    expect(result.runState.status).toBe("completed");
  });

  test("rejects an invalid direct-call plan budget instead of silently clamping it", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: fanInDefinition(),
      approvedBy: "tester",
      now: 1_258,
    });
    plan.nodes.find((node) => node.nodeId === "combine")!.taskPacket.budget.context.maxUpstreamNodes = -1;
    let runnerCalls = 0;

    await expect(executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        runnerCalls += 1;
        return {
          nodeId: node.id,
          summary: "unexpected",
          outputs: { value: node.id },
          proposals: [],
        };
      },
      executeScript: async ({ node }) => {
        runnerCalls += 1;
        return {
          nodeId: node.id,
          summary: "unexpected",
          outputs: { combined: true },
          proposals: [],
        };
      },
    })).rejects.toThrow("Workflow V2 executor received an invalid context budget");
    expect(runnerCalls).toBe(0);
  });

  test.each([
    [1, [["second", ["second-evidence-1"]], ["first", undefined]]],
    [0, [["second", undefined], ["first", undefined]]],
  ] as const)("limits evidence across all direct upstream packets to %s items", async (maxEvidenceItems, expectedEvidence) => {
    const plan = await buildWorkflowV2Plan({
      definition: fanInDefinition(),
      approvedBy: "tester",
      now: 1_260 + maxEvidenceItems,
    });
    plan.nodes.find((node) => node.nodeId === "combine")!.taskPacket.budget.context.maxEvidenceItems = maxEvidenceItems;

    const result = await executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 2,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: `${node.title} completed`,
        outputs: { value: node.id },
        evidence: [`${node.id}-evidence-1`, `${node.id}-evidence-2`],
        risks: [`${node.id}-risk`],
        proposals: [],
      }),
      executeScript: async ({ node, upstreamOutputs }) => {
        expect(upstreamOutputs.map((output) => [output.nodeId, output.evidence])).toEqual(expectedEvidence);
        expect(upstreamOutputs.map((output) => output.outputs)).toEqual([
          { value: "second" },
          { value: "first" },
        ]);
        expect(upstreamOutputs.map((output) => output.risks)).toEqual([
          ["second-risk"],
          ["first-risk"],
        ]);
        return {
          nodeId: node.id,
          summary: "Combined budgeted evidence",
          outputs: { combined: true },
          proposals: [],
        };
      },
    });

    expect(result.runState.status).toBe("completed");
  });

  test("keeps upstream control proposals out of downstream runner data", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_275,
    });
    const controlProposals: WorkflowV2WorkerOutput["proposals"] = [
      { kind: "retry", reason: "retry-control-only", targetNodeId: "draft" },
      { kind: "graph-revision", reason: "graph-revision-control-only" },
      { kind: "escalate", reason: "escalate-control-only" },
    ];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "Draft completed",
        outputs: { draft: "const ok = true;" },
        evidence: ["draft evidence"],
        risks: ["draft risk"],
        nextStepSuggestions: ["verify the draft"],
        proposals: controlProposals,
      }),
      executeScript: async ({ node, upstreamOutputs }) => {
        expect(upstreamOutputs).toEqual([{
          nodeId: "draft",
          summary: "Draft completed",
          outputs: { draft: "const ok = true;" },
          evidence: ["draft evidence"],
          risks: ["draft risk"],
          nextStepSuggestions: ["verify the draft"],
        }]);
        expect(Object.hasOwn(upstreamOutputs[0]!, "proposals")).toBe(false);
        expect(JSON.stringify(upstreamOutputs)).not.toContain("control-only");
        return {
          nodeId: node.id,
          summary: "Verification completed",
          outputs: { verification: "passed" },
          proposals: [],
        };
      },
    });

    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs[0]?.proposals).toEqual(controlProposals);
  });

  test("isolates authoritative worker outputs and downstream data from custom predicate mutation", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_300,
    });
    const runnerOutput: WorkflowV2WorkerOutput = {
      nodeId: "draft",
      summary: "Original draft",
      outputs: { draft: { text: "original" } },
      evidence: ["original evidence"],
      risks: ["original risk"],
      proposals: [{ kind: "continue", reason: "Original proposal", targetNodeIds: ["verify"] }],
    };
    const expectedRunnerOutput = structuredClone(runnerOutput);
    const expectedUpstreamResult = {
      nodeId: expectedRunnerOutput.nodeId,
      summary: expectedRunnerOutput.summary,
      outputs: expectedRunnerOutput.outputs,
      evidence: expectedRunnerOutput.evidence,
      risks: expectedRunnerOutput.risks,
    };

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => runnerOutput,
      executeScript: async ({ node, upstreamOutputs }) => {
        expect(upstreamOutputs).toEqual([expectedUpstreamResult]);
        expect(upstreamOutputs[0]).not.toBe(runnerOutput);
        return {
          nodeId: node.id,
          summary: "Verification completed",
          outputs: { verification: "passed" },
          proposals: [],
        };
      },
      isNodeOutputSuccessful: ({ output }) => {
        output.nodeId = "tampered-node";
        output.outputs = { tampered: true };
        output.evidence = ["tampered evidence"];
        output.risks = ["tampered risk"];
        output.proposals = [{ kind: "escalate", reason: "Tampered proposal" }];
        return true;
      },
    });

    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs[0]).toEqual(expectedRunnerOutput);
    expect(result.workerOutputs[0]?.nodeId).toBe("draft");
    expect(runnerOutput).toEqual(expectedRunnerOutput);
  });

  test("attributes an uncloneable worker packet to its producer without starting downstream nodes", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_400,
    });
    let scriptCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => ({
        nodeId: "draft",
        summary: "Uncloneable draft",
        outputs: { draft: () => "not cloneable" },
        proposals: [],
      }),
      executeScript: async ({ node }) => {
        scriptCalls += 1;
        return {
          nodeId: node.id,
          summary: "Verification completed",
          outputs: { verification: "passed" },
          proposals: [],
        };
      },
    });

    expect(result.runState.status).toBe("failed");
    expect(result.runState.nodes.draft?.status).toBe("failed");
    expect(result.runState.nodes.draft?.lastError).toMatch(/could not be cloned/i);
    expect(result.runState.nodes.verify?.status).toBe("blocked");
    expect(scriptCalls).toBe(0);
    expect(result.workerOutputs).toEqual([]);
  });

  test("normalizes zero max parallel nodes without treating it as omitted", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 1_500,
    });

    const result = await executeWorkflowV2Plan({
      plan,
      maxParallelNodes: 0,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "Draft completed",
        outputs: {},
        proposals: [],
      }),
      executeScript: async ({ node }) => ({
        nodeId: node.id,
        summary: "Verification completed",
        outputs: {},
        proposals: [],
      }),
      isNodeOutputSuccessful: () => true,
    });

    expect(result.runState.maxParallelNodes).toBe(1);
  });

  test("marks the run failed when a node fails and leaves downstream nodes blocked", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 2_000,
    });

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ taskPacket }) => ({
        nodeId: taskPacket.nodeId,
        summary: "Draft failed",
        outputs: {},
        proposals: [{ kind: "escalate", reason: "Need help fixing the draft." }],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      isNodeOutputSuccessful: () => false,
    });

    expect(result.runState.status).toBe("failed");
    expect(result.runState.nodes.draft?.status).toBe("failed");
    expect(result.runState.nodes.draft?.lastError).toBe("Missing required output fields: draft.");
    expect(result.runState.nodes.verify?.status).toBe("blocked");
    expect(result.workerOutputs).toHaveLength(0);
    expect(result.leaderNavigation).toEqual(expect.objectContaining({
      nextNodeIds: [],
      priorityNodeIds: [],
      escalationHints: [],
      planHealth: "blocked",
    }));
  });

  test("retries a known script failure only under an explicit bounded retry policy", async () => {
    const retryDefinition = definition();
    retryDefinition.nodes = [
      {
        id: "script",
        kind: "verify",
        title: "Retryable script",
        execModel: "script",
        executionMode: "script",
        script: createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { verification: true };" }),
        outputFields: [{ key: "verification", required: true }],
        onError: "retry",
        maxRetry: 1,
      },
    ];
    retryDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: retryDefinition, approvedBy: "tester", now: 2_100 });
    let attempts = 0;
    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => { throw new Error("llm runner should not be called"); },
      executeScript: async ({ node }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient script failure");
        return { nodeId: node.id, summary: "script recovered", outputs: { verification: true }, proposals: [] };
      },
    });

    expect(attempts).toBe(2);
    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs[0]?.summary).toBe("script recovered");
  });

  test("never automatically retries a non-idempotent script even when onError requests retry", async () => {
    const retryDefinition = definition();
    const script = createWorkflowV2InlineScriptSpec({ language: "typescript", code: "return { verification: true };" });
    script.idempotency = "non_idempotent";
    retryDefinition.nodes = [{ id: "script", kind: "verify", title: "Non-idempotent script", execModel: "script", executionMode: "script", script, outputFields: [{ key: "verification", required: true }], onError: "retry", maxRetry: 3 }];
    retryDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: retryDefinition, approvedBy: "tester", now: 2_200 });
    let attempts = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => { throw new Error("llm runner should not be called"); },
      executeScript: async () => { attempts += 1; throw new Error("remote effect may have completed"); },
    });

    expect(attempts).toBe(1);
    expect(result.runState.status).toBe("paused");
    expect(result.runState.nodes.script).toMatchObject({ status: "paused", intervention: { reason: expect.stringContaining("Automatic retry is disabled") } });
  });

  test("fails fast when the frozen plan cannot make progress", async () => {
    const validPlan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 3_000,
    });
    const deadlockedPlan = {
      ...validPlan,
      definition: {
        ...validPlan.definition,
        edges: [
          { fromNodeId: "draft", toNodeId: "verify" },
          { fromNodeId: "verify", toNodeId: "draft" },
        ],
      },
    };

    const result = await executeWorkflowV2Plan({
      plan: deadlockedPlan,
      runLlmNode: async () => {
        throw new Error("llm runner should not be called");
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    expect(result.runState.status).toBe("failed");
    expect(result.runState.nodes.draft?.lastError).toBe("Workflow V2 executor could not make progress on the frozen plan.");
    expect(result.leaderNavigation).toEqual(expect.objectContaining({
      nextNodeIds: [],
      priorityNodeIds: [],
      escalationHints: [],
      planHealth: "blocked",
    }));
  });

  test("fails when a runner returns an output packet for the wrong node", async () => {
    const plan = await buildWorkflowV2Plan({
      definition: definition(),
      approvedBy: "tester",
      now: 4_000,
    });
    let outputPredicateCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => ({
        nodeId: "verify",
        summary: "Wrongly attributed output",
        outputs: { draft: "const ok = true;" },
        proposals: [{ kind: "escalate", reason: "Wrong-node output must be ignored." }],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      isNodeOutputSuccessful: () => {
        outputPredicateCalls += 1;
        return true;
      },
    });

    expect(result.runState.status).toBe("failed");
    expect(result.runState.nodes.draft?.lastError).toBe("Output packet belongs to verify, not draft.");
    expect(result.runState.nodes.verify?.status).toBe("blocked");
    expect(result.workerOutputs).toEqual([]);
    expect(result.leaderNavigation.escalationHints).toEqual([]);
    expect(outputPredicateCalls).toBe(0);
  });

  test("retries mechanical validation before accepting the authoritative output", async () => {
    const retryDefinition = definition();
    const draftNode = retryDefinition.nodes[0] as WorkflowV2LLMNode;
    retryDefinition.nodes = [{
      ...draftNode,
      maxRetry: 1,
    }];
    retryDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: retryDefinition, approvedBy: "tester", now: 5_000 });
    let attempts = 0;
    const acceptedSummaries: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        attempts += 1;
        return {
          nodeId: node.id,
          summary: `attempt ${attempts}`,
          outputs: attempts === 1 ? {} : { draft: "accepted" },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      onNodeAccepted: async ({ output }) => { acceptedSummaries.push(output.summary); },
    });

    expect(attempts).toBe(2);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.attempt).toBe(2);
    expect(result.workerOutputs).toEqual([{
      nodeId: "draft",
      summary: "attempt 2",
      outputs: { draft: "accepted" },
      proposals: [],
    }]);
    expect(acceptedSummaries).toEqual(["attempt 2"]);
  });

  test("pauses through one intervention contract when validation requires a human", async () => {
    const pausedDefinition = definition();
    const draftNode = pausedDefinition.nodes[0] as WorkflowV2LLMNode;
    pausedDefinition.nodes = [{
      ...draftNode,
      maxRetry: 0,
      onExhausted: "ask_human",
    }];
    pausedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: pausedDefinition, approvedBy: "tester", now: 5_100 });

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "incomplete",
        outputs: {},
        proposals: [],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    expect(result.runState.status).toBe("paused");
    expect(result.runState.nodes.draft?.status).toBe("paused");
    expect(result.runState.nodes.draft?.intervention).toMatchObject({
      nodeId: "draft",
      source: "validation",
      allowedActions: ["continue", "skip", "escalate", "replan", "increase_review_strength"],
    });
    expect(result.workerOutputs).toEqual([]);
  });

  test("does not offer llm-only intervention actions when script validation requires a human", async () => {
    const pausedDefinition = definition();
    const scriptNode = pausedDefinition.nodes[1] as WorkflowV2ScriptNode;
    pausedDefinition.nodes = [{
      ...scriptNode,
      onError: "ask_human",
    }];
    pausedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: pausedDefinition, approvedBy: "tester", now: 5_150 });

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => {
        throw new Error("llm runner should not be called");
      },
      executeScript: async ({ node }) => ({
        nodeId: node.id,
        summary: "incomplete",
        outputs: {},
        proposals: [],
      }),
    });

    expect(result.runState.status).toBe("paused");
    expect(result.runState.nodes.verify?.intervention).toMatchObject({
      nodeId: "verify",
      source: "validation",
      allowedActions: ["continue", "skip", "replan"],
    });
  });

  test("requires an independent structured reviewer for semantic judge dimensions", async () => {
    const reviewedDefinition = definition();
    reviewedDefinition.reviewEnabled = true;
    const draftNode = reviewedDefinition.nodes[0] as WorkflowV2LLMNode;
    reviewedDefinition.nodes = [{
      ...draftNode,
      reviewLevel: "high",
      judgeDimensions: [{ key: "quality", description: "The draft must be complete and correct." }],
    }];
    reviewedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_200 });
    const reviewerInputs: string[] = [];
    const acceptanceOrder: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "ready for review",
        outputs: { draft: "review me" },
        proposals: [{ kind: "continue", reason: "executor self-assessment" }],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      reviewNodeOutput: async (reviewInput) => {
        acceptanceOrder.push("review");
        reviewerInputs.push(JSON.stringify(reviewInput));
        return {
          reviewerNodeId: "independent-reviewer",
          verdict: {
            decision: "accept",
            reasons: ["Quality evidence is sufficient."],
            riskLevel: "low",
            confidence: "high",
            qualityLevel: "high",
            dimensionResults: [{ key: "quality", qualityLevel: "high", reason: "Complete and correct.", evidence: ["Reviewed candidate"] }],
          },
          trace: [
            { id: "review-request", kind: "request", at: 5_201, content: "Review the candidate" },
            { id: "review-response", kind: "response", at: 5_202, content: "Accepted" },
          ],
        };
      },
      onNodeAccepted: async () => { acceptanceOrder.push("materialize"); },
    });

    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.reviewVerdict?.decision).toBe("accept");
    expect(reviewerInputs).toHaveLength(1);
    expect(reviewerInputs[0]).not.toContain("executor self-assessment");
    expect(result.runState.nodes.draft?.reviewHistory?.[0]?.candidate.proposals).toEqual([
      { kind: "continue", reason: "executor self-assessment" },
    ]);
    expect(result.runState.nodes.draft?.reviewHistory?.[0]?.trace?.map((entry) => entry.kind)).toEqual(["request", "response"]);
    expect(acceptanceOrder).toEqual(["review", "materialize"]);
  });

  test("requeues a reviewer rejection and accepts a later corrected attempt", async () => {
    const reviewedDefinition = definition();
    reviewedDefinition.reviewEnabled = true;
    const draftNode = reviewedDefinition.nodes[0] as WorkflowV2LLMNode;
    reviewedDefinition.nodes = [{
      ...draftNode,
      reviewLevel: "medium",
      reviewMaxRetries: 1,
      judgeDimensions: [{ key: "quality", description: "The draft must be complete and correct." }],
    }];
    reviewedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_300 });
    let runnerAttempts = 0;
    let reviewAttempts = 0;
    const rejectedAttempts: Array<{ attempt: number; summary: string }> = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        runnerAttempts += 1;
        return {
          nodeId: node.id,
          summary: `draft ${runnerAttempts}`,
          outputs: { draft: `revision ${runnerAttempts}` },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      reviewNodeOutput: async () => {
        reviewAttempts += 1;
        return {
          reviewerNodeId: "independent-reviewer",
          verdict: {
            decision: reviewAttempts === 1 ? "reject" : "accept",
            reasons: [reviewAttempts === 1 ? "Needs correction." : "Corrected."],
            requiredFixes: reviewAttempts === 1 ? ["Correct the draft."] : [],
            riskLevel: "medium",
            confidence: "high",
            qualityLevel: reviewAttempts === 1 ? "low" : "medium",
            dimensionResults: [{ key: "quality", qualityLevel: reviewAttempts === 1 ? "low" : "medium", reason: reviewAttempts === 1 ? "Incomplete." : "Corrected.", evidence: ["Reviewed candidate"] }],
          },
        };
      },
      onReviewRetry: async ({ attempt, output }) => {
        rejectedAttempts.push({ attempt, summary: output.summary });
      },
    });

    expect(runnerAttempts).toBe(2);
    expect(reviewAttempts).toBe(2);
    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs[0]?.outputs).toEqual({ draft: "revision 2" });
    expect(result.runState.nodes.draft?.reviewHistory).toHaveLength(2);
    expect(result.runState.nodes.draft?.reviewAttempt).toBe(2);
    expect(rejectedAttempts).toEqual([{ attempt: 1, summary: "draft 1" }]);
  });

  test("pauses an exhausted quality review with only full-rerun and last-result actions", async () => {
    const reviewedDefinition = definition();
    reviewedDefinition.reviewEnabled = true;
    const draftNode = reviewedDefinition.nodes[0] as WorkflowV2LLMNode;
    reviewedDefinition.nodes = [{
      ...draftNode,
      reviewLevel: "high",
      reviewMaxRetries: 0,
      judgeDimensions: [{ key: "quality", description: "The draft must be complete and correct." }],
    }];
    reviewedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_350 });
    let reviewCalls = 0;
    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "Candidate",
        outputs: { draft: "incomplete" },
        proposals: [{ kind: "retry", reason: "executor requested retry" }],
      }),
      executeScript: async () => { throw new Error("script runner should not be called"); },
      reviewNodeOutput: async () => {
        reviewCalls += 1;
        return {
          reviewerNodeId: "out-of-graph-reviewer",
          verdict: {
            decision: "reject",
            reasons: ["Incomplete."],
            requiredFixes: ["Complete the draft."],
            riskLevel: "medium",
            confidence: "high",
            qualityLevel: "medium",
            dimensionResults: [{ key: "quality", qualityLevel: "medium", reason: "Incomplete.", evidence: ["candidate"] }],
          },
        };
      },
    });
    expect(reviewCalls).toBe(1);
    expect(result.runState.nodes.draft).toMatchObject({
      status: "paused",
      reviewAttempt: 1,
      intervention: { source: "review_rejection", allowedActions: ["rerun_all", "accept_last_result"] },
    });
    expect(result.runState.nodes.draft?.reviewHistory).toHaveLength(1);
    expect(result.runState.nodes.draft?.intervention?.lastCandidate?.proposals).toEqual([
      { kind: "retry", reason: "executor requested retry" },
    ]);
  });

  test("does not call the Reviewer while Workflow Review is disabled", async () => {
    const reviewedDefinition = definition();
    const draftNode = reviewedDefinition.nodes[0] as WorkflowV2LLMNode;
    reviewedDefinition.nodes = [{ ...draftNode, reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "The draft must be correct." }] }];
    reviewedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_375 });
    let reviewCalls = 0;
    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({ nodeId: node.id, summary: "Candidate", outputs: { draft: "accepted without Review" }, proposals: [] }),
      executeScript: async () => { throw new Error("script runner should not be called"); },
      reviewNodeOutput: async () => { reviewCalls += 1; throw new Error("Reviewer should not run"); },
    });
    expect(reviewCalls).toBe(0);
    expect(result.runState.status).toBe("completed");
  });

  test("does not nest an independent review around a reviewer node", async () => {
    const reviewedDefinition = definition();
    reviewedDefinition.reviewEnabled = true;
    reviewedDefinition.nodes = [{
      ...reviewedDefinition.nodes[0]!,
      role: "reviewer",
      reviewLevel: "high",
      judgeDimensions: [{ key: "quality", description: "The review result must be evidence-based." }],
    }];
    reviewedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_380 });
    let reviewCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      forceIndependentReviewNodeIds: new Set(["draft"]),
      runLlmNode: async ({ node }) => ({ nodeId: node.id, summary: "Review complete", outputs: { draft: "findings" }, proposals: [] }),
      executeScript: async () => { throw new Error("script runner should not be called"); },
      reviewNodeOutput: async () => { reviewCalls += 1; throw new Error("reviewer nodes must not trigger nested review"); },
    });

    expect(reviewCalls).toBe(0);
    expect(result.runState.status).toBe("completed");
  });

  test("never reviews script nodes even when a legacy plan contains Review fields", async () => {
    const reviewedDefinition = definition();
    reviewedDefinition.reviewEnabled = true;
    const plan = await buildWorkflowV2Plan({ definition: reviewedDefinition, approvedBy: "tester", now: 5_390 });
    plan.definition.nodes[1] = {
      ...plan.definition.nodes[1]!,
      reviewLevel: "high",
      reviewMaxRetries: 0,
      judgeDimensions: [{ key: "quality", description: "The verification must be supported by runtime evidence." }],
    };
    let reviewCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({ nodeId: node.id, summary: "Draft", outputs: { draft: "content" }, evidence: ["source-1"], proposals: [] }),
      executeScript: async ({ node }) => ({
        nodeId: node.id,
        summary: "Verified",
        outputs: { verification: true },
        proposals: [],
        acceptance: { outcome: "clean", issues: [], changedPaths: ["result.md"], operationIds: ["operation-1"] },
        scriptReceipt: { exitCode: 0, signal: null, timedOut: false, stderrSummary: "", stdoutDigest: "stdout", operationDigest: "operation", effectState: "workspace_changed" },
      }),
      reviewNodeOutput: async () => { reviewCalls += 1; throw new Error("Script nodes must not be reviewed"); },
    });

    expect(reviewCalls).toBe(0);
    expect(result.workerOutputs.find((output) => output.nodeId === "verify")).toMatchObject({
      acceptance: { outcome: "clean" },
      scriptReceipt: { exitCode: 0 },
    });
  });

  test("projects a supervisor pause through the unified intervention contract", async () => {
    const supervisedDefinition = definition();
    supervisedDefinition.nodes = [supervisedDefinition.nodes[0]!];
    supervisedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: supervisedDefinition, approvedBy: "tester", now: 5_400 });
    const report = {
      nodeId: "draft",
      attempt: 1,
      phase: "blocked",
      completedItems: ["captured partial output"],
      remainingItems: ["finish draft"],
      blockers: ["needs user input"],
      evidence: ["partial output exists"],
      checkpoint: "checkpoint-1",
      safeToInterrupt: true,
      requestedAction: "need_input" as const,
      reportedAt: 5_500,
    };

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => {
        throw new WorkflowV2SupervisionSignal({
          report,
          resumeConversation: {
            runtimeId: "codex",
            codecVersion: "1",
            payload: { native: { threadId: "paused-thread" } },
          },
          resolution: {
            action: "pause",
            question: "Provide the missing input?",
            reason: "The overdue task requested user input.",
          },
        });
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    expect(result.runState.status).toBe("paused");
    expect(result.runState.nodes.draft?.intervention).toMatchObject({
      source: "supervision_pause",
      reason: "The overdue task requested user input.",
      progressReport: report,
      supervisorDecision: { action: "pause", question: "Provide the missing input?" },
      resumeConversation: {
        runtimeId: "codex",
        codecVersion: "1",
        payload: { native: { threadId: "paused-thread" } },
      },
    });
  });

  test("requeues an explicit supervisor retry within the node retry budget", async () => {
    const supervisedDefinition = definition();
    const draftNode = supervisedDefinition.nodes[0] as WorkflowV2LLMNode;
    supervisedDefinition.nodes = [{ ...draftNode, maxRetry: 1 }];
    supervisedDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: supervisedDefinition, approvedBy: "tester", now: 5_600 });
    let attempts = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        attempts += 1;
        if (attempts === 1) {
          throw new WorkflowV2SupervisionSignal({
            report: {
              nodeId: "draft",
              attempt: 1,
              phase: "stalled",
              completedItems: [],
              remainingItems: ["draft"],
              blockers: ["attempt stalled"],
              evidence: [],
              checkpoint: "checkpoint-1",
              safeToInterrupt: true,
              requestedAction: "continue",
              reportedAt: 5_700,
            },
            resolution: {
              action: "retry",
              fromCheckpoint: "checkpoint-1",
              reason: "Restart from the checkpoint.",
            },
          });
        }
        return {
          nodeId: node.id,
          summary: "Recovered on retry",
          outputs: { draft: "recovered" },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
    });

    expect(attempts).toBe(2);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.attempt).toBe(2);
  });

  test("awaits durable checkpoints at initial, running, and settled boundaries", async () => {
    const checkpointDefinition = definition();
    checkpointDefinition.nodes = [checkpointDefinition.nodes[0]!];
    checkpointDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: checkpointDefinition, approvedBy: "tester", now: 5_800 });
    const checkpoints: Array<{ status: string; outputs: string[] }> = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "done",
        outputs: { draft: "persisted" },
        proposals: [],
      }),
      executeScript: async () => {
        throw new Error("script runner should not be called");
      },
      onRunCheckpoint: async ({ runState, workerOutputs }) => {
        checkpoints.push({
          status: runState.nodes.draft!.status,
          outputs: workerOutputs.map((output) => output.nodeId),
        });
      },
    });

    expect(result.runState.status).toBe("completed");
    expect(checkpoints).toEqual([
      { status: "ready", outputs: [] },
      { status: "running", outputs: [] },
      { status: "completed", outputs: ["draft"] },
    ]);
  });

  test("resumes from a validated checkpoint without rerunning completed nodes", async () => {
    const plan = await buildWorkflowV2Plan({ definition: definition(), approvedBy: "tester", now: 5_900 });
    let runState = createWorkflowV2RunState({ definition: plan.definition });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "running", now: 6_000 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "completed", now: 6_100 });
    const calls: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      initialCheckpoint: {
        runState,
        workerOutputs: [{
          nodeId: "draft",
          summary: "Recovered draft",
          outputs: { draft: "const recovered = true;" },
          proposals: [],
        }],
      },
      runLlmNode: async () => {
        calls.push("llm");
        throw new Error("completed llm node must not rerun");
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        calls.push("script");
        expect(upstreamOutputs[0]?.summary).toBe("Recovered draft");
        return {
          nodeId: node.id,
          summary: "Verified recovered draft",
          outputs: { verification: true },
          proposals: [],
        };
      },
    });

    expect(calls).toEqual(["script"]);
    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs.map((output) => output.nodeId)).toEqual(["draft", "verify"]);
  });

  test("resumes downstream work from a result accepted with human override", async () => {
    const plan = await buildWorkflowV2Plan({ definition: definition(), approvedBy: "tester", now: 6_150 });
    let runState = createWorkflowV2RunState({ definition: plan.definition });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "running", now: 6_160 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "completed_with_override", now: 6_170 });
    const calls: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      initialCheckpoint: {
        runState,
        workerOutputs: [{
          nodeId: "draft",
          summary: "Candidate accepted by a human",
          outputs: { draft: "const accepted = true;" },
          proposals: [],
        }],
      },
      runLlmNode: async () => {
        calls.push("llm");
        throw new Error("overridden llm node must not rerun");
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        calls.push("script");
        expect(upstreamOutputs[0]?.summary).toBe("Candidate accepted by a human");
        return {
          nodeId: node.id,
          summary: "Verified overridden candidate",
          outputs: { verification: true },
          proposals: [],
        };
      },
    });

    expect(calls).toEqual(["script"]);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.status).toBe("completed_with_override");
  });

  test("resumes the persisted Review Gate candidate without rerunning its executor", async () => {
    const reviewDefinition = definition();
    reviewDefinition.nodes = [reviewDefinition.nodes[0]!];
    reviewDefinition.edges = [];
    reviewDefinition.reviewGates = [{ id: "review-draft", targetNodeId: "draft", configuredAgentId: "review-agent", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Must be correct." }], maxQualityRetries: 2 }];
    const plan = await buildWorkflowV2Plan({ definition: reviewDefinition, approvedBy: "tester", now: 6_200 });
    let runState = createWorkflowV2RunState({ definition: plan.definition });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "running", now: 6_210 });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "awaiting_review", now: 6_220, reviewInfrastructureAttempt: 2 });
    const infrastructureAttempts: number[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      initialCheckpoint: { runState, workerOutputs: [{ nodeId: "draft", summary: "Persisted candidate", outputs: { draft: "ready" }, proposals: [] }] },
      runLlmNode: async () => { throw new Error("executor must not rerun while resuming Review Gate"); },
      executeScript: async () => { throw new Error("script should not run"); },
      reviewNodeOutput: async (input, context) => {
        expect(input.result.summary).toBe("Persisted candidate");
        expect(context?.initialInfrastructureAttempt).toBe(2);
        await context?.onInfrastructureAttempt(3);
        infrastructureAttempts.push(3);
        return { reviewerNodeId: "review-agent", verdict: { decision: "accept", reasons: ["通过"], riskLevel: "low", confidence: "high", qualityLevel: "high", dimensionResults: [{ key: "quality", qualityLevel: "high", reason: "正确", evidence: ["candidate"] }] } };
      },
    });

    expect(infrastructureAttempts).toEqual([3]);
    expect(result.runState.status).toBe("completed");
    expect(result.workerOutputs).toEqual([expect.objectContaining({ nodeId: "draft", summary: "Persisted candidate" })]);
  });

  test("replays a durably recorded Review Gate verdict without reviewing the candidate twice", async () => {
    const reviewDefinition = definition();
    reviewDefinition.nodes = [reviewDefinition.nodes[0]!];
    reviewDefinition.edges = [];
    reviewDefinition.reviewGates = [{ id: "review-draft", targetNodeId: "draft", configuredAgentId: "review-agent", reviewLevel: "high", judgeDimensions: [{ key: "quality", description: "Must be correct." }], maxQualityRetries: 2 }];
    const plan = await buildWorkflowV2Plan({ definition: reviewDefinition, approvedBy: "tester", now: 6_250 });
    const candidate = { nodeId: "draft", summary: "Persisted accepted candidate", outputs: { draft: "ready" }, proposals: [] };
    let runState = createWorkflowV2RunState({ definition: plan.definition });
    runState = transitionWorkflowV2NodeState(runState, { nodeId: "draft", status: "running", now: 6_251 });
    runState = transitionWorkflowV2NodeState(runState, {
      nodeId: "draft",
      status: "awaiting_review",
      now: 6_252,
      reviewInfrastructureAttempt: 3,
      reviewVerdict: { decision: "accept", reasons: ["通过"], riskLevel: "low", confidence: "high", qualityLevel: "high", dimensionResults: [{ key: "quality", qualityLevel: "high", reason: "正确", evidence: ["candidate"] }] },
      reviewRecord: { gateId: "review-draft", reviewerConfiguredAgentId: "review-agent", reviewAttempt: 1, candidate, verdict: { decision: "accept", reasons: ["通过"], riskLevel: "low", confidence: "high", qualityLevel: "high", dimensionResults: [{ key: "quality", qualityLevel: "high", reason: "正确", evidence: ["candidate"] }] }, requiredLevel: "high", passed: true, reviewedAt: 6_252 },
    });

    const result = await executeWorkflowV2Plan({
      plan,
      initialCheckpoint: { runState, workerOutputs: [candidate] },
      runLlmNode: async () => { throw new Error("executor must not rerun"); },
      executeScript: async () => { throw new Error("script must not run"); },
      reviewNodeOutput: async () => { throw new Error("durably recorded verdict must not be requested twice"); },
    });

    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.reviewHistory).toHaveLength(1);
  });

  test("rejects a checkpoint whose identity does not match the frozen plan", async () => {
    const plan = await buildWorkflowV2Plan({ definition: definition(), approvedBy: "tester", now: 6_200 });
    const runState = createWorkflowV2RunState({ definition: plan.definition });
    runState.graphVersion += 1;

    await expect(executeWorkflowV2Plan({
      plan,
      initialCheckpoint: { runState, workerOutputs: [] },
      runLlmNode: async () => {
        throw new Error("runner should not be called");
      },
      executeScript: async () => {
        throw new Error("script should not be called");
      },
    })).rejects.toThrow("identity does not match");
  });

  test("forces an enabled configured node through independent review", async () => {
    const reviewDefinition = definition();
    reviewDefinition.reviewEnabled = true;
    reviewDefinition.nodes = [{ ...reviewDefinition.nodes[0]!, reviewLevel: "low", judgeDimensions: [{ key: "quality", description: "The result must be usable." }] }];
    reviewDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: reviewDefinition, approvedBy: "tester", now: 6_300 });
    let reviewCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      forceIndependentReviewNodeIds: new Set(["draft"]),
      runLlmNode: async ({ node }) => ({
        nodeId: node.id,
        summary: "Draft requiring strengthened review",
        outputs: { draft: "const strengthened = true;" },
        evidence: ["test evidence"],
        proposals: [],
      }),
      executeScript: async () => {
        throw new Error("script should not be called");
      },
      reviewNodeOutput: async (input) => {
        reviewCalls += 1;
        expect(input.executorNodeId).toBe("draft");
        return {
          reviewerNodeId: "reviewer:draft",
          verdict: {
            decision: "accept",
            reasons: ["Strengthened review passed."],
            riskLevel: "low",
            confidence: "high",
            qualityLevel: "high",
            dimensionResults: [{ key: "quality", qualityLevel: "high", reason: "Usable result.", evidence: ["test evidence"] }],
          },
        };
      },
    });

    expect(reviewCalls).toBe(1);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.reviewVerdict?.decision).toBe("accept");
  });

  test("runs node hooks at explicit lifecycle boundaries", async () => {
    const hookDefinition = definition();
    hookDefinition.nodes = [hookDefinition.nodes[0]!];
    hookDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: hookDefinition, approvedBy: "tester", now: 6_400 });
    const lifecycleOrder: string[] = [];

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async ({ node }) => {
        lifecycleOrder.push("execute");
        return {
          nodeId: node.id,
          summary: "Hooked output",
          outputs: { draft: "const hooked = true;" },
          proposals: [],
        };
      },
      executeScript: async () => {
        throw new Error("script should not be called");
      },
      runNodeHooks: async ({ lifecycle, output }) => {
        lifecycleOrder.push(lifecycle);
        if (lifecycle !== "beforeExecute") expect(output?.nodeId).toBe("draft");
      },
    });

    expect(lifecycleOrder).toEqual(["beforeExecute", "execute", "afterOutput", "afterComplete"]);
    expect(result.runState.status).toBe("completed");
  });

  test("turns a hook skip signal into an explicit downstream-compatible output", async () => {
    const plan = await buildWorkflowV2Plan({ definition: definition(), approvedBy: "tester", now: 6_500 });
    let llmCalls = 0;
    let scriptCalls = 0;

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => {
        llmCalls += 1;
        throw new Error("skipped node must not execute");
      },
      executeScript: async ({ node, upstreamOutputs }) => {
        scriptCalls += 1;
        expect(upstreamOutputs[0]).toMatchObject({
          nodeId: "draft",
          summary: "Skipped: Optional draft omitted.",
          outputs: {},
        });
        return {
          nodeId: node.id,
          summary: "Verified after hook skip",
          outputs: { verification: true },
          proposals: [],
        };
      },
      runNodeHooks: async ({ lifecycle, node }) => {
        if (node.id === "draft" && lifecycle === "beforeExecute") {
          throw new WorkflowV2HookSignal("skip", lifecycle, "Optional draft omitted.");
        }
      },
    });

    expect(llmCalls).toBe(0);
    expect(scriptCalls).toBe(1);
    expect(result.runState.status).toBe("completed");
    expect(result.runState.nodes.draft?.status).toBe("skipped");
    expect(result.workerOutputs[0]).toMatchObject({
      nodeId: "draft",
      summary: "Skipped: Optional draft omitted.",
      outputs: {},
    });
  });

  test("pauses the run at the unified intervention boundary when a hook requests pause", async () => {
    const hookDefinition = definition();
    hookDefinition.nodes = [hookDefinition.nodes[0]!];
    hookDefinition.edges = [];
    const plan = await buildWorkflowV2Plan({ definition: hookDefinition, approvedBy: "tester", now: 6_600 });

    const result = await executeWorkflowV2Plan({
      plan,
      runLlmNode: async () => {
        throw new Error("paused node must not execute");
      },
      executeScript: async () => {
        throw new Error("script should not be called");
      },
      runNodeHooks: async ({ lifecycle }) => {
        if (lifecycle === "beforeExecute") {
          throw new WorkflowV2HookSignal("pause", lifecycle, "Approval required by hook.");
        }
      },
    });

    expect(result.runState.status).toBe("paused");
    expect(result.runState.nodes.draft?.intervention).toMatchObject({
      source: "hook_pause",
      reason: "Approval required by hook.",
    });
  });
});
