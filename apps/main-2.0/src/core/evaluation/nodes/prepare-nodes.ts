import {
  defineEvaluationNode,
  evaluationExcused,
  evaluationPass,
} from "../graph/node";
import { artifactFilesEndState } from "../artifact-files";
import {
  ARTIFACT_PORT,
  EXECUTION_REF_PORT,
  INSTRUCTIONS_PORT,
  STAGES_PORT,
  TASK_PORT,
  TRAJECTORY_PORT,
  type EvaluationArtifactValue,
  type EvaluationFileTouch,
  type EvaluationNodeDependencies,
  type EvaluationStageArtifact,
  type EvaluationStageText,
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
export const ARTIFACT_COMPLETE_NODE_TYPE = "artifact_complete";
export const SESSION_ARTIFACT_NODE_TYPE = "session_artifact";
export const FOLDER_ARTIFACT_NODE_TYPE = "folder_artifact";
export const SKILL_USE_OBSERVE_NODE_TYPE = "skill_use_observe";
export const STAGE_TRACE_NODE_TYPE = "stage_trace";
export const STAGE_SEGMENT_NODE_TYPE = "stage_segment";

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
 * What a completed fresh-run artifact is: the files its session shows, plus where
 * it lives.
 *
 * One rule, two callers — the graph step below and the report path that reads a
 * case afterwards — so a judge and a reader cannot disagree about what the run
 * produced. A reader that fails is ignored on purpose: files are an observation,
 * and losing one must not cost the case its answer.
 */
export async function attachArtifactFiles(
  artifact: EvaluationArtifactValue,
  sessionKey: string,
  readArtifactFiles: EvaluationNodeDependencies["readArtifactFiles"],
): Promise<EvaluationArtifactValue> {
  let files = artifact.files;
  if (!files && readArtifactFiles) {
    try {
      files = (await readArtifactFiles(sessionKey)) ?? undefined;
    } catch {
      // An unreadable trace is a missing observation, not a defect in the run.
      files = undefined;
    }
  }
  return {
    ...artifact,
    ...(files && files.length > 0 ? { files } : {}),
    // A fresh run's artifact does live somewhere once it has been linked, and a
    // reader that cannot say where would send anyone verifying a score back to
    // the run log.
    origin: { ...artifact.origin, reference: sessionKey },
  };
}

/**
 * Completes a fresh run's artifact inside the graph, so a judge reads the same
 * artifact the report does.
 *
 * Ordered *after* the session-link step rather than wired to it. That step excuses
 * itself when indexing never catches up, and an excused producer stores no value,
 * so an input bound to it would leave this step pending — and a pending artifact
 * source costs the case every judge that reads the answer, which is far worse than
 * missing files. So this step resolves the session once more on its own and passes
 * the artifact through untouched when there is none to read.
 *
 * It never excuses and never fails for the same reason: it is a completion step,
 * not a gate.
 */
export function createArtifactCompleteNode(
  dependencies: Pick<EvaluationNodeDependencies, "resolveSession" | "readArtifactFiles">,
) {
  return defineEvaluationNode<
    { artifact: typeof ARTIFACT_PORT; execution_ref: typeof EXECUTION_REF_PORT },
    { artifact: typeof ARTIFACT_PORT },
    Record<string, never>
  >({
    type: ARTIFACT_COMPLETE_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { artifact: ARTIFACT_PORT, execution_ref: EXECUTION_REF_PORT },
    outputs: { artifact: ARTIFACT_PORT },
    async run(context) {
      const artifact = context.in.artifact;
      if (artifact.origin.kind !== "agent_run" || artifact.files) {
        return evaluationPass({ outputs: { artifact } });
      }
      if (!dependencies.resolveSession) {
        return evaluationPass({
          outputs: { artifact },
          facts: { filesObserved: false, reason: "session_lookup_unavailable" },
        });
      }
      let sessionKey: string | null = null;
      try {
        sessionKey = (await dependencies.resolveSession(context.in.execution_ref))?.sessionKey ?? null;
      } catch {
        // Same rule as the reader: this step reports what it could not observe
        // rather than taking the artifact down with it.
        sessionKey = null;
      }
      if (!sessionKey) {
        return evaluationPass({
          outputs: { artifact },
          facts: { filesObserved: false, reason: "session_not_indexed" },
        });
      }
      const completed = await attachArtifactFiles(
        artifact,
        sessionKey,
        dependencies.readArtifactFiles,
      );
      return evaluationPass({
        outputs: { artifact: completed },
        facts: {
          sessionKey,
          filesObserved: completed.files !== undefined,
          ...(completed.files ? { fileCount: completed.files.length } : {}),
        },
      });
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

/** One declared stage, in the shape the segmentation reads. */
export interface StageSegmentTarget {
  stageId: string;
  name: string;
  /**
   * Carried even though only `file_written` exists: the segmentation below
   * matches paths, so a second kind has to change it rather than be ignored.
   */
  boundaryKind: "file_written";
  /** Path pattern. `**` crosses separators, `*` does not, `?` is one character. */
  pattern: string;
}

export interface StageTraceConfig {
  stages: StageSegmentTarget[];
}

export interface StageSegmentConfig {
  stageId: string;
}

/**
 * What a stage's answer is replaced with when its window was never read.
 *
 * The distinction `{{files}}` already keeps: no text observed is not evidence
 * the stage produced none, and a judge that scored an empty answer would be
 * scoring AgentRecall's blind spot instead of the agent.
 */
const STAGE_OUTPUT_NOT_OBSERVED =
  "（未观测到该阶段的文本产出：这段窗口内没有读到模型说的话。缺少证据不等于没有产出，" +
  "不要据此判 0 分。若没有文本就无法判定本维度，返回 score: null 并说明原因。）";

/**
 * How much of one stage's text reaches a judge.
 *
 * A stage of a long run can be most of a long session, and every check bound to
 * it pays for the whole thing. The budget covers the emitted value including the
 * separators and the truncation note.
 */
const MAX_STAGE_TEXT = 12_000;

/**
 * The assistant text inside one stage's window.
 *
 * Stops at the first message that would not fit rather than skipping it and
 * taking a later one: a stage's text reads as a sequence, and a judge handed
 * scattered fragments of it would be judging something the agent never said.
 * What was left out is stated, because a judge that silently got half a stage
 * would read the missing half as the stage having stopped.
 */
function stageWindowText(
  texts: readonly EvaluationStageText[],
  fromIndex: number,
  toIndex: number | undefined,
): string {
  const inside = texts.filter(
    (entry) => entry.index >= fromIndex && (toIndex === undefined || entry.index < toIndex),
  );
  const kept: string[] = [];
  let length = 0;
  let position = 0;
  while (position < inside.length) {
    // The blank line between two messages is emitted too, so it is budgeted too.
    const cost = inside[position]!.text.length + (kept.length > 0 ? 2 : 0);
    if (length + cost > MAX_STAGE_TEXT) break;
    kept.push(inside[position]!.text);
    length += cost;
    position += 1;
  }
  const dropped = inside.length - position;
  if (dropped === 0) return kept.join("\n\n");
  const note = `\n\n…（该阶段另有 ${dropped} 段文本因长度未列入）`;
  return kept.join("\n\n").slice(0, Math.max(0, MAX_STAGE_TEXT - note.length)) + note;
}

/**
 * Cuts one run into the stages it was declared to have.
 *
 * The search is sequential — a stage is only looked for after the one before it
 * opened — but a stage that is not found does not stop the search: the ones after
 * it are looked for after the last stage that *was* found. Not finding a stage is
 * a fact about this run, and letting it erase every later stage would report one
 * unmatched pattern as a much larger failure than it is.
 *
 * A stage that was not found stays in the list rather than being dropped, so the
 * step that presents it can say so for itself.
 */
export function segmentRunIntoStages(
  touches: readonly EvaluationFileTouch[],
  texts: readonly EvaluationStageText[] | null,
  declared: readonly StageSegmentTarget[],
): EvaluationStageArtifact[] {
  const opened: Array<{ index: number; path: string } | null> = [];
  let after = -1;
  for (const stage of declared) {
    const boundary = touches.find(
      (touch) => touch.index > after && matchesStagePattern(touch.path, stage.pattern),
    );
    opened.push(boundary ?? null);
    if (boundary) after = boundary.index;
  }
  return declared.map((stage, position) => {
    const boundary = opened[position]!;
    if (!boundary) {
      return {
        stageId: stage.stageId,
        name: stage.name,
        pattern: stage.pattern,
        fromIndex: null,
        matchedPath: null,
        files: [],
      };
    }
    const next = opened
      .slice(position + 1)
      .find((entry): entry is { index: number; path: string } => entry !== null);
    return {
      stageId: stage.stageId,
      name: stage.name,
      pattern: stage.pattern,
      fromIndex: boundary.index,
      matchedPath: boundary.path,
      ...(next ? { toIndex: next.index } : {}),
      files: artifactFilesEndState(
        touches.filter((touch) => !next || touch.index < next.index),
      ),
      ...(texts ? { output: stageWindowText(texts, boundary.index, next?.index) } : {}),
    };
  });
}

/**
 * Reads a run's trace once and cuts it into the declared stages.
 *
 * Bound to the trajectory rather than resolving the session again: a source with
 * no trajectory cannot be segmented at all, and this step pending is the honest
 * report of that. Pending is safe here in a way it would not be for an artifact
 * step — only the stage steps read this port, so a missing trace costs the
 * segmentation and never the answer's judges.
 *
 * The whole segmentation is computed here rather than stage by stage down a
 * chain, because a stage's window ends where the next one opens, so no stage can
 * say what it produced until all of them have been looked for.
 */
export function createStageTraceNode(
  dependencies: Pick<EvaluationNodeDependencies, "readStageTouches" | "readStageTexts">,
) {
  return defineEvaluationNode<
    { trajectory: typeof TRAJECTORY_PORT },
    { stages: typeof STAGES_PORT },
    StageTraceConfig
  >({
    type: STAGE_TRACE_NODE_TYPE,
    version: 1,
    role: "prepare",
    inputs: { trajectory: TRAJECTORY_PORT },
    outputs: { stages: STAGES_PORT },
    async run(context) {
      const sessionKey = context.in.trajectory.sessionKey?.trim();
      if (!sessionKey) return evaluationExcused.infra("stage_trace_names_no_session");
      if (!dependencies.readStageTouches) {
        return evaluationExcused.infra("stage_touches_reader_unavailable", {
          facts: { sessionKey },
        });
      }
      let touches: EvaluationFileTouch[] | null;
      try {
        touches = await dependencies.readStageTouches(sessionKey);
      } catch (cause) {
        return evaluationExcused.infra(
          cause instanceof Error ? cause.message : String(cause),
          { facts: { sessionKey } },
        );
      }
      if (!touches) {
        return evaluationExcused.infra("stage_trace_unavailable", { facts: { sessionKey } });
      }
      let texts: EvaluationStageText[] | null = null;
      if (dependencies.readStageTexts) {
        try {
          texts = await dependencies.readStageTexts(sessionKey);
        } catch {
          // An unreadable transcript loses the text half of every stage. That is
          // reported rather than excused: the file half is still observable, and
          // a stage's boundary is made of file writes, not of text.
          texts = null;
        }
      }
      const stages = segmentRunIntoStages(touches, texts, context.config.stages);
      return evaluationPass({
        outputs: { stages },
        facts: {
          sessionKey,
          touchCount: touches.length,
          stageCount: stages.length,
          foundCount: stages.filter((stage) => stage.fromIndex !== null).length,
          textsObserved: texts !== null,
        },
      });
    },
  });
}

/**
 * Presents one declared stage as the thing to judge.
 *
 * One step per stage so each gets its own row, status and evidence, and so a
 * stage the run never reached excuses itself without touching the others. What
 * it emits is that stage's window and nothing else: in a check bound to a stage,
 * the answer is what the stage said and the files are what existed when it
 * handed over — which is the whole reason to bind a check to a stage rather than
 * to the run.
 */
export const stageSegmentNode = defineEvaluationNode<
  { stages: typeof STAGES_PORT; trajectory: typeof TRAJECTORY_PORT },
  { artifact: typeof ARTIFACT_PORT },
  StageSegmentConfig
>({
  type: STAGE_SEGMENT_NODE_TYPE,
  version: 1,
  role: "prepare",
  inputs: { stages: STAGES_PORT, trajectory: TRAJECTORY_PORT },
  outputs: { artifact: ARTIFACT_PORT },
  async run(context) {
    const { stageId } = context.config;
    const stage = context.in.stages.find((item) => item.stageId === stageId);
    if (!stage || stage.fromIndex === null) {
      return evaluationExcused.infra("stage_boundary_not_found", {
        facts: {
          stageId,
          ...(stage ? { stageName: stage.name, pattern: stage.pattern } : {}),
        },
      });
    }
    const sessionKey = context.in.trajectory.sessionKey?.trim();
    return evaluationPass({
      outputs: {
        artifact: {
          output: stage.output ?? STAGE_OUTPUT_NOT_OBSERVED,
          // Empty is an observation here rather than a gap: the trace was
          // readable, so nothing written by then is what the stage handed over.
          files: stage.files,
          origin: { kind: "session", ...(sessionKey ? { reference: sessionKey } : {}) },
        },
      },
      facts: {
        stageId: stage.stageId,
        stageName: stage.name,
        pattern: stage.pattern,
        fromIndex: stage.fromIndex,
        matchedPath: stage.matchedPath,
        fileCount: stage.files.length,
        outputObserved: stage.output !== undefined,
        ...(stage.toIndex !== undefined ? { toIndex: stage.toIndex } : {}),
      },
    });
  },
});

/**
 * Whether a touched path matches a stage's pattern.
 *
 * A pattern with no separator is also tried against the path's last segment,
 * because a user who writes `report.md` means the report, wherever the run put
 * it. Separators are normalised first: a touch carries the path a runtime
 * reported, and a Windows runtime reports backslashes.
 */
function matchesStagePattern(path: string, pattern: string): boolean {
  const wanted = pattern.replace(/\\/g, "/");
  const matcher = new RegExp(`^(?:${stagePatternSource(wanted)})$`);
  const touched = path.replace(/\\/g, "/");
  if (matcher.test(touched)) return true;
  if (wanted.includes("/")) return false;
  const separator = touched.lastIndexOf("/");
  return separator >= 0 && matcher.test(touched.slice(separator + 1));
}

function stagePatternSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char !== "*") {
      source += char === "?" ? "[^/]" : char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (pattern[index + 1] !== "*") {
      source += "[^/]*";
      continue;
    }
    // `**/x` has to find a root-level x too, so the separator becomes optional.
    source += pattern[index + 2] === "/" ? "(?:.*/)?" : ".*";
    index += pattern[index + 2] === "/" ? 2 : 1;
  }
  // A run of separator-crossing wildcards matches exactly what one `.*` does, and
  // left as written it backtracks exponentially on a long path that does not
  // match — a user's own pattern would then hang their run with no timeout.
  return source.replace(/(?:\(\?:\.\*\/\)\?|\.\*)+/g, ".*");
}

function trajectoryFacts(trajectory: EvaluationTrajectoryValue): Record<string, unknown> {
  return {
    turnCount: trajectory.turnCount,
    toolCallCount: trajectory.toolCallCount,
    toolFailureCount: trajectory.toolFailureCount,
    ...(trajectory.totalTokens !== null ? { totalTokens: trajectory.totalTokens } : {}),
  };
}
