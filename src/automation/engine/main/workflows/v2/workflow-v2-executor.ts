import type { WorkflowV2LLMNode, WorkflowV2Node, WorkflowV2ScriptNode } from "../../../shared/workflow-v2/definition";
import {
  cloneWorkflowV2WorkerOutput,
  type WorkflowV2WorkerOutput,
} from "../../../shared/workflow-v2/packets";
import type {
  WorkflowV2Plan,
  WorkflowV2PlanNode,
  WorkflowV2ResultPacket,
} from "../../../shared/workflow-v2/planning";
import type {
  WorkflowV2HumanIntervention,
  WorkflowV2ReviewVerdict,
  WorkflowV2ReviewerInput,
  WorkflowV2ReviewerResponse,
  WorkflowV2ReviewRetryPolicy,
} from "../../../shared/workflow-v2/review";
import { createWorkflowV2RunState, type WorkflowV2RunState } from "../../../shared/workflow-v2/state";
import {
  isValidWorkflowV2ContextBudget,
  isValidWorkflowV2CostBudget,
} from "../../../shared/workflow-v2/validation";
import { assembleWorkflowV2LeaderNavigation, type WorkflowV2LeaderNavigation } from "./workflow-v2-leader";
import { runWorkflowV2LlmNode } from "./workflow-v2-llm-runner";
import { listWorkflowV2RunnableNodeIds, transitionWorkflowV2NodeState } from "./workflow-v2-scheduler";
import { runWorkflowV2ScriptNode } from "./workflow-v2-script-runner";
import {
  assertIndependentWorkflowV2Reviewer,
  createWorkflowV2ReviewerInput,
  resolveWorkflowV2ReviewVerdict,
} from "./workflow-v2-reviewer";
import { validateWorkflowV2NodeOutput } from "./workflow-v2-validation";
import { WorkflowV2SupervisionSignal } from "./workflow-v2-supervision-signal";
import type { WorkflowV2HookLifecycle } from "../../../shared/workflow-v2/hooks";
import { WorkflowV2HookSignal } from "./workflow-v2-hooks";

export interface ExecuteWorkflowV2PlanInput {
  plan: WorkflowV2Plan;
  initialCheckpoint?: ExecuteWorkflowV2Checkpoint;
  maxParallelNodes?: number;
  runLlmNode: (input: {
    node: WorkflowV2LLMNode;
    planNode: WorkflowV2PlanNode;
    taskPacket: WorkflowV2PlanNode["taskPacket"];
    upstreamOutputs: readonly WorkflowV2ResultPacket[];
  }) => Promise<WorkflowV2WorkerOutput>;
  executeScript: (input: {
    node: WorkflowV2ScriptNode;
    planNode: WorkflowV2PlanNode;
    taskPacket: WorkflowV2PlanNode["taskPacket"];
    upstreamOutputs: readonly WorkflowV2ResultPacket[];
  }) => Promise<WorkflowV2WorkerOutput>;
  isNodeOutputSuccessful?: (input: {
    node: WorkflowV2Node;
    planNode: WorkflowV2PlanNode;
    output: WorkflowV2WorkerOutput;
  }) => boolean;
  reviewNodeOutput?: (input: WorkflowV2ReviewerInput) => Promise<WorkflowV2ReviewerResponse>;
  forceIndependentReviewNodeIds?: ReadonlySet<string>;
  runNodeHooks?: (input: {
    lifecycle: WorkflowV2HookLifecycle;
    node: WorkflowV2Node;
    output?: WorkflowV2WorkerOutput;
  }) => Promise<void>;
  onNodeStateTransition?: (input: WorkflowV2NodeStateTransitionEvent) => void;
  onRunCheckpoint?: (input: ExecuteWorkflowV2Checkpoint) => Promise<void>;
  now?: () => number;
}

export interface ExecuteWorkflowV2Checkpoint {
  runState: WorkflowV2RunState;
  workerOutputs: WorkflowV2WorkerOutput[];
}

export type WorkflowV2NodeStateTransitionEvent =
  | { nodeId: string; status: "running" }
  | { nodeId: string; status: "completed"; output: WorkflowV2WorkerOutput }
  | { nodeId: string; status: "skipped"; output: WorkflowV2WorkerOutput }
  | { nodeId: string; status: "paused"; intervention: WorkflowV2HumanIntervention }
  | { nodeId: string; status: "failed"; error: string };

export interface ExecuteWorkflowV2PlanResult {
  runState: WorkflowV2RunState;
  workerOutputs: WorkflowV2WorkerOutput[];
  leaderNavigation: WorkflowV2LeaderNavigation;
}

export async function executeWorkflowV2Plan(input: ExecuteWorkflowV2PlanInput): Promise<ExecuteWorkflowV2PlanResult> {
  assertWorkflowV2ExecutionBudgets(input.plan);
  const planNodesById = new Map(input.plan.nodes.map((node) => [node.nodeId, node]));
  const definitionNodesById = new Map(input.plan.definition.nodes.map((node) => [node.id, node]));
  if (input.initialCheckpoint) assertWorkflowV2InitialCheckpoint(input.plan, input.initialCheckpoint);
  const workerOutputs: WorkflowV2WorkerOutput[] = input.initialCheckpoint
    ? input.initialCheckpoint.workerOutputs.map(cloneWorkflowV2WorkerOutput)
    : [];
  const workerOutputsByNodeId = new Map(workerOutputs.map((output) => [output.nodeId, output]));
  const now = input.now ?? Date.now;
  let runState = input.initialCheckpoint
    ? structuredClone(input.initialCheckpoint.runState)
    : createWorkflowV2RunState({
        definition: input.plan.definition,
        ...(input.maxParallelNodes !== undefined ? { maxParallelNodes: input.maxParallelNodes } : {}),
      });
  const checkpoint = async (): Promise<void> => {
    if (!input.onRunCheckpoint) return;
    await input.onRunCheckpoint({
      runState: structuredClone(runState),
      workerOutputs: workerOutputs.map(cloneWorkflowV2WorkerOutput),
    });
  };

  if (input.onRunCheckpoint) await checkpoint();

  while (runState.status === "running") {
    const runnableNodeIds = listWorkflowV2RunnableNodeIds(runState);
    if (runnableNodeIds.length === 0) {
      const stalled = failWorkflowV2NodeExecution(runState, "Workflow V2 executor could not make progress on the frozen plan.", now());
      runState = stalled.runState;
      input.onNodeStateTransition?.({
        nodeId: stalled.nodeId,
        status: "failed",
        error: "Workflow V2 executor could not make progress on the frozen plan.",
      });
      if (input.onRunCheckpoint) await checkpoint();
      break;
    }

    const batch = runnableNodeIds.map((nodeId) => {
      const planNode = planNodesById.get(nodeId);
      const node = definitionNodesById.get(nodeId);
      if (!planNode || !node) {
        throw new Error(`Workflow V2 executor could not resolve node ${nodeId} from the frozen plan.`);
      }

      return {
        nodeId,
        node,
        planNode,
        upstreamOutputs: collectDirectUpstreamOutputs(
          nodeId,
          input.plan.definition.edges,
          workerOutputsByNodeId,
          planNode.taskPacket.budget.context,
        ),
      };
    });

    for (const { nodeId } of batch) {
      runState = transitionWorkflowV2NodeState(runState, {
        nodeId,
        status: "running",
        now: now(),
      });
      input.onNodeStateTransition?.({ nodeId, status: "running" });
    }
    if (input.onRunCheckpoint) await checkpoint();

    const settledBatch = await Promise.allSettled(
      batch.map(({ node, planNode, upstreamOutputs }) => executeWorkflowV2Node({
        node,
        planNode,
        upstreamOutputs,
        runLlmNode: input.runLlmNode,
        executeScript: input.executeScript,
        runNodeHooks: input.runNodeHooks,
      })),
    );

    for (const [index, { nodeId, node, planNode }] of batch.entries()) {
      const settledNode = settledBatch[index]!;

      if (settledNode.status === "rejected") {
        if (settledNode.reason instanceof WorkflowV2HookSignal) {
          if (settledNode.reason.action === "skip") {
            recordSkippedOutput(settledNode.reason.reason);
            continue;
          }
          const intervention = createIntervention(nodeId, "hook_pause", settledNode.reason.reason, now());
          runState = transitionWorkflowV2NodeState(runState, {
            nodeId,
            status: "paused",
            now: now(),
            error: settledNode.reason.reason,
            intervention,
          });
          input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
          continue;
        }
        if (settledNode.reason instanceof WorkflowV2SupervisionSignal) {
          const signal = settledNode.reason;
          const attempt = runState.nodes[nodeId]!.attempt;
          if (signal.resolution.action === "retry" && attempt <= (node.execModel === "llm" ? node.maxRetry ?? 0 : 0)) {
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "ready",
              now: now(),
              error: signal.resolution.reason,
            });
            continue;
          }
          if (signal.resolution.action === "retry" && exhaustedPolicyFor(node) === "skip") {
            recordSkippedOutput(signal.resolution.reason);
            continue;
          }
          if (
            signal.resolution.action === "pause"
            || signal.resolution.action === "escalate"
            || (signal.resolution.action === "retry" && exhaustedPolicyFor(node) === "ask_human")
          ) {
            const source = signal.resolution.action === "escalate" ? "supervision_escalation" : "supervision_pause";
            const intervention = createIntervention(
              nodeId,
              source,
              signal.resolution.reason,
              now(),
              undefined,
              {
                report: signal.report,
                decision: signal.resolution,
                ...(signal.resumeConversation ? { resumeConversation: signal.resumeConversation } : {}),
              },
              signal.intervention,
            );
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "paused",
              now: now(),
              error: signal.resolution.reason,
              intervention,
            });
            input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
            continue;
          }
        }
        const error = settledNode.reason instanceof Error ? settledNode.reason.message : String(settledNode.reason);
        runState = transitionWorkflowV2NodeState(runState, {
          nodeId,
          status: "failed",
          now: now(),
          error,
        });
        input.onNodeStateTransition?.({ nodeId, status: "failed", error });
        continue;
      }

      try {
        const authoritativeWorkerOutput = cloneWorkflowV2WorkerOutput(settledNode.value);
        const attempt = runState.nodes[nodeId]!.attempt;
        const validation = validateWorkflowV2NodeOutput({ node, output: authoritativeWorkerOutput, attempt });
        runState = transitionWorkflowV2NodeState(runState, {
          nodeId,
          status: "validating",
          now: now(),
          validation,
        });

        if (validation.outcome !== "pass") {
          const validationReason = validation.reasons.join(" ");
          if (validation.outcome === "retry") {
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "ready",
              now: now(),
              error: validationReason,
            });
            continue;
          }
          if (validation.outcome === "ask_human") {
            const intervention = createIntervention(nodeId, "validation", validationReason, now());
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "paused",
              now: now(),
              error: validationReason,
              intervention,
            });
            input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
            continue;
          }
          if (exhaustedPolicyFor(node) === "skip") {
            recordSkippedOutput(validationReason);
            continue;
          }
          failNode(validationReason || `Workflow V2 node ${nodeId} failed mechanical validation.`);
          continue;
        }

        if (!isNodeOutputSuccessful(node, planNode, authoritativeWorkerOutput, input.isNodeOutputSuccessful)) {
          failNode(`Workflow V2 node ${nodeId} reported an unsuccessful output.`);
          continue;
        }

        if (requiresSemanticReview(node, input.forceIndependentReviewNodeIds?.has(nodeId) === true)) {
          runState = transitionWorkflowV2NodeState(runState, { nodeId, status: "awaiting_review", now: now() });
          if (!input.reviewNodeOutput) {
            const intervention = createIntervention(
              nodeId,
              "review_escalation",
              `Workflow V2 node ${nodeId} requires an independent semantic reviewer.`,
              now(),
            );
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "paused",
              now: now(),
              error: intervention.reason,
              intervention,
            });
            input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
            continue;
          }

          let reviewerResponse: WorkflowV2ReviewerResponse;
          try {
            reviewerResponse = await input.reviewNodeOutput(createWorkflowV2ReviewerInput({
              node,
              objective: input.plan.objective,
              output: authoritativeWorkerOutput,
            }));
          } catch (error) {
            if (
              error instanceof WorkflowV2SupervisionSignal
              && (error.resolution.action === "pause" || error.resolution.action === "escalate")
            ) {
              const source = error.resolution.action === "escalate" ? "supervision_escalation" : "supervision_pause";
              const intervention = createIntervention(
                nodeId,
                source,
                error.resolution.reason,
                now(),
                undefined,
                {
                  report: error.report,
                  decision: error.resolution,
                  ...(error.resumeConversation ? { resumeConversation: error.resumeConversation } : {}),
                },
              );
              runState = transitionWorkflowV2NodeState(runState, {
                nodeId,
                status: "paused",
                now: now(),
                error: error.resolution.reason,
                intervention,
              });
              input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
              continue;
            }
            throw error;
          }
          assertIndependentWorkflowV2Reviewer(nodeId, reviewerResponse);
          const resolution = resolveWorkflowV2ReviewVerdict(reviewerResponse.verdict, reviewRetryPolicyFor(node, attempt));
          runState = transitionWorkflowV2NodeState(runState, {
            nodeId,
            status: "awaiting_review",
            now: now(),
            reviewVerdict: resolution.verdict,
          });

          if (resolution.action === "retry") {
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "ready",
              now: now(),
              error: resolution.reason,
            });
            continue;
          }
          if (resolution.action === "skip") {
            recordSkippedOutput(resolution.reason);
            continue;
          }
          if (resolution.action === "pause" || resolution.action === "escalate") {
            const source = resolution.action === "escalate" ? "review_escalation" : "review_rejection";
            const intervention = createIntervention(nodeId, source, resolution.reason, now(), resolution.verdict);
            runState = transitionWorkflowV2NodeState(runState, {
              nodeId,
              status: "paused",
              now: now(),
              error: resolution.reason,
              reviewVerdict: resolution.verdict,
              intervention,
            });
            input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
            continue;
          }
          if (resolution.action === "fail") {
            failNode(resolution.reason);
            continue;
          }
        }

        await input.runNodeHooks?.({
          lifecycle: "afterComplete",
          node,
          output: cloneWorkflowV2WorkerOutput(authoritativeWorkerOutput),
        });
        workerOutputs.push(authoritativeWorkerOutput);
        workerOutputsByNodeId.set(nodeId, authoritativeWorkerOutput);
        runState = transitionWorkflowV2NodeState(runState, { nodeId, status: "completed", now: now() });
        input.onNodeStateTransition?.({ nodeId, status: "completed", output: cloneWorkflowV2WorkerOutput(authoritativeWorkerOutput) });
      } catch (error) {
        if (error instanceof WorkflowV2HookSignal) {
          if (error.action === "skip") {
            recordSkippedOutput(error.reason);
            continue;
          }
          const intervention = createIntervention(nodeId, "hook_pause", error.reason, now());
          runState = transitionWorkflowV2NodeState(runState, {
            nodeId,
            status: "paused",
            now: now(),
            error: error.reason,
            intervention,
          });
          input.onNodeStateTransition?.({ nodeId, status: "paused", intervention });
          continue;
        }
        const failureMessage = error instanceof Error ? error.message : String(error);
        runState = transitionWorkflowV2NodeState(runState, {
          nodeId,
          status: "failed",
          now: now(),
          error: failureMessage,
        });
        input.onNodeStateTransition?.({ nodeId, status: "failed", error: failureMessage });
      }

      function failNode(error: string): void {
        runState = transitionWorkflowV2NodeState(runState, { nodeId, status: "failed", now: now(), error });
        input.onNodeStateTransition?.({ nodeId, status: "failed", error });
      }

      function recordSkippedOutput(reason: string): void {
        const skippedOutput = createSkippedOutput(nodeId, reason);
        workerOutputs.push(skippedOutput);
        workerOutputsByNodeId.set(nodeId, skippedOutput);
        runState = transitionWorkflowV2NodeState(runState, { nodeId, status: "skipped", now: now() });
        input.onNodeStateTransition?.({ nodeId, status: "skipped", output: cloneWorkflowV2WorkerOutput(skippedOutput) });
      }
    }
    if (input.onRunCheckpoint) await checkpoint();
  }

  const finalRunnableNodeIds = listWorkflowV2RunnableNodeIds(runState);

  return {
    runState,
    workerOutputs,
    leaderNavigation: assembleWorkflowV2LeaderNavigation({
      runState,
      runnableNodeIds: finalRunnableNodeIds,
      workerOutputs,
    }),
  };
}

function assertWorkflowV2InitialCheckpoint(
  plan: WorkflowV2Plan,
  checkpoint: ExecuteWorkflowV2Checkpoint,
): void {
  const runState = checkpoint.runState;
  if (runState.workflowId !== plan.workflowId || runState.graphVersion !== plan.graphVersion) {
    throw new Error("Workflow V2 initial checkpoint identity does not match the frozen plan.");
  }
  const planNodeIds = plan.definition.nodes.map((node) => node.id);
  if (runState.nodeOrder.length !== planNodeIds.length
    || runState.nodeOrder.some((nodeId, index) => nodeId !== planNodeIds[index])) {
    throw new Error("Workflow V2 initial checkpoint node order does not match the frozen plan.");
  }
  const outputNodeIds = new Set<string>();
  for (const output of checkpoint.workerOutputs) {
    if (outputNodeIds.has(output.nodeId)) throw new Error(`Workflow V2 initial checkpoint duplicates output ${output.nodeId}.`);
    outputNodeIds.add(output.nodeId);
    const nodeState = runState.nodes[output.nodeId];
    if (!nodeState || (nodeState.status !== "completed" && nodeState.status !== "skipped")) {
      throw new Error(`Workflow V2 initial checkpoint output ${output.nodeId} is neither completed nor skipped.`);
    }
    cloneWorkflowV2WorkerOutput(output);
  }
  for (const nodeId of planNodeIds) {
    if (!runState.nodes[nodeId]) throw new Error(`Workflow V2 initial checkpoint is missing node ${nodeId}.`);
  }
}

function failWorkflowV2NodeExecution(
  runState: WorkflowV2RunState,
  error: string,
  now: number,
): { runState: WorkflowV2RunState; nodeId: string } {
  const failedNodeId = runState.nodeOrder.find((nodeId) => {
    const node = runState.nodes[nodeId];
    return node?.status === "ready" || node?.status === "blocked";
  });
  if (!failedNodeId) {
    throw new Error(error);
  }

  return {
    nodeId: failedNodeId,
    runState: transitionWorkflowV2NodeState(runState, {
      nodeId: failedNodeId,
      status: "failed",
      now,
      error,
    }),
  };
}

async function executeWorkflowV2Node(input: {
  node: WorkflowV2Node;
  planNode: WorkflowV2PlanNode;
  upstreamOutputs: readonly WorkflowV2ResultPacket[];
  runLlmNode: ExecuteWorkflowV2PlanInput["runLlmNode"];
  executeScript: ExecuteWorkflowV2PlanInput["executeScript"];
  runNodeHooks: ExecuteWorkflowV2PlanInput["runNodeHooks"];
}): Promise<WorkflowV2WorkerOutput> {
  await input.runNodeHooks?.({ lifecycle: "beforeExecute", node: input.node });
  let output: WorkflowV2WorkerOutput;
  if (input.node.execModel === "llm") {
    output = await runWorkflowV2LlmNode({
      node: input.node,
      planNode: input.planNode,
      taskPacket: input.planNode.taskPacket,
      upstreamOutputs: input.upstreamOutputs,
      runLlmNode: input.runLlmNode,
    });
  } else {
    output = await runWorkflowV2ScriptNode({
      node: input.node,
      planNode: input.planNode,
      taskPacket: input.planNode.taskPacket,
      upstreamOutputs: input.upstreamOutputs,
      executeScript: input.executeScript,
    });
  }
  await input.runNodeHooks?.({ lifecycle: "afterOutput", node: input.node, output: cloneWorkflowV2WorkerOutput(output) });
  return output;
}

function collectDirectUpstreamOutputs(
  nodeId: string,
  edges: WorkflowV2Plan["definition"]["edges"],
  workerOutputsByNodeId: ReadonlyMap<string, WorkflowV2WorkerOutput>,
  contextBudget: WorkflowV2PlanNode["taskPacket"]["budget"]["context"],
): WorkflowV2ResultPacket[] {
  const maxUpstreamNodes = contextBudget.maxUpstreamNodes ?? Number.POSITIVE_INFINITY;
  let remainingEvidenceItems = contextBudget.maxEvidenceItems === undefined
    ? undefined
    : contextBudget.maxEvidenceItems;

  return edges
    .filter((edge) => edge.toNodeId === nodeId)
    .slice(0, maxUpstreamNodes)
    .map((edge) => {
      const output = workerOutputsByNodeId.get(edge.fromNodeId);
      if (!output) {
        throw new Error(`Workflow V2 node ${nodeId} is missing output from direct upstream node ${edge.fromNodeId}.`);
      }
      const packet = cloneWorkflowV2ResultPacket(output);
      if (remainingEvidenceItems === undefined) return packet;

      const evidence = packet.evidence?.slice(0, remainingEvidenceItems) ?? [];
      remainingEvidenceItems -= evidence.length;
      delete packet.evidence;
      if (evidence.length > 0) packet.evidence = evidence;
      return packet;
    });
}

function assertWorkflowV2ExecutionBudgets(plan: WorkflowV2Plan): void {
  const budgetOwners = [
    { owner: "plan", budget: plan.budget },
    ...plan.nodes.flatMap((planNode) => [
      { owner: `plan node ${planNode.nodeId}`, budget: planNode.budget },
      { owner: `task packet ${planNode.nodeId}`, budget: planNode.taskPacket.budget },
    ]),
  ];

  for (const { owner, budget } of budgetOwners) {
    if (!isValidWorkflowV2ContextBudget(budget?.context)) {
      throw new Error(`Workflow V2 executor received an invalid context budget from ${owner}.`);
    }
    if (budget.cost !== undefined && !isValidWorkflowV2CostBudget(budget.cost)) {
      throw new Error(`Workflow V2 executor received an invalid cost budget from ${owner}.`);
    }
  }
}

function cloneWorkflowV2ResultPacket(output: WorkflowV2WorkerOutput): WorkflowV2ResultPacket {
  const clonedOutput = cloneWorkflowV2WorkerOutput(output);
  return {
    nodeId: clonedOutput.nodeId,
    summary: clonedOutput.summary,
    outputs: clonedOutput.outputs,
    ...(clonedOutput.evidence ? { evidence: clonedOutput.evidence } : {}),
    ...(clonedOutput.risks ? { risks: clonedOutput.risks } : {}),
    ...(clonedOutput.nextStepSuggestions ? { nextStepSuggestions: clonedOutput.nextStepSuggestions } : {}),
  };
}

function isNodeOutputSuccessful(
  node: WorkflowV2Node,
  planNode: WorkflowV2PlanNode,
  output: WorkflowV2WorkerOutput,
  customPredicate: ExecuteWorkflowV2PlanInput["isNodeOutputSuccessful"],
): boolean {
  if (customPredicate) {
    return customPredicate({
      node,
      planNode,
      output: cloneWorkflowV2WorkerOutput(output),
    });
  }

  return node.outputFields
    .filter((field) => field.required !== false)
    .every((field) => Object.hasOwn(output.outputs, field.key));
}

function requiresSemanticReview(node: WorkflowV2Node, forced = false): boolean {
  return node.execModel === "llm"
    && node.role !== "reviewer"
    && (forced || (node.judgeDimensions?.length ?? 0) > 0);
}

function exhaustedPolicyFor(node: WorkflowV2Node): "fail" | "skip" | "ask_human" {
  return node.execModel === "llm" ? node.onExhausted ?? "fail" : node.onError ?? "fail";
}

function reviewRetryPolicyFor(node: WorkflowV2Node, attempt: number): WorkflowV2ReviewRetryPolicy {
  return {
    attempt,
    maxRetry: node.execModel === "llm" ? node.maxRetry ?? 0 : 0,
    onExhausted: exhaustedPolicyFor(node),
  };
}

function createIntervention(
  nodeId: string,
  source: WorkflowV2HumanIntervention["source"],
  reason: string,
  requestedAt: number,
  reviewVerdict?: WorkflowV2ReviewVerdict,
  supervision?: {
    report: WorkflowV2HumanIntervention["progressReport"];
    decision: WorkflowV2HumanIntervention["supervisorDecision"];
    resumeConversation?: WorkflowV2HumanIntervention["resumeConversation"];
  },
  override?: Pick<WorkflowV2HumanIntervention, "source" | "allowedActions" | "scriptApproval">,
): WorkflowV2HumanIntervention {
  return {
    nodeId,
    source: override?.source ?? source,
    reason,
    allowedActions: override?.allowedActions ?? ["continue", "skip", "escalate", "replan", "increase_review_strength"],
    requestedAt,
    ...(reviewVerdict ? { reviewVerdict: structuredClone(reviewVerdict) } : {}),
    ...(supervision?.report ? { progressReport: structuredClone(supervision.report) } : {}),
    ...(supervision?.decision ? { supervisorDecision: structuredClone(supervision.decision) } : {}),
    ...(supervision?.resumeConversation ? { resumeConversation: structuredClone(supervision.resumeConversation) } : {}),
    ...(override?.scriptApproval ? { scriptApproval: structuredClone(override.scriptApproval) } : {}),
  };
}

function createSkippedOutput(nodeId: string, reason: string): WorkflowV2WorkerOutput {
  return {
    nodeId,
    summary: `Skipped: ${reason}`,
    outputs: {},
    risks: [reason],
    proposals: [],
  };
}
