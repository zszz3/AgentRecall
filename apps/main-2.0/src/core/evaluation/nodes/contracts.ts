import { defineEvaluationPort } from "../graph/ports";

/**
 * Values that flow between evaluation nodes, and the ports that carry them.
 *
 * The head of a graph is an artifact source, and it yields two different things
 * a judge can decide on: the **artifact** (what was produced) and the
 * **trajectory** (how it was produced). Keeping them on separate ports is what
 * lets a graph judge output quality without a trajectory — a folder of files has
 * no session behind it — while a trajectory judge in the same graph reports
 * plainly that its input never arrived instead of scoring a zero.
 *
 * Port kinds are the graph's type system: the builder refuses to feed a
 * trajectory into an artifact input, so a wiring mistake surfaces before any
 * model is called.
 */

export interface EvaluationTaskValue {
  caseId: string;
  datasetItemId: string;
  repetition: number;
  /** What the agent was asked to do; also the requirement a judge compares against. */
  input: string;
  expectedOutput?: string;
  context?: string;
  metadata: Record<string, unknown>;
  /**
   * Artifact this case points at, for sources that evaluate something that
   * already exists. Empty when the graph produces the artifact itself.
   */
  artifactRef?: { sessionKey?: string; path?: string };
}

export interface EvaluationSkillInjection {
  skillName: string;
  /** sha256 of the SKILL.md bytes that were injected. */
  skillHash: string;
  contentLength: number;
}

export interface EvaluationInstructionsValue {
  /** Developer instructions handed to the agent; null when nothing is injected. */
  text: string | null;
  skill?: EvaluationSkillInjection;
}

/**
 * One file the artifact consists of.
 *
 * `status` is relative to the state before the work: a fresh run reports what its
 * tool calls did to each path, a folder artifact reports every file as `added`
 * because there is no before-state to compare against.
 */
export interface EvaluationArtifactFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/**
 * What a run produced. This is the whole of it.
 *
 * Every judge reads this shape and every run stores it, so it is the contract
 * between "the agent did something" and "here is what it is worth". The three
 * origins produce the same shape with different parts filled in, and a judge is
 * entitled to rely on that:
 *
 * | origin      | `output`                   | `files`                        |
 * |-------------|----------------------------|--------------------------------|
 * | `agent_run` | the agent's final answer   | paths its tool calls touched   |
 * | `session`   | the session's last answer  | paths its tool calls touched   |
 * | `folder`    | `output.md` when present   | every file under the folder    |
 *
 * `output` is always a string — empty rather than absent, so a judge never has to
 * distinguish "no answer" from "no artifact". `files` is optional and means "not
 * observed", which is not the same as "nothing was touched": a runtime whose
 * trace carries no tool arguments cannot report paths, and a judge that treats an
 * absent list as an empty one would fail the run for AgentRecall's blind spot.
 */
export interface EvaluationArtifactValue {
  output: string;
  files?: EvaluationArtifactFile[];
  origin: {
    kind: "agent_run" | "session" | "folder";
    /**
     * Where it lives: a folder path, or the session key — which a fresh run also
     * gains once the session-link step has found the session it produced.
     */
    reference?: string;
  };
  durationMs?: number;
}

/** Runtime-native ids a fresh run reports, used to find its session. */
export interface EvaluationExecutionReference {
  invocationId?: string;
  sessionId?: string;
  turnId?: string;
}

/** How it was produced: the work the agent actually did. */
export interface EvaluationTrajectoryValue {
  sessionKey?: string;
  turnCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  failedToolNames: string[];
  totalTokens: number | null;
  errorCount: number;
  durationMs?: number;
  /** Names of skills the trace shows the agent actually invoked. */
  usedSkillNames: string[];
  /**
   * False when skill usage cannot be observed for this session at all — the
   * usage hook may not be installed for the agent that ran. An empty
   * `usedSkillNames` then means "unknown", not "the skill went unused".
   */
  skillUsageObservable: boolean;
}

/**
 * One file a run touched, and where in its trace that happened.
 *
 * Recognition stays outside the graph, in the dependency that reads the trace,
 * because it needs the events' arguments — thousands of them on a long session.
 * Only the result crosses in, so a stage node can ask which event first wrote a
 * path without the raw trace ever becoming a port value.
 */
export interface EvaluationFileTouch {
  /** Index of the trace event that made this touch. */
  index: number;
  path: string;
  status: EvaluationArtifactFile["status"];
}

/**
 * How a stage says where it begins.
 *
 * `file_written` is what a run hands on, `tool_called` what it did, and
 * `message_contains` what it announced — a skill that narrates its own stages
 * marks them in prose and may write nothing until the last one.
 */
export type EvaluationStageBoundaryKind =
  | "file_written"
  | "tool_called"
  | "message_contains";

/** One tool call, and where in the trace it happened. */
export interface EvaluationToolCall {
  /** Index of the trace event that made this call. */
  index: number;
  /** Lowercase name, as `toolCalledByEvent` reads it. */
  tool: string;
}

/**
 * What a stage boundary can read off a run's trace.
 *
 * One pass, two projections: the files a run wrote and the tools it called are
 * the same events seen two ways, so reading them through separate readers would
 * query one session's whole trace once per kind of boundary a plan declares. The
 * assistant text is not here — it lives in another table and its position is a
 * message's place relative to the events, not an event of its own.
 */
export interface EvaluationStageTrace {
  /** File touches, in trace order. Empty is an answer: nothing was written. */
  touches: EvaluationFileTouch[];
  /** Tool calls, in trace order. */
  tools: EvaluationToolCall[];
}

/**
 * One assistant message, placed at the trace position it follows.
 *
 * A stage's window is a range of trace positions, so this is what lets the text a
 * stage produced be told apart from the text the run produced. `-1` means the
 * message came before every trace event, which is where a skill that announces a
 * stage before doing anything in it puts that announcement — so it can open the
 * first stage, and only the first.
 */
export interface EvaluationStageText {
  /** Trace index of the last event before the message; -1 when there was none. */
  index: number;
  text: string;
}

/**
 * One declared stage of a run, and what its window produced.
 *
 * The window is `[fromIndex, toIndex)`: a stage owns the boundary event that
 * opened it and everything up to the one that opened the next stage *that was
 * found*. `files` is the cumulative state at the end of that window rather than
 * only the paths the window wrote, because the next stage reads the world and
 * not a diff — this is what the stage handed on.
 *
 * A stage nobody's run matched is kept in the list with `fromIndex: null`
 * instead of being dropped, so the stages after it are still bounded by a real
 * window and the one that is missing says so for itself.
 */
export interface EvaluationStageArtifact {
  stageId: string;
  name: string;
  /** The declared pattern, kept because it is all a stage that was not found can show. */
  pattern: string;
  /** Index of the trace event that opened this stage; null when nothing matched. */
  fromIndex: number | null;
  /**
   * What the boundary matched, in the terms of its own kind: a path, a tool name,
   * or the message that contained the pattern. It is why the stage opened here,
   * and with `boundaryKind` it is what a report shows for a stage that was found.
   */
  matched: string | null;
  /** How this stage said where it begins. */
  boundaryKind: EvaluationStageBoundaryKind;
  /** Exclusive. Absent for the last stage found, whose window runs to the end. */
  toIndex?: number;
  files: EvaluationArtifactFile[];
  /**
   * The assistant text inside the window. Absent means it was not observed,
   * which is not the same as the stage having produced no text.
   */
  output?: string;
}

export const TASK_PORT = defineEvaluationPort<EvaluationTaskValue>("eval.task");
export const INSTRUCTIONS_PORT =
  defineEvaluationPort<EvaluationInstructionsValue>("eval.instructions");
export const ARTIFACT_PORT = defineEvaluationPort<EvaluationArtifactValue>("eval.artifact");
export const EXECUTION_REF_PORT =
  defineEvaluationPort<EvaluationExecutionReference>("eval.execution_ref");
export const TRAJECTORY_PORT =
  defineEvaluationPort<EvaluationTrajectoryValue>("eval.trajectory");
/**
 * Every declared stage of the run, found or not, in declared order.
 *
 * One value for the whole segmentation rather than one per stage: a stage's
 * window ends where the next one opens, so no stage can say what it produced
 * until all of them have been looked for. Each stage step reads this list and
 * takes its own entry, which is also what keeps a stage that was not found from
 * costing the stages around it their judgment.
 */
export const STAGES_PORT =
  defineEvaluationPort<readonly EvaluationStageArtifact[]>("eval.stages");

/** A judge implemented as code the user wrote. */
export type EvaluationJudgeScript =
  | {
      mode: "inline_js";
      /** Function body evaluated with task, artifact and trajectory in scope. */
      source: string;
      timeoutMs?: number;
    }
  | {
      mode: "command";
      command: string;
      args?: string[];
      /** Working directory for the command; the app's default when unset. */
      cwd?: string;
      timeoutMs?: number;
    };

/** What a judge script is given, and what it must return. */
export interface EvaluationJudgeScriptInput {
  script: EvaluationJudgeScript;
  task: EvaluationTaskValue;
  artifact?: EvaluationArtifactValue;
  trajectory?: EvaluationTrajectoryValue;
  signal?: AbortSignal;
}

export interface EvaluationJudgeScriptVerdict {
  /** 0..1; values outside the range are clamped. */
  score: number;
  /** Overrides the evaluator's dimension, so one script can score several. */
  dimension?: string;
  reason?: string;
  evidence?: string[];
  failedCriteria?: string[];
}

/** Dependencies the node implementations need from the host process. */
export interface EvaluationNodeDependencies {
  /** Reads the current SKILL.md bytes and their hash for an installed skill. */
  readSkill?: (
    skillName: string,
  ) => Promise<{ content: string; hash: string } | null>;
  runAgent: (
    input: {
      agentId: string;
      prompt: string;
      developerInstructions?: string;
      role: string;
      ownerReference: Record<string, string>;
    },
    signal?: AbortSignal,
  ) => Promise<{
    output: string;
    durationMs: number;
    executionReference?: EvaluationExecutionReference;
  }>;
  executeJudge?: (
    input: {
      runtimeId: string;
      prompt: string;
      role: string;
      ownerReference: Record<string, string>;
    },
    signal?: AbortSignal,
  ) => Promise<{ output: string; durationMs: number }>;
  /** Resolves an exact Runtime invocation to an indexed AgentRecall session. */
  resolveSession?: (reference: EvaluationExecutionReference) => Promise<{ sessionKey: string } | null>;
  /** Reads an indexed session's trajectory. */
  readTrajectory?: (sessionKey: string) => Promise<EvaluationTrajectoryValue | null>;
  /** Reads a session's final answer, for evaluating a session that already exists. */
  readSessionArtifact?: (
    sessionKey: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  /** Reads an artifact folder from disk. */
  readFolderArtifact?: (
    path: string,
  ) => Promise<{ output: string; files?: EvaluationArtifactFile[] } | null>;
  /**
   * Which files a session's tool calls touched.
   *
   * Separate from `readSessionArtifact` because a fresh run needs it at a
   * different moment: the artifact is produced before the session that recorded
   * it has been found, so the files can only be attached once the session link
   * step has run.
   */
  readArtifactFiles?: (sessionKey: string) => Promise<EvaluationArtifactFile[] | null>;
  /**
   * What a run's trace shows about the files it wrote and the tools it called,
   * read in one pass and keeping where in the trace each one happened — the fold
   * into an end state discards that, and a stage boundary is exactly a position.
   */
  readStageTrace?: (sessionKey: string) => Promise<EvaluationStageTrace | null>;
  /**
   * The assistant text of a session, in trace order.
   *
   * A different question from `readStageTrace` and a different table, so it is its
   * own reader: this is where a stage's window content comes from, and where a
   * stage that opens on something the model said finds its boundary. Null means
   * there was nothing to read at all; an empty list is the honest answer for a
   * session whose assistant said nothing, and a stage whose window held no text is
   * normal rather than broken. With no transcript at all, a stage that opens on a
   * message is simply not found, which is reported rather than guessed at.
   */
  readStageTexts?: (sessionKey: string) => Promise<EvaluationStageText[] | null>;
  /**
   * Runs a judge the user wrote. Any failure of the script itself — a throw, a
   * timeout, output that is not a verdict — must reject, so the judge is excused
   * rather than scoring the agent zero for the script's own bug.
   */
  runJudgeScript?: (
    input: EvaluationJudgeScriptInput,
  ) => Promise<{ verdicts: EvaluationJudgeScriptVerdict[]; durationMs: number }>;
  /** Delay between session-link attempts; injected so tests stay deterministic. */
  wait?: (milliseconds: number) => Promise<void>;
}
