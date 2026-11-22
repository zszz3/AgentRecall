import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Plus, Trash2, X } from "lucide-react";

import type { SkillEvalSuite } from "../../../../main/services/skill-service";
import type { ConfiguredAgent, EvaluationEvaluator } from "../../../../automation/contracts";
import {
  isTechnicalWritingSkill,
  TECHNICAL_WRITING_DIMENSIONS,
  TECHNICAL_WRITING_EVAL_CASES,
} from "../../../../automation/engine/shared/evaluation/technical-writing-eval";
import { localize, type LanguageMode } from "../../language";

export function CreateSuiteDialog({
  language,
  skill,
  editing,
  onClose,
  onSaved,
}: {
  language: LanguageMode;
  skill: string;
  editing: SkillEvalSuite | null;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const l = (en: string, zh: string) => localize(language, en, zh);
  const [name, setName] = useState(editing?.name ?? "");
  const [agentId, setAgentId] = useState(editing?.agentId ?? "");
  const [repetitions, setRepetitions] = useState(editing?.repetitions ?? 1);
  const [useBuiltinJudge, setUseBuiltinJudge] = useState(
    editing ? editing.evaluatorIds.some((id) => id.startsWith("builtin-judge-")) : true,
  );
  const [evaluatorIds, setEvaluatorIds] = useState<string[]>(
    editing ? editing.evaluatorIds.filter((id) => !id.startsWith("builtin-judge-")) : [],
  );
  const [cases, setCases] = useState<Array<{ input: string; context: string; expectedOutput: string }>>(
    isTechnicalWritingSkill(skill)
      ? TECHNICAL_WRITING_EVAL_CASES.map((item) => ({
          input: item.input,
          context: item.context,
          expectedOutput: item.expectedOutput,
        }))
      : [{ input: "", context: "", expectedOutput: "" }],
  );
  const [evaluators, setEvaluators] = useState<EvaluationEvaluator[]>([]);
  const [agents, setAgents] = useState<ConfiguredAgent[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextEvaluators, snapshot] = await Promise.all([
          window.sessionSearch.automation.listEvaluationEvaluators(),
          window.sessionSearch.automation.getSnapshot(),
        ]);
        if (cancelled) return;
        // The built-in judge covers auto-provisioned ones, which users should
        // not have to manage by hand.
        setEvaluators(nextEvaluators.filter((item) => item.enabled && !item.id.startsWith("builtin-judge-")));
        setAgents(snapshot.configuredAgents);
        if (!editing) {
          const preferred = snapshot.configuredAgents.find((agent) => agent.managed)
            ?? snapshot.configuredAgents[0];
          if (preferred) setAgentId(preferred.id);
        }
        if (editing) {
          const savedCases = await window.sessionSearch.getSkillEvalSuiteCases(editing.id);
          if (!cancelled && savedCases.length > 0) {
            setCases(savedCases.map((item) => ({
              input: item.input,
              context: item.context ?? "",
              expectedOutput: item.expectedOutput ?? "",
            })));
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editing]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const caseList = cases
        .filter((item) => item.input.trim())
        .map((item) => ({
          input: item.input,
          ...(item.context.trim() ? { context: item.context } : {}),
          ...(item.expectedOutput.trim() ? { expectedOutput: item.expectedOutput } : {}),
        }));
      if (editing) {
        await window.sessionSearch.updateSkillEvalSuite({
          id: editing.id,
          name,
          agentId,
          evaluatorIds,
          useBuiltinJudge,
          repetitions,
          cases: caseList,
        });
      } else {
        await window.sessionSearch.createSkillEvalSuite({
          skill,
          name,
          agentId,
          evaluatorIds,
          useBuiltinJudge,
          repetitions,
          cases: caseList,
        });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  }, [editing, skill, name, agentId, evaluatorIds, useBuiltinJudge, repetitions, cases, onSaved]);

  const canSave = name.trim() && agentId && cases.some((item) => item.input.trim())
    && (useBuiltinJudge || evaluatorIds.length > 0);

  return (
    <div className="eval-suite-dialog-backdrop" onClick={onClose}>
      <div className="eval-suite-dialog" onClick={(event) => event.stopPropagation()}>
        <header>
          <h4>{editing ? l("Edit regression suite", "编辑回归方案") : l("New regression suite", "新建回归方案")} · {skill}</h4>
          <button type="button" onClick={onClose} aria-label={l("Close", "关闭")}>
            <X size={15} />
          </button>
        </header>

        {error ? <p className="eval-error" role="alert">{error}</p> : null}

        <label className="eval-suite-field">
          <span>{l("Suite name", "方案名称")}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={l("e.g. Basic feature regression", "如：基础功能回归")} />
        </label>

        <label className="eval-suite-field">
          <span>{l("Execution Agent", "执行 Agent")}</span>
          <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
            {agents.length === 0 ? <option value="">{l("No execution Agent detected", "未检测到可用 Agent")}</option> : null}
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          {agents.length === 0 ? (
            <p className="eval-muted">{l(
              "Install an agent runtime such as Claude Code or Codex, then reopen this dialog.",
              "请先安装 Claude Code 或 Codex 等 Agent 运行时，再重新打开此对话框。",
            )}</p>
          ) : null}
        </label>

        <div className="eval-suite-field">
          <span>{l("Evaluators", "评分器")}</span>
          <div className="eval-suite-evaluators">
            <label className="eval-suite-evaluator-option">
              <input
                type="checkbox"
                checked={useBuiltinJudge}
                onChange={(event) => setUseBuiltinJudge(event.target.checked)}
              />
              {isTechnicalWritingSkill(skill)
                ? l("Technical tutorial 10-dimension Judge (recommended)", "技术教程十维 Judge（推荐）")
                : l("Built-in LLM Judge (recommended)", "内置 LLM Judge（推荐）")}
            </label>
            {useBuiltinJudge ? (
              <>
                <p className="eval-muted">{l(
                  isTechnicalWritingSkill(skill)
                    ? "One model call returns ten evidenced verdicts; must dimensions are hard requirements."
                    : "Judges each case with the execution Agent's own model. No setup needed; scores may be lenient about style.",
                  isTechnicalWritingSkill(skill)
                    ? "一次模型调用返回十个带证据的维度结论；必须维度属于硬条件。"
                    : "用执行 Agent 同款模型逐条评审，无需任何配置；对文风差异可能偏宽松。",
                )}</p>
                {isTechnicalWritingSkill(skill) ? (
                  <ul className="eval-suite-dimension-contract">
                    {TECHNICAL_WRITING_DIMENSIONS.map((dimension) => (
                      <li key={dimension.name}>
                        <span>{dimension.name}</span>
                        <span className={`eval-dimension-priority is-${dimension.priority}`}>
                          {dimension.priority === "must" ? l("must", "必须") : l("should", "应该")}
                        </span>
                        <small>{dimension.criterion}</small>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : null}
            {evaluators.map((evaluator) => {
              const checked = evaluatorIds.includes(evaluator.id);
              return (
                <label key={evaluator.id} className="eval-suite-evaluator-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setEvaluatorIds((ids) => event.target.checked
                      ? [...ids, evaluator.id]
                      : ids.filter((id) => id !== evaluator.id))}
                  />
                  {evaluator.name}
                </label>
              );
            })}
            {!useBuiltinJudge && evaluators.length === 0 ? (
              <p className="eval-muted">{l(
                "Select at least one evaluator, or keep the built-in judge enabled.",
                "请至少选择一个评分器，或保持内置 Judge 勾选。",
              )}</p>
            ) : null}
          </div>
        </div>

        <label className="eval-suite-field">
          <span>{l("Repetitions per case", "每个用例重复次数")}</span>
          <select value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <div className="eval-suite-field">
          <div className="eval-suite-cases-header">
            <span>{l("Test cases", "测试用例")}</span>
            <button type="button" onClick={() => setCases((items) => [...items, { input: "", context: "", expectedOutput: "" }])}>
              <Plus size={12} />{l("Case", "用例")}
            </button>
          </div>
          {cases.map((item, index) => (
            <div key={index} className="eval-suite-case-row">
              <textarea
                value={item.input}
                placeholder={l(`Use ${skill} to: ...`, `使用 ${skill} 处理：...`)}
                onChange={(event) => setCases((items) => items.map((value, i) => i === index ? { ...value, input: event.target.value } : value))}
              />
              <textarea
                value={item.context}
                placeholder={l("Source material / evidence (optional)", "源码材料 / 证据（可选）")}
                onChange={(event) => setCases((items) => items.map((value, i) => i === index ? { ...value, context: event.target.value } : value))}
              />
              <textarea
                value={item.expectedOutput}
                placeholder={l("Expected output (optional)", "期望输出（可选）")}
                onChange={(event) => setCases((items) => items.map((value, i) => i === index ? { ...value, expectedOutput: event.target.value } : value))}
              />
              <button
                type="button"
                aria-label={l("Remove case", "删除用例")}
                disabled={cases.length <= 1}
                onClick={() => setCases((items) => items.filter((_, i) => i !== index))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <footer>
          <button type="button" className="eval-suite-cancel" onClick={onClose}>{l("Cancel", "取消")}</button>
          <button
            type="button"
            className="eval-suite-save"
            disabled={!canSave || saving}
            onClick={() => void save()}
          >
            {saving ? l("Saving...", "保存中...") : editing ? l("Save", "保存") : l("Create", "创建")}
          </button>
        </footer>
      </div>
    </div>
  );
}
