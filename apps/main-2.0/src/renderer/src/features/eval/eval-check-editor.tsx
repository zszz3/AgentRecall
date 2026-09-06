import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Lock, Trash2, X } from "lucide-react";

import type {
  AgentChannel,
  EvaluationEvaluator,
  EvaluatorKind,
} from "../../../../automation/contracts";
import { localize, type LanguageMode } from "../../language";

/**
 * One check, as a form.
 *
 * A check belongs to a dimension but is edited on its own, and it is reachable
 * from both places a dimension is seen: the Dimensions page, where checks are
 * authored, and a plan, where clicking one opens the same form in a dialog. Both
 * render this component, so a threshold means the same thing wherever it is
 * changed.
 *
 * Kinds split into groups that behave differently at run time: the deterministic
 * ones decide from the expected output alone, an LLM judge needs a Runtime
 * channel and a rubric, and a script judge is code the user wrote. None of them
 * can fail a case by breaking — a missing channel, a script that throws, a
 * trajectory that never arrived all report as unscored rather than as a zero, and
 * the form says so where the choice is made.
 */

export const KIND_LABELS: Record<EvaluatorKind, [string, string]> = {
  exact_match: ["Exact match", "精确匹配"],
  contains: ["Contains", "包含"],
  json_valid: ["JSON valid", "JSON 合法性"],
  llm_judge: ["LLM judge", "模型评判"],
  tool_failures: ["Tool failures", "工具失败"],
  trajectory_budget: ["Trajectory budget", "轨迹预算"],
  script: ["Script", "脚本评判"],
};

export const KIND_HINTS: Record<EvaluatorKind, [string, string]> = {
  exact_match: [
    "Needs an expected output; a case without one is reported as undecidable.",
    "需要期望输出；用例没有期望输出时会记为无法判定。",
  ],
  contains: [
    "Passes when the answer contains the expected output.",
    "答案包含期望输出即通过。",
  ],
  json_valid: ["Passes when the answer parses as JSON.", "答案能被解析为 JSON 即通过。"],
  llm_judge: [
    "Needs a Runtime channel. Without one the case is unscored, not failed.",
    "需要 Runtime 通道；没有通道时该用例记为未评分，而不是不通过。",
  ],
  tool_failures: [
    "Judges the trajectory, so it needs a source that has one; a folder artifact does not.",
    "判定轨迹，因此需要有轨迹的产物来源；产物文件夹没有轨迹。",
  ],
  trajectory_budget: [
    "Judges what the work spent against the budgets you set, so it needs a trajectory too. A metric the runtime never reported is skipped, not charged as an overrun.",
    "按你设定的预算判定这次工作的开销，同样需要轨迹。Runtime 没有报告的指标会被跳过，不会算成超支。",
  ],
  script: [
    "Your own code decides. A script that breaks is reported as unscored, never as a zero.",
    "由你自己写的代码判定。脚本本身出错会记为未评分，不会算成 0 分。",
  ],
};

export const BUILTIN_PREFIX = "builtin-judge-";

/** Built-in judges are re-synced from code each run, so edits here would not last. */
export function isManagedCheck(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}

const INLINE_JUDGE_EXAMPLE = `// task / artifact / trajectory are in scope.
// Return a score, or a list of scores to cover several dimensions at once.
const answer = artifact.output.trim();
return {
  score: answer.length <= 200 ? 1 : 0,
  reason: \`answer is \${answer.length} characters\`,
};`;

export function EvalCheckEditor({
  language,
  draft,
  managed,
  channels,
  onChange,
}: {
  language: LanguageMode;
  draft: EvaluationEvaluator;
  managed: boolean;
  channels: readonly AgentChannel[];
  onChange: (next: EvaluationEvaluator) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  return (
    <>
      {managed ? (
        <p className="eval-muted">
          <Lock size={12} />{" "}
          {l(
            "This judge is managed by AgentRecall and is re-synced from code before each run, so edits here would not survive.",
            "这个评判器由 AgentRecall 内置管理，每次运行前都会按代码定义同步，在这里的改动不会保留。",
          )}
        </p>
      ) : null}
      <label className="eval-editor-field">
        <span>{l("Name", "名称")}</span>
        <input
          value={draft.name}
          disabled={managed}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <div className="eval-evaluator-kinds">
        {(Object.keys(KIND_LABELS) as EvaluatorKind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            className={draft.kind === kind ? "active" : ""}
            disabled={managed}
            onClick={() => onChange({ ...draft, kind })}
          >
            <strong>{localize(language, ...KIND_LABELS[kind])}</strong>
            <small>{localize(language, ...KIND_HINTS[kind])}</small>
          </button>
        ))}
      </div>
      <label className="eval-editor-field">
        <span>{l("Pass threshold", "通过阈值")} · {draft.threshold.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={draft.threshold}
          disabled={managed}
          onChange={(event) => onChange({ ...draft, threshold: Number(event.target.value) })}
        />
      </label>
      <div className="eval-editor-row">
        <label className="eval-editor-field">
          <span>{l("Dimension", "维度")}</span>
          <input
            value={draft.dimension ?? ""}
            placeholder={l("defaults to this evaluator", "默认使用本评分器")}
            disabled={managed}
            onChange={(event) => onChange({ ...draft, dimension: event.target.value })}
          />
        </label>
        <label className="eval-editor-field">
          <span>{l("Priority", "重要程度")}</span>
          <select
            value={draft.priority ?? ""}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              priority: event.target.value === ""
                ? undefined
                : event.target.value as "must" | "should",
            })}
          >
            <option value="">{l("(unset)", "（未设置）")}</option>
            <option value="must">{l("must", "必须")}</option>
            <option value="should">{l("should", "应该")}</option>
          </select>
        </label>
      </div>
      <label className="eval-editor-field">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={managed}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        <span>{l("Enabled", "启用")}</span>
      </label>
      {draft.kind === "tool_failures" ? (
        <label className="eval-editor-field">
          <span>{l("Tool failures tolerated", "容许的工具失败次数")}</span>
          <input
            type="number"
            min={0}
            value={draft.maxToolFailures ?? 0}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              maxToolFailures: Math.max(0, Number(event.target.value) || 0),
            })}
          />
        </label>
      ) : null}
      {draft.kind === "script" ? (
        <ScriptJudgeFields
          draft={draft}
          managed={managed}
          language={language}
          onChange={onChange}
        />
      ) : null}
      {draft.kind === "llm_judge" ? (
        <>
          <label className="eval-editor-field">
            <span>{l("Judge Runtime channel", "评判 Runtime 通道")}</span>
            <select
              value={draft.runtimeId ?? ""}
              disabled={managed}
              onChange={(event) => onChange({ ...draft, runtimeId: event.target.value })}
            >
              <option value="">{l("(none — cases stay unscored)", "（未选择 — 用例会记为未评分）")}</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.label} · {channel.agentId}
                </option>
              ))}
            </select>
          </label>
          <label className="eval-editor-field">
            <span>
              {l("Scoring prompt", "评分 Prompt")}
              {" · "}
              {l("placeholders: {{input}} {{output}} {{ground_truth}} {{context}}", "占位符：{{input}} {{output}} {{ground_truth}} {{context}}")}
            </span>
            <textarea
              value={draft.prompt ?? ""}
              rows={10}
              disabled={managed}
              onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
            />
          </label>
        </>
      ) : null}
    </>
  );
}

/**
 * The script judge's own form.
 *
 * The two modes are not interchangeable in what they may do, and the form says
 * which is which: inline JS runs sandboxed with only the case in scope, while a
 * command is a real process and stays behind a setting until it is turned on.
 */
function ScriptJudgeFields({
  draft,
  managed,
  language,
  onChange,
}: {
  draft: EvaluationEvaluator;
  managed: boolean;
  language: LanguageMode;
  onChange: (next: EvaluationEvaluator) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const mode = draft.scriptMode ?? "inline_js";
  const subject = draft.subject ?? "artifact";
  return (
    <>
      <div className="eval-editor-row">
        <label className="eval-editor-field">
          <span>{l("How it runs", "运行方式")}</span>
          <select
            value={mode}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              scriptMode: event.target.value as "inline_js" | "command",
            })}
          >
            <option value="inline_js">{l("Inline JavaScript (sandboxed)", "内联 JavaScript（沙箱）")}</option>
            <option value="command">{l("External command", "外部命令")}</option>
          </select>
        </label>
        <label className="eval-editor-field">
          <span>{l("What it judges", "判定对象")}</span>
          <select
            value={subject}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              subject: event.target.value as "artifact" | "trajectory",
            })}
          >
            <option value="artifact">{l("The artifact", "产物")}</option>
            <option value="trajectory">{l("The trajectory", "轨迹")}</option>
          </select>
        </label>
        <label className="eval-editor-field">
          <span>{l("Timeout (ms)", "超时（毫秒）")}</span>
          <input
            type="number"
            min={100}
            step={100}
            value={draft.timeoutMs ?? (mode === "command" ? 30000 : 5000)}
            disabled={managed}
            onChange={(event) => onChange({
              ...draft,
              timeoutMs: Math.max(100, Number(event.target.value) || 0),
            })}
          />
        </label>
      </div>
      <SubjectShape language={language} subject={subject} />
      {mode === "inline_js" ? (
        <label className="eval-editor-field">
          <span>
            {l("Judge code", "评判代码")}
            {" · "}
            {l(
              "no filesystem, network or modules",
              "没有文件系统、网络和模块",
            )}
          </span>
          <textarea
            className="eval-code-input"
            value={draft.script ?? ""}
            rows={12}
            spellCheck={false}
            placeholder={INLINE_JUDGE_EXAMPLE}
            disabled={managed}
            onChange={(event) => onChange({ ...draft, script: event.target.value })}
          />
        </label>
      ) : (
        <>
          <p className="eval-muted">
            {l(
              "The case arrives as JSON on stdin; print the verdict as JSON on stdout. A command only runs while external script judges are enabled in Settings.",
              "用例以 JSON 从 stdin 进入，判定结果以 JSON 打印到 stdout。只有在设置里允许外部脚本评判时命令才会执行。",
            )}
          </p>
          <div className="eval-editor-row">
            <label className="eval-editor-field">
              <span>{l("Command", "命令")}</span>
              <input
                value={draft.command ?? ""}
                placeholder="/usr/bin/python3"
                disabled={managed}
                onChange={(event) => onChange({ ...draft, command: event.target.value })}
              />
            </label>
            <label className="eval-editor-field">
              <span>{l("Arguments", "参数")} · {l("one per line", "每行一个")}</span>
              <textarea
                value={(draft.commandArgs ?? []).join("\n")}
                rows={3}
                spellCheck={false}
                disabled={managed}
                onChange={(event) => onChange({
                  ...draft,
                  // Split on newlines rather than spaces: an argument may contain
                  // a space, and quoting rules here would be a second thing to
                  // learn for no benefit.
                  commandArgs: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                })}
              />
            </label>
          </div>
        </>
      )}
    </>
  );
}

/**
 * What the judge is handed, field by field.
 *
 * A script judge is written against a shape, so the shape has to be visible
 * where the script is written — otherwise the only way to learn that files carry
 * a status, or that `origin.reference` is empty on a fresh run, is to run the
 * judge and read the error. The fields listed here are the artifact and
 * trajectory contracts in `core/evaluation/nodes/contracts.ts`.
 */
function SubjectShape({
  language,
  subject,
}: {
  language: LanguageMode;
  subject: "artifact" | "trajectory";
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const fields = subject === "artifact"
    ? [
      ["artifact.output", l("the answer, as text", "答案文本")],
      ["artifact.files[]", l("{ path, status: added | modified | deleted }", "{ path, status: added | modified | deleted }")],
      ["artifact.origin.kind", l("agent_run | session | folder", "agent_run | session | folder")],
      ["artifact.origin.reference", l("session key or folder path; empty on a fresh run", "会话 key 或目录路径；新跑一次时为空")],
      ["artifact.durationMs", l("how long producing it took", "产出耗时")],
    ]
    : [
      ["trajectory.turnCount", l("turns the agent took", "轮数")],
      ["trajectory.toolCallCount", l("tool calls made", "工具调用次数")],
      ["trajectory.toolFailureCount", l("of those, how many failed", "其中失败次数")],
      ["trajectory.failedToolNames", l("which tools failed", "失败的工具名")],
      ["trajectory.totalTokens", l("tokens, when the runtime reported them", "token 数，Runtime 报告时才有")],
      ["trajectory.sessionKey", l("the session behind it", "对应的会话 key")],
    ];
  return (
    <div className="eval-subject-shape">
      <span className="eval-subject-shape-title">
        {subject === "artifact"
          ? l("The artifact it is handed", "它拿到的产物")
          : l("The trajectory it is handed", "它拿到的轨迹")}
        {subject === "artifact"
          ? <> · <code>task</code> {l("carries the case's input and expected output", "带着用例的输入与期望输出")}</>
          : null}
      </span>
      <dl>
        {fields.map(([name, hint]) => (
          <div key={name}>
            <dt><code>{name}</code></dt>
            <dd>{hint}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * The same form, in a dialog.
 *
 * A plan is read by dimension, and a dimension's checks are what produce its
 * score, so a threshold that looks wrong is noticed while reading the plan.
 * Editing it there saves a round trip through the Dimensions page.
 */
export function EvalCheckDialog({
  language,
  check,
  channels,
  onClose,
  onSaved,
  onDeleted,
}: {
  language: LanguageMode;
  check: EvaluationEvaluator;
  channels: readonly AgentChannel[];
  onClose: () => void;
  onSaved: (saved: EvaluationEvaluator) => void;
  /** Absent where a check has to be deleted from the page that owns the list. */
  onDeleted?: (id: string) => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [draft, setDraft] = useState<EvaluationEvaluator>({ ...check });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managed = isManagedCheck(check.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(check);

  useEffect(() => {
    setDraft({ ...check });
  }, [check]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await window.sessionSearch.automation.saveEvaluationEvaluator({
        ...draft,
        name: draft.name.trim() || draft.id,
        updatedAt: Date.now(),
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  const remove = useCallback(async () => {
    if (!window.confirm(l(
      `Delete the check "${check.name || check.id}"? Every plan that judges by it loses it.`,
      `删除检查「${check.name || check.id}」？所有用到它的方案都会失去这条判定。`,
    ))) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await window.sessionSearch.automation.deleteEvaluationEvaluator(check.id);
      onDeleted?.(check.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [check.id, check.name, l, onDeleted]);

  return (
    <div
      className="eval-suite-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="eval-suite-dialog eval-check-dialog" role="dialog" aria-modal="true">
        <header>
          <h4>{check.name || check.id}</h4>
          <button type="button" aria-label={l("Close", "关闭")} onClick={onClose}>
            <X size={14} />
          </button>
        </header>
        {error ? <p className="eval-error" role="alert">{error}</p> : null}
        <EvalCheckEditor
          language={language}
          draft={draft}
          managed={managed}
          channels={channels}
          onChange={setDraft}
        />
        <footer>
          {onDeleted && !managed ? (
            <button
              type="button"
              className="eval-icon-button eval-check-delete"
              disabled={saving}
              onClick={() => void remove()}
            >
              <Trash2 size={12} />{l("Delete", "删除")}
            </button>
          ) : null}
          <button type="button" className="eval-suite-cancel" onClick={onClose}>
            {l("Cancel", "取消")}
          </button>
          <button
            type="button"
            className="eval-run-button"
            disabled={saving || managed || !dirty}
            onClick={() => void save()}
          >
            {saving ? l("Saving...", "保存中...") : l("Save", "保存")}
          </button>
        </footer>
      </div>
    </div>
  );
}
