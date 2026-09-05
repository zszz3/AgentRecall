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

export const TASK_PORT = defineEvaluationPort<EvaluationTaskValue>("eval.task");
export const INSTRUCTIONS_PORT =
  defineEvaluationPort<EvaluationInstructionsValue>("eval.instructions");
export const ARTIFACT_PORT = defineEvaluationPort<EvaluationArtifactValue>("eval.artifact");
export const EXECUTION_REF_PORT =
  defineEvaluationPort<EvaluationExecutionReference>("eval.execution_ref");
export const TRAJECTORY_PORT =
  defineEvaluationPort<EvaluationTrajectoryValue>("eval.trajectory");

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
