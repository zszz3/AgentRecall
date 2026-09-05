import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationPass,
} from "../graph/node";
import {
  ARTIFACT_PORT,
  EXECUTION_REF_PORT,
  INSTRUCTIONS_PORT,
  TASK_PORT,
  TRAJECTORY_PORT,
  type EvaluationNodeDependencies,
  type EvaluationTaskValue,
  type EvaluationTrajectoryValue,
} from "./contracts";

/**
 * Artifact sources and the prepare steps around them.
 *
 * A graph starts at a source, which answers "what is being evaluated": an agent
 * run made now, a session that already happened, or a folder on disk. Whichever
 * it is, judges downstream see the same two ports — the artifact and, when the
 * source has one, the trajectory.
 *
 * None of these may emit a verdict. Their shared discipline: when a step cannot
 * be completed for a reason that has nothing to do with the agent under
 * evaluation, it is `excused`, and the judges then record `pending` with that
 * reason instead of scoring an absence.
 */

export const TASK_SOURCE_NODE_TYPE = "task_source";
export const SKILL_PROVISION_NODE_TYPE = "skill_provision";
export const RUN_AGENT_NODE_TYPE = "run_agent";
export const SESSION_LINK_NODE_TYPE = "session_link";
export const SESSION_ARTIFACT_NODE_TYPE = "session_artifact";
export const FOLDER_ARTIFACT_NODE_TYPE = "folder_artifact";
export const SKILL_USE_OBSERVE_NODE_TYPE = "skill_use_observe";

/** Emits the case under evaluation. Its config is the case itself. */
export const taskSourceNode = defineEvaluationNode<
  Record<string, never>,
  { task: typeof TASK_PORT },
  EvaluationTaskValue
>({
  type: TASK_SOURCE_NODE_TYPE,
  version: 1,
  role: "prepare",
  inputs: {},
  outputs: { task: TASK_PORT },
  async run(context) {
    return evaluationPass({ outputs: { task: context.config } });
  },
});

export interface SkillProvisionConfig {
  /** Null when the experiment injects no skill. */
  skillName: string | null;
}

/**
 * Freezes the selected skill's instructions into this run.
 *
 * The content is read at execution time and reported with its hash, so a run
 * can always be attributed to the exact skill text that produced it rather than
 * to whatever the file says later.
 */
export function createSkillProvisionNode(
  dependencies: Pick<EvaluationNodeDependencies, "readSkill">,
) {
  return defineEvaluationNode<
    Record<string, never>,
    { instructions: typeof INSTRUCTIONS_PORT },
    SkillProvisionConfig
  >({
    type: SKILL_PROVISION_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: {},
    outputs: { instructions: INSTRUCTIONS_PORT },
    async run(context) {
      const skillName = context.config.skillName?.trim();
      if (!skillName) {
        return evaluationPass({ outputs: { instructions: { text: null } } });
      }
      if (!dependencies.readSkill) {
        return evaluationExcused.infra("skill_reader_unavailable", {
          facts: { skillName },
        });
      }
      const skill = await dependencies.readSkill(skillName);
      if (!skill) {
        return evaluationExcused.infra("skill_not_readable", { facts: { skillName } });
      }
      return evaluationPass({
        outputs: {
          instructions: {
            text: skill.content,
            skill: {
              skillName,
              skillHash: skill.hash,
              contentLength: skill.content.length,
            },
          },
        },
        facts: { skillName, skillHash: skill.hash },
      });
    },
  });
}

export interface RunAgentConfig {
  agentId: string;
}

/**
 * Produces the artifact by running the agent once.
 *
 * A throw here means the agent never answered — a missing runtime, a crashed
 * CLI, a cancelled run. That is `excused`, not a zero: an agent that could not
 * be launched has told us nothing, and scoring it as a failure would blame the
 * model for AgentRecall's own plumbing.
 */
export function createRunAgentNode(
  dependencies: Pick<EvaluationNodeDependencies, "runAgent">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT; instructions: typeof INSTRUCTIONS_PORT },
    { artifact: typeof ARTIFACT_PORT; execution_ref: typeof EXECUTION_REF_PORT },
    RunAgentConfig
  >({
    type: RUN_AGENT_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { task: TASK_PORT, instructions: INSTRUCTIONS_PORT },
    outputs: { artifact: ARTIFACT_PORT, execution_ref: EXECUTION_REF_PORT },
    async run(context) {
      const { task, instructions } = context.in;
      try {
        const result = await dependencies.runAgent(
          {
            agentId: context.config.agentId,
            prompt: task.input,
            role: "subject",
            ownerReference: {
              caseId: task.caseId,
              datasetItemId: task.datasetItemId,
              repetition: String(task.repetition),
            },
            ...(instructions.text ? { developerInstructions: instructions.text } : {}),
          },
          context.signal,
        );
        return evaluationPass({
          outputs: {
            artifact: {
              output: result.output,
              origin: { kind: "agent_run" },
              durationMs: result.durationMs,
            },
            execution_ref: result.executionReference ?? {},
          },
          facts: {
            outputLength: result.output.length,
            durationMs: result.durationMs,
            ...(instructions.skill ? { injectedSkill: instructions.skill.skillName } : {}),
            ...(result.executionReference?.sessionId
              ? { runtimeSessionId: result.executionReference.sessionId }
              : {}),
          },
        });
      } catch (cause) {
        return evaluationExcused.infra(
          cause instanceof Error ? cause.message : String(cause),
          { facts: { agentId: context.config.agentId } },
        );
      }
    },
  });
}

export interface SessionLinkConfig {
  /** Lookup attempts while the session file is still being indexed. */
  attempts?: number;
  delayMs?: number;
}

/**
 * Turns a fresh run into a trajectory by finding the session it produced.
 *
 * Indexing is asynchronous, so the session a run just created may not be
 * queryable yet. The node retries within a bound and then excuses itself — it
 * never reports a trajectory it does not have, because a missing one must not
 * read as "this run did no work".
 */
export function createSessionLinkNode(
  dependencies: Pick<EvaluationNodeDependencies, "resolveSession" | "readTrajectory" | "wait">,
) {
  return defineEvaluationNode<
    { execution_ref: typeof EXECUTION_REF_PORT },
    { trajectory: typeof TRAJECTORY_PORT },
    SessionLinkConfig
  >({
    type: SESSION_LINK_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { execution_ref: EXECUTION_REF_PORT },
    outputs: { trajectory: TRAJECTORY_PORT },
    async run(context) {
      const rawId = context.in.execution_ref.sessionId;
      if (!rawId) return evaluationExcused.infra("runtime_reported_no_session");
      if (!dependencies.resolveSession || !dependencies.readTrajectory) {
        return evaluationExcused.infra("session_lookup_unavailable", { facts: { rawId } });
      }
      const attempts = Math.max(1, Math.min(30, context.config.attempts ?? 6));
      const delayMs = Math.max(0, Math.min(10_000, context.config.delayMs ?? 500));
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (context.signal.aborted) {
          return evaluationExcused.infra("cancelled_before_session_link", {
            facts: { rawId, attempt },
          });
        }
        const session = await dependencies.resolveSession(context.in.execution_ref);
        if (session) {
          const trajectory = await dependencies.readTrajectory(session.sessionKey);
          if (!trajectory) {
            return evaluationExcused.infra("trajectory_not_available", {
              facts: { rawId, sessionKey: session.sessionKey },
            });
          }
          return evaluationPass({
            outputs: { trajectory: { ...trajectory, sessionKey: session.sessionKey } },
            facts: { rawId, sessionKey: session.sessionKey, attempt, ...trajectoryFacts(trajectory) },
          });
        }
        if (attempt < attempts && dependencies.wait) await dependencies.wait(delayMs);
      }
      return evaluationExcused.infra("session_not_indexed", { facts: { rawId, attempts } });
    },
  });
}

/**
 * Evaluates a session that already happened, which is the cheap path: nothing is
 * re-run, so a new rubric can be applied to work the agent did days ago.
 */
export function createSessionArtifactNode(
  dependencies: Pick<EvaluationNodeDependencies, "readSessionArtifact" | "readTrajectory">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT },
    { artifact: typeof ARTIFACT_PORT; trajectory: typeof TRAJECTORY_PORT },
    Record<string, never>
  >({
    type: SESSION_ARTIFACT_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { task: TASK_PORT },
    outputs: { artifact: ARTIFACT_PORT, trajectory: TRAJECTORY_PORT },
    async run(context) {
      const sessionKey = context.in.task.artifactRef?.sessionKey?.trim();
      if (!sessionKey) return evaluationExcused.infra("case_names_no_session");
      if (!dependencies.readSessionArtifact || !dependencies.readTrajectory) {
        return evaluationExcused.infra("session_reader_unavailable", { facts: { sessionKey } });
      }
      const artifact = await dependencies.readSessionArtifact(sessionKey);
      if (!artifact) {
        return evaluationExcused.infra("session_not_found", { facts: { sessionKey } });
      }
      const trajectory = await dependencies.readTrajectory(sessionKey);
      if (!trajectory) {
        return evaluationExcused.infra("trajectory_not_available", { facts: { sessionKey } });
      }
      return evaluationPass({
        outputs: {
          artifact: {
            output: artifact.output,
            ...(artifact.files ? { files: artifact.files } : {}),
            origin: { kind: "session", reference: sessionKey },
          },
          trajectory: { ...trajectory, sessionKey },
        },
        facts: { sessionKey, outputLength: artifact.output.length, ...trajectoryFacts(trajectory) },
      });
    },
  });
}

/**
 * Evaluates an artifact folder. There is no trajectory behind a folder, so a
 * graph that also judges trajectory will report those judges as never having
 * run — which is the honest answer rather than a zero.
 */
export function createFolderArtifactNode(
  dependencies: Pick<EvaluationNodeDependencies, "readFolderArtifact">,
) {
  return defineEvaluationNode<
    { task: typeof TASK_PORT },
    { artifact: typeof ARTIFACT_PORT },
    Record<string, never>
  >({
    type: FOLDER_ARTIFACT_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { task: TASK_PORT },
    outputs: { artifact: ARTIFACT_PORT },
    async run(context) {
      const path = context.in.task.artifactRef?.path?.trim();
      if (!path) return evaluationExcused.infra("case_names_no_folder");
      if (!dependencies.readFolderArtifact) {
        return evaluationExcused.infra("folder_reader_unavailable", { facts: { path } });
      }
      const artifact = await dependencies.readFolderArtifact(path);
      if (!artifact) {
        return evaluationExcused.infra("folder_not_readable", { facts: { path } });
      }
      return evaluationPass({
        outputs: {
          artifact: {
            output: artifact.output,
            ...(artifact.files ? { files: artifact.files } : {}),
            origin: { kind: "folder", reference: path },
          },
        },
        facts: { path, fileCount: artifact.files?.length ?? 0 },
      });
    },
  });
}

/**
 * Records whether the injected skill was actually used.
 *
 * Deliberately verdict-free. The supported policy is `available` — the skill is
 * offered, not mandated — so whether the agent reached for it is an observation
 * about the skill's description, and letting it move the score would silently
 * turn an observation into a requirement.
 *
 * `used` is null when usage is not observable for this session at all. Reporting
 * false there would accuse the agent of ignoring a skill on the strength of a
 * missing hook.
 */
export const skillUseObserveNode = defineEvaluationNode<
  { instructions: typeof INSTRUCTIONS_PORT; trajectory: typeof TRAJECTORY_PORT },
  Record<string, never>,
  Record<string, never>
>({
  type: SKILL_USE_OBSERVE_NODE_TYPE,
  version: 1,
  role: "prepare",
  inputs: { instructions: INSTRUCTIONS_PORT, trajectory: TRAJECTORY_PORT },
  outputs: {},
  async run(context) {
    const injected = context.in.instructions.skill;
    if (!injected) return evaluationPass({ facts: { injected: false } });
    const trajectory = context.in.trajectory;
    const used = trajectory.skillUsageObservable
      ? trajectory.usedSkillNames.some(
          (name) => name.trim().toLowerCase() === injected.skillName.trim().toLowerCase(),
        )
      : null;
    return evaluationPass({
      facts: {
        injected: true,
        skillName: injected.skillName,
        skillHash: injected.skillHash,
        observable: trajectory.skillUsageObservable,
        used,
      },
    });
  },
});

function trajectoryFacts(trajectory: EvaluationTrajectoryValue): Record<string, unknown> {
  return {
    turnCount: trajectory.turnCount,
    toolCallCount: trajectory.toolCallCount,
    toolFailureCount: trajectory.toolFailureCount,
    ...(trajectory.totalTokens !== null ? { totalTokens: trajectory.totalTokens } : {}),
  };
}
