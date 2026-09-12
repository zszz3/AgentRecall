import {
  buildEvaluationGraph,
  createEvaluationNodeRegistry,
  type BuiltEvaluationGraph,
  type EvaluationGraphNodeSpec,
  type EvaluationGraphSpec,
  type EvaluationInputBinding,
} from "./graph/builder";
import type { AnyEvaluationNodeDefinition } from "./graph/node";
import {
  createArtifactCompleteNode,
  createFolderArtifactNode,
  createRunAgentNode,
  createSessionArtifactNode,
  createSessionLinkNode,
  createSkillProvisionNode,
  skillUseObserveNode,
  taskSourceNode,
  ARTIFACT_COMPLETE_NODE_TYPE,
  FOLDER_ARTIFACT_NODE_TYPE,
  RUN_AGENT_NODE_TYPE,
  SESSION_ARTIFACT_NODE_TYPE,
  SESSION_LINK_NODE_TYPE,
  SKILL_PROVISION_NODE_TYPE,
  SKILL_USE_OBSERVE_NODE_TYPE,
  TASK_SOURCE_NODE_TYPE,
} from "./nodes/prepare-nodes";
import {
  createLlmJudgeNode,
  createScriptJudgeNode,
  createScriptTrajectoryJudgeNode,
  deterministicJudgeNode,
  toolFailureJudgeNode,
  trajectoryBudgetJudgeNode,
  DETERMINISTIC_JUDGE_NODE_TYPE,
  LLM_JUDGE_NODE_TYPE,
  SCRIPT_JUDGE_NODE_TYPE,
  SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE,
  TOOL_FAILURE_JUDGE_NODE_TYPE,
  TRAJECTORY_BUDGET_JUDGE_NODE_TYPE,
} from "./nodes/judge-nodes";
import type {
  EvaluationJudgeScript,
  EvaluationNodeDependencies,
  EvaluationTaskValue,
} from "./nodes/contracts";

/**
 * Assembles the graph for a single evaluation case.
 *
 * The head is an artifact source: run the agent now, read a session that already
 * happened, or read a folder. Everything after it is evaluation, which is what
 * makes a rubric change cheap — re-judging a session costs judge calls, not
 * another agent run.
 *
 * One graph per case, so per-case data lives in node config and every case gets
 * an isolated set of records. Node ids are stable across runs of the same
 * experiment, which is what lets two runs be compared node by node.
 */

export const TASK_NODE_ID = "task";
export const SKILL_NODE_ID = "skill";
export const AGENT_NODE_ID = "agent";
export const SESSION_NODE_ID = "session";
export const SOURCE_NODE_ID = "source";
export const SKILL_USE_NODE_ID = "skill-use";
export const ARTIFACT_COMPLETE_NODE_ID = "artifact-complete";

/** Where the artifact under evaluation comes from. */
export type EvaluationArtifactSourceKind = "run_agent" | "session" | "folder";

export type EvaluationPlanEvaluatorKind =
  | "exact_match"
  | "contains"
  | "json_valid"
  | "llm_judge"
  | "tool_failures"
  | "trajectory_budget"
  | "script";

/** What a judge decides on. Only a source with a session has a trajectory. */
export type EvaluationJudgeSubject = "artifact" | "trajectory";

export interface EvaluationPlanEvaluator {
  id: string;
  kind: EvaluationPlanEvaluatorKind;
  threshold: number;
  /** Dimension this evaluator scores. Defaults to its id. */
  dimension?: string;
  priority?: "must" | "should";
  runtimeId?: string;
  prompt?: string;
  maxToolFailures?: number;
  /**
   * Only for `trajectory_budget`. An unset metric is not budgeted, which is not
   * the same as a budget of zero.
   */
  maxTurns?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxDurationMs?: number;
  /** Only for `script`. */
  scriptMode?: "inline_js" | "command";
  script?: string;
  command?: string;
  commandArgs?: string[];
  subject?: EvaluationJudgeSubject;
  timeoutMs?: number;
}

export interface EvaluationCasePlan {
  task: EvaluationTaskValue;
  source: EvaluationArtifactSourceKind;
  agentId: string;
  skillName: string | null;
  evaluators: readonly EvaluationPlanEvaluator[];
  /**
   * Attach the session-link step so a fresh run gains a trajectory. Off leaves
   * trajectory judges out of the graph rather than blocking on a link.
   */
  linkTrajectory: boolean;
  sessionLink?: { attempts?: number; delayMs?: number };
  /** Graph authored in the editor; replaces the derived shape when present. */
  savedSpec?: EvaluationGraphSpec;
}

export function createEvaluationNodeDefinitions(
  dependencies: EvaluationNodeDependencies,
): AnyEvaluationNodeDefinition[] {
  return [
    taskSourceNode,
    createSkillProvisionNode(dependencies),
    createRunAgentNode(dependencies),
    createSessionLinkNode(dependencies),
    createArtifactCompleteNode(dependencies),
    createSessionArtifactNode(dependencies),
    createFolderArtifactNode(dependencies),
    skillUseObserveNode,
    deterministicJudgeNode,
    createLlmJudgeNode(dependencies),
    toolFailureJudgeNode,
    trajectoryBudgetJudgeNode,
    createScriptJudgeNode(dependencies),
    createScriptTrajectoryJudgeNode(dependencies),
  ];
}

/** True when this evaluator decides on the trajectory rather than the artifact. */
export function judgesTrajectory(evaluator: EvaluationPlanEvaluator): boolean {
  if (evaluator.kind === "tool_failures" || evaluator.kind === "trajectory_budget") return true;
  return evaluator.kind === "script" && evaluator.subject === "trajectory";
}

export interface EvaluationCaseSpecResult {
  spec: EvaluationGraphSpec;
  /**
   * Evaluators left out because this source has no trajectory to judge. Reported
   * so an omission is visible rather than looking like a passing run.
   */
  skippedEvaluatorIds: string[];
}

export function buildEvaluationCaseSpec(plan: EvaluationCasePlan): EvaluationCaseSpecResult {
  const nodes: EvaluationGraphNodeSpec[] = [
    { id: TASK_NODE_ID, type: TASK_SOURCE_NODE_TYPE, config: plan.task },
  ];
  let artifactNodeId: string;
  let trajectoryNodeId: string | null = null;

  if (plan.source === "run_agent") {
    nodes.push(
      { id: SKILL_NODE_ID, type: SKILL_PROVISION_NODE_TYPE, config: { skillName: plan.skillName } },
      {
        id: AGENT_NODE_ID,
        type: RUN_AGENT_NODE_TYPE,
        config: { agentId: plan.agentId },
        in: { task: `${TASK_NODE_ID}.task`, instructions: `${SKILL_NODE_ID}.instructions` },
      },
    );
    artifactNodeId = AGENT_NODE_ID;
    if (plan.linkTrajectory) {
      nodes.push(
        {
          id: SESSION_NODE_ID,
          type: SESSION_LINK_NODE_TYPE,
          config: plan.sessionLink ?? {},
          in: { execution_ref: `${AGENT_NODE_ID}.execution_ref` },
        },
        {
          id: SKILL_USE_NODE_ID,
          type: SKILL_USE_OBSERVE_NODE_TYPE,
          in: {
            instructions: `${SKILL_NODE_ID}.instructions`,
            trajectory: `${SESSION_NODE_ID}.trajectory`,
          },
        },
        {
          id: ARTIFACT_COMPLETE_NODE_ID,
          type: ARTIFACT_COMPLETE_NODE_TYPE,
          in: {
            artifact: `${AGENT_NODE_ID}.artifact`,
            execution_ref: `${AGENT_NODE_ID}.execution_ref`,
          },
          // Ordered, not wired: the session link excuses itself when indexing never
          // catches up, and the answer must still reach its judges when it does.
          after: [SESSION_NODE_ID],
        },
      );
      trajectoryNodeId = SESSION_NODE_ID;
      artifactNodeId = ARTIFACT_COMPLETE_NODE_ID;
    }
  } else if (plan.source === "session") {
    nodes.push({
      id: SOURCE_NODE_ID,
      type: SESSION_ARTIFACT_NODE_TYPE,
      in: { task: `${TASK_NODE_ID}.task` },
    });
    artifactNodeId = SOURCE_NODE_ID;
    trajectoryNodeId = SOURCE_NODE_ID;
  } else {
    nodes.push({
      id: SOURCE_NODE_ID,
      type: FOLDER_ARTIFACT_NODE_TYPE,
      in: { task: `${TASK_NODE_ID}.task` },
    });
    artifactNodeId = SOURCE_NODE_ID;
  }

  const usedIds = new Set(nodes.map((node) => node.id));
  const skippedEvaluatorIds: string[] = [];
  for (const evaluator of plan.evaluators) {
    if (judgesTrajectory(evaluator) && !trajectoryNodeId) {
      skippedEvaluatorIds.push(evaluator.id);
      continue;
    }
    const id = evaluatorNodeId(evaluator.id, usedIds);
    usedIds.add(id);
    nodes.push(judgeNodeSpec(id, evaluator, artifactNodeId, trajectoryNodeId));
  }

  return {
    spec: { name: `evaluation-case:${plan.task.caseId}`, version: 1, nodes },
    skippedEvaluatorIds,
  };
}

/** Node type and config for an evaluator, independent of how it is wired. */
export function judgeNodeType(evaluator: EvaluationPlanEvaluator): string {
  if (evaluator.kind === "tool_failures") return TOOL_FAILURE_JUDGE_NODE_TYPE;
  if (evaluator.kind === "trajectory_budget") return TRAJECTORY_BUDGET_JUDGE_NODE_TYPE;
  if (evaluator.kind === "llm_judge") return LLM_JUDGE_NODE_TYPE;
  if (evaluator.kind === "script") {
    return evaluator.subject === "trajectory"
      ? SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE
      : SCRIPT_JUDGE_NODE_TYPE;
  }
  return DETERMINISTIC_JUDGE_NODE_TYPE;
}

/** The script an evaluator runs, in the shape the node and the runner expect. */
export function evaluatorJudgeScript(
  evaluator: EvaluationPlanEvaluator,
): EvaluationJudgeScript {
  if (evaluator.scriptMode === "command") {
    return {
      mode: "command",
      command: evaluator.command ?? "",
      ...(evaluator.commandArgs && evaluator.commandArgs.length > 0
        ? { args: evaluator.commandArgs }
        : {}),
      ...(evaluator.timeoutMs !== undefined ? { timeoutMs: evaluator.timeoutMs } : {}),
    };
  }
  return {
    mode: "inline_js",
    source: evaluator.script ?? "",
    ...(evaluator.timeoutMs !== undefined ? { timeoutMs: evaluator.timeoutMs } : {}),
  };
}

export function judgeNodeConfig(evaluator: EvaluationPlanEvaluator): Record<string, unknown> {
  const shared = {
    evaluatorId: evaluator.id,
    threshold: evaluator.threshold,
    ...(evaluator.dimension ? { dimension: evaluator.dimension } : {}),
    ...(evaluator.priority ? { priority: evaluator.priority } : {}),
  };
  if (evaluator.kind === "tool_failures") {
    return {
      ...shared,
      ...(evaluator.maxToolFailures !== undefined
        ? { maxToolFailures: evaluator.maxToolFailures }
        : {}),
    };
  }
  if (evaluator.kind === "trajectory_budget") {
    return {
      ...shared,
      ...(evaluator.maxTurns !== undefined ? { maxTurns: evaluator.maxTurns } : {}),
      ...(evaluator.maxToolCalls !== undefined ? { maxToolCalls: evaluator.maxToolCalls } : {}),
      ...(evaluator.maxTotalTokens !== undefined ? { maxTotalTokens: evaluator.maxTotalTokens } : {}),
      ...(evaluator.maxDurationMs !== undefined ? { maxDurationMs: evaluator.maxDurationMs } : {}),
    };
  }
  if (evaluator.kind === "llm_judge") {
    return { ...shared, runtimeId: evaluator.runtimeId ?? "", prompt: evaluator.prompt ?? "" };
  }
  if (evaluator.kind === "script") {
    return { ...shared, script: evaluatorJudgeScript(evaluator) };
  }
  return { ...shared, kind: evaluator.kind };
}

function judgeNodeSpec(
  id: string,
  evaluator: EvaluationPlanEvaluator,
  artifactNodeId: string,
  trajectoryNodeId: string | null,
): EvaluationGraphNodeSpec {
  return {
    id,
    type: judgeNodeType(evaluator),
    config: judgeNodeConfig(evaluator),
    in: judgesTrajectory(evaluator)
      ? {
          trajectory: `${trajectoryNodeId}.trajectory`,
          // A script judging the trajectory still compares it against the task;
          // the built-in tool-failure judge has no use for it.
          ...(evaluator.kind === "script" ? { task: `${TASK_NODE_ID}.task` } : {}),
        }
      : { task: `${TASK_NODE_ID}.task`, artifact: `${artifactNodeId}.artifact` },
  };
}

/**
 * Rewrites a saved graph for one case.
 *
 * Four things a stored graph must not freeze: the case (the task node's config
 * *is* the case), the target agent, the injected skill, and an evaluator's
 * settings. Hydrating them at run time means editing a threshold, a weight or a
 * judge prompt takes effect on the next run instead of silently keeping whatever
 * the graph was saved with.
 */
export function hydrateEvaluationCaseSpec(
  saved: EvaluationGraphSpec,
  context: {
    task: EvaluationTaskValue;
    agentId: string;
    skillName: string | null;
    evaluators: readonly EvaluationPlanEvaluator[];
  },
): EvaluationGraphSpec {
  const evaluatorsById = new Map(context.evaluators.map((item) => [item.id, item]));
  return {
    ...saved,
    nodes: saved.nodes.map((node) => {
      const config = (node.config ?? {}) as Record<string, unknown>;
      if (node.type === TASK_SOURCE_NODE_TYPE) return { ...node, config: context.task };
      if (node.type === RUN_AGENT_NODE_TYPE) {
        const agentId = typeof config.agentId === "string" && config.agentId.trim()
          ? config.agentId
          : context.agentId;
        return { ...node, config: { ...config, agentId } };
      }
      if (node.type === SKILL_PROVISION_NODE_TYPE) {
        const skillName = typeof config.skillName === "string" && config.skillName.trim()
          ? config.skillName
          : context.skillName;
        return { ...node, config: { ...config, skillName } };
      }
      if (
        node.type === DETERMINISTIC_JUDGE_NODE_TYPE
        || node.type === LLM_JUDGE_NODE_TYPE
        || node.type === TOOL_FAILURE_JUDGE_NODE_TYPE
        || node.type === TRAJECTORY_BUDGET_JUDGE_NODE_TYPE
        || node.type === SCRIPT_JUDGE_NODE_TYPE
        || node.type === SCRIPT_TRAJECTORY_JUDGE_NODE_TYPE
      ) {
        const evaluatorId = typeof config.evaluatorId === "string" ? config.evaluatorId : "";
        const evaluator = evaluatorsById.get(evaluatorId);
        // A judge whose evaluator was deleted keeps its saved id and is disabled,
        // so the run reports a skipped step instead of failing to build.
        if (!evaluator) return { ...node, enabled: false, config: { ...config, evaluatorId } };
        return { ...node, config: judgeNodeConfig(evaluator) };
      }
      return node;
    }),
  };
}

/**
 * True when a saved graph carries only its judging half.
 *
 * The head of a graph — the case, the injected skill, the run, the session it
 * produced — is not something a user assembles: it follows from the Runtime, the
 * Skill and the dataset the graph is configured with. A graph saved without a task
 * step is one of those, and its head is derived rather than read back.
 *
 * Graphs authored before that, which stored every step, are detected here and
 * still run exactly as they were stored.
 */
export function isJudgingOnlySpec(spec: EvaluationGraphSpec): boolean {
  return !spec.nodes.some((node) => node.type === TASK_SOURCE_NODE_TYPE);
}

/** The head the graph is configured with, plus whichever judges it saved. */
function judgingOnlyOrHydrated(
  plan: EvaluationCasePlan,
  saved: EvaluationGraphSpec,
): EvaluationCaseSpecResult {
  if (!isJudgingOnlySpec(saved)) {
    return {
      spec: hydrateEvaluationCaseSpec(saved, {
        task: plan.task,
        agentId: plan.agentId,
        skillName: plan.skillName,
        evaluators: plan.evaluators,
      }),
      skippedEvaluatorIds: [],
    };
  }
  const head = buildEvaluationCaseSpec({ ...plan, evaluators: [] });
  const judges = hydrateEvaluationCaseSpec(saved, {
    task: plan.task,
    agentId: plan.agentId,
    skillName: plan.skillName,
    evaluators: plan.evaluators,
  });
  return {
    spec: {
      ...head.spec,
      nodes: [...head.spec.nodes, ...followDerivedArtifact(judges.nodes, head.spec.nodes)],
    },
    skippedEvaluatorIds: head.skippedEvaluatorIds,
  };
}

/**
 * Repoints saved judges at the artifact the derived head now produces.
 *
 * A judging-only graph stores bindings against a head it does not own, and that head
 * is derived again on every run. When it gains the step that completes the artifact,
 * a binding saved as "the agent's artifact" has to follow — otherwise every judge
 * reads the uncompleted value that step exists to replace, and the fix only reaches
 * graphs nobody saves.
 */
function followDerivedArtifact(
  judges: EvaluationGraphNodeSpec[],
  headNodes: readonly EvaluationGraphNodeSpec[],
): EvaluationGraphNodeSpec[] {
  if (!headNodes.some((node) => node.id === ARTIFACT_COMPLETE_NODE_ID)) return judges;
  const stale = `${AGENT_NODE_ID}.artifact`;
  const current = `${ARTIFACT_COMPLETE_NODE_ID}.artifact`;
  const repoint = (binding: EvaluationInputBinding): EvaluationInputBinding => {
    if (typeof binding === "string") return binding === stale ? current : binding;
    return binding.from === stale ? { ...binding, from: current } : binding;
  };
  return judges.map((node) => node.in
    ? {
        ...node,
        in: Object.fromEntries(
          Object.entries(node.in).map(([input, binding]) => [input, repoint(binding)]),
        ),
      }
    : node);
}

export function buildEvaluationCaseGraph(
  plan: EvaluationCasePlan,
  dependencies: EvaluationNodeDependencies,
): { graph: BuiltEvaluationGraph; skippedEvaluatorIds: string[] } {
  const built = plan.savedSpec
    ? judgingOnlyOrHydrated(plan, plan.savedSpec)
    : buildEvaluationCaseSpec(plan);
  return {
    graph: buildEvaluationGraph(
      built.spec,
      createEvaluationNodeRegistry(createEvaluationNodeDefinitions(dependencies)),
    ),
    skippedEvaluatorIds: built.skippedEvaluatorIds,
  };
}

/**
 * Derives a node id from an evaluator id.
 *
 * Evaluator ids are user data and may contain characters a node id cannot — a
 * dot in particular would be read as the producer/port separator in an input
 * binding, silently pointing a judge at a node that does not exist.
 */
export function evaluatorNodeId(evaluatorId: string, taken: ReadonlySet<string>): string {
  const slug = evaluatorId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+/, "") || "evaluator";
  const base = `judge-${slug}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
