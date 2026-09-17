import { localize, type LanguageMode } from "../../language";
import type { EvaluationNodeRecord } from "../../../../automation/contracts";
import { evaluationNodeCatalog } from "../../../../core/evaluation/node-catalog";
import {
  STAGE_SEGMENT_NODE_TYPE,
  STAGE_TRACE_NODE_TYPE,
} from "../../../../core/evaluation/nodes/prepare-nodes";

/**
 * Formatting shared by the Eval pages.
 *
 * Kept separate from the page components so the graph page and the skill page
 * can both use it without importing each other.
 */

export function formatTokens(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  const seconds = value / 1000;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

export function formatRatio(value: number | null): string {
  if (value === null) return "—";
  return `${Math.round(value * 100)}%`;
}

export function runStatusText(language: LanguageMode, status: string): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (status === "completed") return l("Completed", "完成");
  if (status === "failed") return l("Failed", "失败");
  if (status === "cancelled") return l("Cancelled", "已取消");
  if (status === "running") return l("Running", "运行中");
  return l("Pending", "等待中");
}

/**
 * Node types that no longer exist but are recorded in runs already stored.
 *
 * A run is history and is never rewritten, so its rows keep naming the node types
 * that ran at the time; without these a past run would show a raw identifier.
 */
const RETIRED_NODE_LABELS: Record<string, [string, string]> = {
  agent_execute: ["Agent run", "跑模型"],
  evidence_extract: ["Trace", "轨迹提取"],
};

/**
 * Labels come from the node catalog rather than a copy kept here, so renaming a
 * node in the engine cannot leave the run view showing the old name.
 */
const NODE_LABELS: Map<string, [string, string]> = new Map(
  evaluationNodeCatalog().map((entry) => [entry.type, [entry.labelEn, entry.labelZh]]),
);

export function nodeLabel(language: LanguageMode, node: EvaluationNodeRecord): string {
  const label = NODE_LABELS.get(node.nodeType) ?? RETIRED_NODE_LABELS[node.nodeType];
  return label ? localize(language, label[0], label[1]) : node.nodeType;
}

export function nodeStatusText(
  language: LanguageMode,
  status: EvaluationNodeRecord["status"],
): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (status === "pass") return l("done", "完成");
  if (status === "fail") return l("failed", "失败");
  if (status === "excused") return l("excused", "无法判定");
  if (status === "error") return l("error", "出错");
  if (status === "disabled") return l("off", "已停用");
  return l("skipped", "未执行");
}

/**
 * Colour by what the status means, not by severity.
 *
 * Four readings, and keeping them apart is the point of the whole subsystem:
 * green decided and met, red decided and unmet, amber something broke, grey
 * nothing was decided. An excused step is grey rather than red — it says the
 * evaluation could not judge, not that the agent did badly.
 */
export function nodeStatusClass(status: EvaluationNodeRecord["status"]): string {
  if (status === "pass") return "eval-badge-ok";
  if (status === "fail") return "eval-badge-warn";
  if (status === "error") return "eval-badge-attn";
  return "eval-badge-dim";
}

/** Same reading, for a whole run. */
export function runStatusClass(status: string): string {
  if (status === "completed") return "eval-badge-ok";
  if (status === "failed") return "eval-badge-warn";
  if (status === "running" || status === "pending") return "eval-badge-attn";
  return "eval-badge-dim";
}

/**
 * Human wording for why a node produced nothing.
 *
 * The distinction the copy has to preserve: an excused step means the
 * evaluation could not judge, not that the agent did badly.
 */
export function nodeReasonText(language: LanguageMode, reason: string): string {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const known: Record<string, [string, string]> = {
    case_cancelled: ["the run was cancelled", "运行已取消"],
    judge_runtime_not_configured: ["the judge has no Runtime channel", "评判器未配置 Runtime 通道"],
    judge_executor_unavailable: ["no execution Agent for the judge", "评判器没有可用的执行 Agent"],
    judge_output_unparseable: ["the judge did not return usable JSON", "评判器没有返回可解析的 JSON"],
    judge_score_missing: ["the judge returned no score", "评判器没有给出分数"],
    expected_output_missing: ["the case has no expected output", "该用例没有期望输出"],
    skill_not_readable: ["the selected skill could not be read", "读不到所选的 Skill"],
    skill_reader_unavailable: ["skill injection is unavailable", "Skill 注入不可用"],
    runtime_reported_no_session: ["the runtime reported no session", "Runtime 没有返回会话标识"],
    session_not_indexed: ["the session was not indexed in time", "会话尚未完成索引"],
    session_lookup_unavailable: ["session lookup is unavailable", "会话查询不可用"],
    trace_not_available: ["the session trace is unavailable", "读不到会话轨迹"],
    trace_reader_unavailable: ["trace reading is unavailable", "轨迹读取不可用"],
    cancelled_before_session_link: ["cancelled before linking the session", "关联会话前已取消"],
    stage_boundary_not_found: ["nothing matched this stage's pattern", "没有内容命中这个阶段的匹配模式"],
    stage_trace_unavailable: ["the run's trace could not be read", "读不到本次运行的轨迹"],
    stage_trace_names_no_session: ["the run has no session to read", "本次运行没有可读的会话"],
    stage_trace_reader_unavailable: ["stage tracing is unavailable", "阶段轨迹读取不可用"],
    upstream_not_pass: ["an earlier step did not pass", "上游步骤未通过"],
    upstream_skipped: ["an earlier step was skipped", "上游步骤被跳过"],
    not_decided: ["the run ended first", "运行提前结束"],
  };
  const match = known[reason];
  return match ? l(match[0], match[1]) : reason;
}

/** Observation text for the verdict-free skill-use node. */
export function skillUseText(
  language: LanguageMode,
  facts: Record<string, unknown> | undefined,
): string | null {
  if (!facts || facts.injected !== true) return null;
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (facts.used === true) return l("skill was used", "使用了该 Skill");
  if (facts.used === false) return l("skill went unused", "未使用该 Skill");
  return l("skill use is not observable", "无法观测是否使用");
}

/**
 * How to say what opened a stage.
 *
 * The boundary kind decides the wording because the matched value means
 * something different in each: a path, a tool name, or the message that was
 * said. Reading all three as "opened at X" would have a reader look for a file
 * named after a sentence.
 */
function openedAt(language: LanguageMode, boundaryKind: string | null, matched: string): string {
  if (boundaryKind === "tool_called") {
    return localize(language, `opened at the ${matched} call`, `从调用 ${matched} 开始`);
  }
  if (boundaryKind === "message_contains") {
    return localize(
      language,
      `opened where the model said "${matched}"`,
      `从模型说到「${matched}」开始`,
    );
  }
  return localize(language, `opened at ${matched}`, `从 ${matched} 开始`);
}

/** The same, for a stage the run never reached. */
function lookingFor(language: LanguageMode, boundaryKind: string | null, pattern: string): string {
  if (boundaryKind === "tool_called") {
    return localize(language, `looking for a ${pattern} call`, `在找对 ${pattern} 的调用`);
  }
  if (boundaryKind === "message_contains") {
    return localize(
      language,
      `looking for the model to say "${pattern}"`,
      `在找说到「${pattern}」的消息`,
    );
  }
  return localize(language, `looking for ${pattern}`, `在找 ${pattern}`);
}

/**
 * Observation text for the two stage steps, neither of which produces a verdict.
 *
 * The stage's own name leads because every stage step carries the same catalog
 * label: without it, several rows would all read "Stage" and a reader could not
 * tell which one was not found.
 */
export function stageText(
  language: LanguageMode,
  nodeType: string,
  facts: Record<string, unknown> | undefined,
): string | null {
  if (!facts) return null;
  const l = (en: string, zh: string) => localize(language, en, zh);
  if (nodeType === STAGE_TRACE_NODE_TYPE) {
    if (typeof facts.touchCount !== "number") return null;
    const read = typeof facts.toolCallCount === "number"
      ? l(
          `${facts.touchCount} file changes and ${facts.toolCallCount} tool calls read`,
          `读到 ${facts.touchCount} 处文件改动、${facts.toolCallCount} 次工具调用`,
        )
      : l(`${facts.touchCount} file changes read`, `读到 ${facts.touchCount} 处文件改动`);
    return typeof facts.foundCount === "number" && typeof facts.stageCount === "number"
      ? l(
          `${read}; ${facts.foundCount} of ${facts.stageCount} stages found`,
          `${read}，${facts.stageCount} 个阶段里识别到 ${facts.foundCount} 个`,
        )
      : read;
  }
  if (nodeType !== STAGE_SEGMENT_NODE_TYPE) return null;

  const text = (key: string): string | null => {
    const value = facts[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const parts: string[] = [];
  const name = text("stageName");
  if (name) parts.push(name);
  const boundaryKind = text("boundaryKind");
  const matched = text("matched");
  if (matched) {
    parts.push(openedAt(language, boundaryKind, matched));
    if (typeof facts.fileCount === "number") {
      // Cumulative on purpose: this is what the stage handed on to the next one,
      // not a list of what it alone wrote.
      parts.push(l(
        `${facts.fileCount} files by the end of it`,
        `本阶段结束时累计 ${facts.fileCount} 个文件`,
      ));
    }
    if (facts.outputObserved === false) {
      parts.push(l("no text read for this stage", "未读到该阶段的文本"));
    }
  } else {
    // Not found. What it was looking for is the half that says the pattern
    // missed, rather than leaving the reader to guess which stage this was.
    const pattern = text("pattern");
    if (pattern) parts.push(lookingFor(language, boundaryKind, pattern));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * What a port carries, in words.
 *
 * The engine's port names — `task`, `artifact`, `trajectory` — are identifiers, and
 * showing them raw asked the reader to know the engine. Labelled by kind rather
 * than by name so the same thing reads the same way wherever it appears.
 */
const PORT_LABELS: Record<string, [string, string]> = {
  "eval.task": ["Case", "用例"],
  "eval.artifact": ["Output", "产物"],
  "eval.trajectory": ["Trajectory", "轨迹"],
  "eval.instructions": ["Skill text", "Skill 说明"],
  "eval.execution_ref": ["Run id", "运行标识"],
  "eval.stages": ["Stages", "阶段"],
};

const PORT_HINTS: Record<string, [string, string]> = {
  "eval.task": [
    "The case being evaluated: its input, its expected output and any context.",
    "当前被评测的用例：输入、期望输出，以及上下文。",
  ],
  "eval.artifact": [
    "What is being judged: the answer, and any files that came with it. A check bound to a stage gets that stage's window instead of the whole run.",
    "被评判的东西：答案，以及随带的文件。挂在某个阶段上的检查拿到的是那个阶段的窗口，而不是整次运行。",
  ],
  "eval.trajectory": [
    "How the work was done: turns, tool calls, failures, tokens.",
    "做事的过程：轮次、工具调用、失败次数、token。",
  ],
  "eval.instructions": [
    "The Skill text handed to the model with the task.",
    "随任务一起交给模型的 Skill 说明。",
  ],
  "eval.execution_ref": [
    "The runtime's own id for the run, used to find its session.",
    "运行时给这次运行的标识，用来找到对应会话。",
  ],
  "eval.stages": [
    "Where each declared stage of this run opened, and what its own window produced. A stage that never opened is listed as not found.",
    "本次运行各个声明阶段从哪里开始，以及每段窗口各自产出了什么。没有开过的阶段会列成「未识别」。",
  ],
};

export function portLabel(language: LanguageMode, kind: string, name: string): string {
  const label = PORT_LABELS[kind];
  return label ? localize(language, label[0], label[1]) : name;
}

/** The tooltip on a port: what it carries, not what it is called. */
export function portHint(language: LanguageMode, kind: string): string {
  const hint = PORT_HINTS[kind];
  return hint ? localize(language, hint[0], hint[1]) : kind;
}
