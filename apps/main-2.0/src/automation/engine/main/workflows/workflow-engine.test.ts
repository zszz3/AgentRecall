import { describe, expect, test } from "vitest";
import type {
  WorkflowAgentNode,
  WorkflowApprovalNode,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowReviewNode,
  WorkflowRun,
} from "../../shared/workflow/model";
import {
  WorkflowEngine,
  type WorkflowEngineStore,
  type WorkflowExecutionInput,
  type WorkflowNodeExecutor,
} from "./workflow-engine";

function output(key = "value") {
  return { key, name: key, description: `${key} output`, type: "text" as const, required: true };
}

function agent(id: string, dependencies: string[] = []): WorkflowAgentNode {
  return {
    id,
    kind: "agent",
    title: id,
    goal: id,
    agentId: "agent",
    instructions: [],
    constraints: [],
    inputs: dependencies.map((dependency) => ({
      source: "node" as const,
      nodeId: dependency,
      outputKey: "value",
    })),
    outputs: [output()],
    acceptanceCriteria: [],
  };
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return { id: "workflow", name: "Workflow", description: "Test workflow", inputs: [], nodes, createdAt: 1, updatedAt: 1 };
}

class MemoryStore implements WorkflowEngineStore {
  readonly runs = new Map<string, WorkflowRun>();

  async getRun(runId: string): Promise<WorkflowRun | undefined> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : undefined;
  }

  async saveRun(run: WorkflowRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }
}

function executor(run: (input: WorkflowExecutionInput<WorkflowNode>) => Promise<Record<string, unknown>>): WorkflowNodeExecutor {
  return { execute: run };
}

function engine(store: MemoryStore, execute: WorkflowNodeExecutor, ids = ["run-1"]): WorkflowEngine {
  return new WorkflowEngine({
    store,
    executors: { agent: execute, review: execute, script: execute },
    createId: () => ids.shift() ?? "run-next",
    defaultWorkDir: () => "/global-project",
    now: (() => { let value = 10; return () => value++; })(),
  });
}

async function waitForRun(store: MemoryStore, runId: string, status: WorkflowRun["status"]): Promise<WorkflowRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.getRun(runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Workflow Run ${runId} did not reach ${status}.`);
}

describe("WorkflowEngine", () => {
  test("executes ready branches in parallel and resolves exact upstream fields", async () => {
    const store = new MemoryStore();
    let active = 0;
    let peak = 0;
    const seenInputs = new Map<string, Record<string, unknown>>();
    const runtime = engine(store, executor(async ({ node, resolvedInputs }) => {
      seenInputs.set(node.id, resolvedInputs);
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { value: node.id };
    }));

    const started = await runtime.start(definition([
      agent("root"),
      agent("left", ["root"]),
      agent("right", ["root"]),
      agent("final", ["left", "right"]),
    ]), {});

    expect(started.status).toBe("running");
    const run = await waitForRun(store, started.id, "completed");

    expect(run.status).toBe("completed");
    expect(peak).toBe(2);
    expect(seenInputs.get("final")).toEqual({ "left.value": "left", "right.value": "right" });
  });

  test("fails invalid node output and leaves its dependent branch pending", async () => {
    const store = new MemoryStore();
    const runtime = engine(store, executor(async ({ node }) => node.id === "left" ? {} : { value: node.id }));

    const started = await runtime.start(definition([
      agent("root"),
      agent("left", ["root"]),
      agent("right", ["root"]),
      agent("final", ["left", "right"]),
    ]), {});

    const run = await waitForRun(store, started.id, "failed");

    expect(run.status).toBe("failed");
    expect(run.nodeRuns.left?.error).toMatchObject({ code: "invalid_output", fieldPath: "outputs.value" });
    expect(run.nodeRuns.right?.status).toBe("completed");
    expect(run.nodeRuns.final?.status).toBe("pending");
  });

  test("waits at an approval node and resumes with named decision outputs", async () => {
    const store = new MemoryStore();
    const approval: WorkflowApprovalNode = {
      id: "approval",
      kind: "approval",
      title: "Approval",
      goal: "Choose.",
      message: "Continue?",
      options: [
        { value: "yes", label: "Yes", description: "Continue." },
        { value: "no", label: "No", description: "Stop." },
      ],
      allowComment: true,
      inputs: [],
      outputs: [output("decision"), output("comment")],
      acceptanceCriteria: [],
    };
    const downstream = agent("downstream");
    downstream.inputs = [{
      source: "node",
      nodeId: "approval",
      outputKey: "decision",
    }];
    const runtime = engine(store, executor(async ({ node, resolvedInputs }) => ({ value: `${node.id}:${resolvedInputs["approval.decision"]}` })));

    const started = await runtime.start(definition([approval, downstream]), {});
    const waiting = await waitForRun(store, started.id, "waiting");
    expect(waiting.status).toBe("waiting");
    expect(waiting.nodeRuns.approval?.status).toBe("waiting");

    const resumed = await runtime.resolveApproval(waiting.id, "approval", { decision: "yes", comment: "Ship it." });
    expect(resumed.status).toBe("running");
    const completed = await waitForRun(store, waiting.id, "completed");
    expect(completed.status).toBe("completed");
    expect(completed.nodeRuns.downstream?.outputs).toEqual({ value: "downstream:yes" });
  });

  test.each([
    ["none", "pass", "continue", 0],
    ["none", "revise", "continue", null],
    ["invalid", "revise", "revise", 1],
    ["error", "revise", "revise", 0],
  ] as const)("follows graph after %s error and Review %s (%s, legacy limit %s)", async (initialFailure, verdict, onReject, maxRevisions) => {
    const store = new MemoryStore();
    const draft = agent("draft");
    const review: WorkflowReviewNode = {
      ...agent("review", ["draft"]), kind: "review", targetNodeIds: ["draft"],
      criteria: [{ key: "quality", description: "Quality" }], onReject, maxRevisions,
      outputs: [output("verdict"), { ...output("criteriaResults"), type: "list" }, output("feedback")],
    };
    const revision = agent("revision");
    revision.inputs = [{ source: "node", nodeId: "review", outputKey: "feedback" }];
    const finalReview: WorkflowReviewNode = {
      ...structuredClone(review), id: "final_review", targetNodeIds: ["revision"],
      inputs: [{ source: "node", nodeId: "revision", outputKey: "value" }],
    };
    const summary = agent("summary");
    summary.inputs = [{ source: "node", nodeId: "final_review", outputKey: "verdict" }];
    let reviewCalls = 0;
    const calls: string[] = [];
    const runtime = engine(store, executor(async ({ node, resolvedInputs }) => {
      if (node.id === "review") {
        reviewCalls += 1;
        if (reviewCalls === 1 && initialFailure === "error") throw new Error("Runtime unavailable.");
        if (reviewCalls === 1 && initialFailure === "invalid") return { verdict: "unknown", criteriaResults: [], feedback: "Improve it." };
      }
      calls.push(node.id);
      if (node.kind === "review") return { verdict, criteriaResults: [], feedback: "Improve it." };
      if (node.id === "revision") expect(resolvedInputs["review.feedback"]).toBe("Improve it.");
      if (node.id === "summary") expect(resolvedInputs["final_review.verdict"]).toBe(verdict);
      return { value: node.id };
    }));
    const started = await runtime.start(definition([draft, review, revision, finalReview, summary]), {});
    if (initialFailure !== "none") {
      await waitForRun(store, started.id, "failed");
      await runtime.retryNode(started.id, "review");
    }
    const run = await waitForRun(store, started.id, "completed");
    expect(calls).toEqual(["draft", "review", "revision", "final_review", "summary"]);
    expect(run.nodeRuns.draft?.attempt).toBe(1);
    expect(run.nodeRuns.review?.attempt).toBe(initialFailure === "none" ? 1 : 2);
    expect(run.nodeRuns.final_review?.attempt).toBe(1);
    expect(run.nodeRuns.review?.outputs?.verdict).toBe(verdict);
    expect(run.nodeRuns.review?.error).toBeUndefined();
    expect(run.events.some((event) => event.type === "review_revised")).toBe(false);
  });

  test("explicit stop-on-rejection stops downstream without rerunning upstream", async () => {
    const store = new MemoryStore();
    const review: WorkflowReviewNode = {
      ...agent("review", ["draft"]), kind: "review", targetNodeIds: ["draft"],
      criteria: [{ key: "quality", description: "Quality" }], onReject: "stop",
      outputs: [output("verdict"), { ...output("criteriaResults"), type: "list" }, output("feedback")],
    };
    const downstream = agent("downstream");
    downstream.inputs = [{ source: "node", nodeId: "review", outputKey: "feedback" }];
    const runtime = engine(store, executor(async ({ node }) => node.kind === "review"
      ? { verdict: "revise", criteriaResults: [], feedback: "Improve it." } : { value: "Draft" }));
    const started = await runtime.start(definition([agent("draft"), review, downstream]), {});
    const run = await waitForRun(store, started.id, "failed");
    expect(run.nodeRuns.draft?.attempt).toBe(1);
    expect(run.nodeRuns.review?.error?.code).toBe("review_rejected");
    expect(run.nodeRuns.downstream?.attempt).toBe(0);
  });

  test("manual retry keeps valid upstream output and reruns the failed node plus downstream", async () => {
    const store = new MemoryStore();
    let fail = true;
    const calls: string[] = [];
    const runtime = engine(store, executor(async ({ node }) => {
      calls.push(node.id);
      if (node.id === "middle" && fail) throw new Error("broken");
      return { value: node.id };
    }));

    const started = await runtime.start(definition([agent("root"), agent("middle", ["root"]), agent("final", ["middle"])]), {});
    const failed = await waitForRun(store, started.id, "failed");
    fail = false;
    const retried = await runtime.retryNode(failed.id, "middle");
    expect(retried.status).toBe("running");
    const completed = await waitForRun(store, failed.id, "completed");

    expect(completed.status).toBe("completed");
    expect(calls.filter((id) => id === "root")).toHaveLength(1);
    expect(calls.filter((id) => id === "middle")).toHaveLength(2);
    expect(calls.filter((id) => id === "final")).toHaveLength(1);
  });

  test("passes the Workflow directory to node execution and falls back to the global directory", async () => {
    const store = new MemoryStore();
    const seen: string[] = [];
    const runtime = engine(store, executor(async ({ workDir }) => {
      seen.push(workDir ?? "missing");
      return { value: "done" };
    }));

    const selected = await runtime.start({ ...definition([agent("answer")]), workDir: "/workflow-project" }, {});
    await waitForRun(store, selected.id, "completed");
    const fallback = await runtime.start({ ...definition([agent("answer")]), workDir: null }, {});
    await waitForRun(store, fallback.id, "completed");

    expect(seen).toEqual(["/workflow-project", "/global-project"]);
  });

  test("rejects required Workflow inputs that are present but carry no value", async () => {
    const store = new MemoryStore();
    const runtime = engine(store, executor(async () => ({ value: "done" })));
    const withRequiredTopic = {
      ...definition([agent("answer")]),
      inputs: [{ key: "topic", name: "Topic", description: "What to research", type: "text" as const, required: true }],
    };

    for (const value of [undefined, null, "", "   "]) {
      await expect(runtime.start(withRequiredTopic, { topic: value })).rejects.toThrow("Required Workflow input topic is missing.");
    }
    await expect(runtime.start(withRequiredTopic, {})).rejects.toThrow("Required Workflow input topic is missing.");
    expect(store.runs.size).toBe(0);

    const accepted = await runtime.start(withRequiredTopic, { topic: "coding agents" });
    await waitForRun(store, accepted.id, "completed");
  });

  test("keeps falsy-but-real required input values, and still allows blank optional inputs", async () => {
    const store = new MemoryStore();
    const runtime = engine(store, executor(async () => ({ value: "done" })));
    const withMixedInputs = {
      ...definition([agent("answer")]),
      inputs: [
        { key: "attempts", name: "Attempts", description: "How many", type: "number" as const, required: true },
        { key: "enabled", name: "Enabled", description: "On or off", type: "boolean" as const, required: true },
        { key: "note", name: "Note", description: "Optional note", type: "text" as const, required: false },
      ],
    };

    const started = await runtime.start(withMixedInputs, { attempts: 0, enabled: false, note: "" });
    await waitForRun(store, started.id, "completed");
    expect(started.inputs).toEqual({ attempts: 0, enabled: false, note: "" });
  });

  test("approving one branch while a parallel branch is executing keeps both results", async () => {
    const store = new MemoryStore();
    const approval: WorkflowApprovalNode = {
      id: "approval",
      kind: "approval",
      title: "Approval",
      goal: "Choose.",
      message: "Continue?",
      options: [
        { value: "yes", label: "Yes", description: "Continue." },
        { value: "no", label: "No", description: "Stop." },
      ],
      allowComment: false,
      inputs: [],
      outputs: [output("decision")],
      acceptanceCriteria: [],
    };
    const downstream = agent("downstream", ["approval"]);
    downstream.inputs = [{ source: "node", nodeId: "approval", outputKey: "decision" }];
    const parallel = agent("parallel");
    let parallelAttempts = 0;
    const runtime = engine(store, executor(async ({ node, signal }) => {
      if (node.id === "parallel") {
        parallelAttempts += 1;
        if (parallelAttempts === 1) {
          // First attempt belongs to the loop superseded by the approval: it
          // only ends once that loop is aborted.
          return new Promise<Record<string, unknown>>((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("superseded")), { once: true });
          });
        }
      }
      return { value: node.id };
    }));

    const started = await runtime.start(definition([parallel, approval, downstream]), {});
    // The parallel branch keeps the overall run "running"; wait for the approval
    // node itself to reach waiting.
    let waiting: WorkflowRun | undefined;
    for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
      const candidate = await store.getRun(started.id);
      if (candidate?.nodeRuns.approval?.status === "waiting") waiting = candidate;
      else await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!waiting) throw new Error("Approval node never reached waiting.");
    expect(waiting.nodeRuns.parallel?.status).toBe("running");
    expect(waiting.nodeRuns.approval?.status).toBe("waiting");

    await runtime.resolveApproval(waiting.id, "approval", { decision: "yes" });

    const completed = await waitForRun(store, started.id, "completed");
    expect(completed.nodeRuns.approval?.status).toBe("completed");
    expect(completed.nodeRuns.approval?.outputs).toEqual({ decision: "yes" });
    expect(completed.nodeRuns.downstream?.status).toBe("completed");
    expect(completed.nodeRuns.parallel?.status).toBe("completed");
    expect(parallelAttempts).toBe(2);
  });

  test("pauses an active node, records lifecycle events, and resumes it in the background", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const runtime = engine(store, executor(async ({ signal }) => {
      calls += 1;
      if (calls > 1) return { value: "resumed" };
      return new Promise<Record<string, unknown>>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("paused")), { once: true });
      });
    }));

    const started = await runtime.start(definition([agent("answer")]), {});
    expect(started.status).toBe("running");
    const active = await waitForRun(store, started.id, "running");
    expect(active.nodeRuns.answer?.status).toBe("running");

    const paused = await runtime.pause(started.id);
    expect(paused.status).toBe("paused");
    expect(paused.nodeRuns.answer?.status).toBe("pending");

    const resumed = await runtime.resume(started.id);
    expect(resumed.status).toBe("running");
    const completed = await waitForRun(store, started.id, "completed");
    expect(completed.nodeRuns.answer?.outputs).toEqual({ value: "resumed" });
    expect(completed.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "run_started",
      "node_started",
      "run_paused",
      "run_resumed",
      "node_completed",
      "run_completed",
    ]));
  });
});
