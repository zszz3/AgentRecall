import { ClipboardCheck, Save, Trash2 } from "lucide-react";
import type { AgentChannel, EvaluationEvaluator } from "../../../../shared/types";
import {
  BrowserHeader,
  BrowserItem,
  DetailToolbar,
  InlineStatus,
  WorkbenchEmpty,
  WorkbenchLayout,
  WorkbenchSection,
} from "../../ui/workbench/Workbench";
import { useEntityDraft } from "../../ui/workbench/useEntityDraft";

const KINDS: Array<{
  id: EvaluationEvaluator["kind"];
  label: string;
  description: string;
}> = [
  {
    id: "contains",
    label: "Contains expected",
    description: "Output contains the expected text",
  },
  {
    id: "exact_match",
    label: "Exact match",
    description: "Normalized output equals expected text",
  },
  {
    id: "json_valid",
    label: "Valid JSON",
    description: "Output parses as valid JSON",
  },
  {
    id: "llm_judge",
    label: "LLM Judge",
    description: "A separate Agent scores the result",
  },
];

export function EvaluatorWorkspace({
  zh,
  evaluators,
  selected: persistedSelected,
  channels,
  busy,
  onSelect,
  onCreate,
  onDraftChange,
  onSave,
  onDelete,
}: {
  zh: boolean;
  evaluators: EvaluationEvaluator[];
  selected: EvaluationEvaluator | undefined;
  channels: AgentChannel[];
  busy: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDraftChange?: (value: EvaluationEvaluator) => void;
  onSave: (value: EvaluationEvaluator) => void;
  onDelete: () => void;
}) {
  const [selected, onChange] = useEntityDraft(persistedSelected, onDraftChange);
  return (
    <WorkbenchLayout
      browser={
        <>
          <BrowserHeader
            label={zh ? "评估器" : "Evaluators"}
            actionLabel={zh ? "新建评估器" : "New evaluator"}
            onAdd={onCreate}
          />
          <div className="workbench-browser-list">
            {evaluators.map((item) => (
              <BrowserItem
                key={item.id}
                selected={item.id === selected?.id}
                title={item.name}
                meta={`${KINDS.find((kind) => kind.id === item.kind)?.label ?? item.kind} · ${item.threshold.toFixed(2)}`}
                status={item.enabled ? "success" : "muted"}
                onClick={() => onSelect(item.id)}
              />
            ))}
          </div>
        </>
      }
    >
      {selected ? (
        <>
          <DetailToolbar
            title={selected.name}
            meta={selected.id}
            actions={
              <>
                <InlineStatus tone={selected.enabled ? "success" : "muted"}>
                  {selected.enabled
                    ? zh
                      ? "已启用"
                      : "Enabled"
                    : zh
                      ? "已停用"
                      : "Disabled"}
                </InlineStatus>
                <button
                  className="control-btn compact danger"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={onDelete}
                >
                  <Trash2 size={13} />
                  {zh ? "删除" : "Delete"}
                </button>
                <button
                  className="control-btn compact is-active"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => selected && onSave(selected)}
                >
                  <Save size={13} />
                  {busy === "save"
                    ? zh
                      ? "保存中"
                      : "Saving"
                    : zh
                      ? "保存"
                      : "Save"}
                </button>
              </>
            }
          />
          <div className="workbench-scroll">
            <WorkbenchSection title={zh ? "规则设置" : "Rule settings"}>
              <div className="workbench-form-grid">
                <label>
                  <span>{zh ? "名称" : "Name"}</span>
                  <input
                    value={selected.name}
                    onChange={(event) =>
                      onChange({ ...selected, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>{zh ? "状态" : "Status"}</span>
                  <span className="workbench-toggle-row">
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      onChange={(event) =>
                        onChange({ ...selected, enabled: event.target.checked })
                      }
                    />
                    {selected.enabled
                      ? zh
                        ? "参与新实验"
                        : "Included in new experiments"
                      : zh
                        ? "不参与新实验"
                        : "Excluded from new experiments"}
                  </span>
                </label>
                <label className="is-wide">
                  <span>{zh ? "评估方式" : "Evaluator type"}</span>
                  <div className="evaluator-kind-grid">
                    {KINDS.map((kind) => (
                      <button
                        type="button"
                        key={kind.id}
                        className={selected.kind === kind.id ? "is-active" : ""}
                        onClick={() => onChange({ ...selected, kind: kind.id })}
                      >
                        <strong>{kind.label}</strong>
                        <small>{kind.description}</small>
                      </button>
                    ))}
                  </div>
                </label>
                <label className="is-wide">
                  <span>
                    {zh
                      ? `通过门槛 · ${selected.threshold.toFixed(2)}`
                      : `Pass threshold · ${selected.threshold.toFixed(2)}`}
                  </span>
                  <div className="threshold-control">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={selected.threshold}
                      onChange={(event) =>
                        onChange({
                          ...selected,
                          threshold: Number(event.target.value),
                        })
                      }
                    />
                    <output>{Math.round(selected.threshold * 100)}%</output>
                  </div>
                </label>
              </div>
            </WorkbenchSection>
            {selected.kind === "llm_judge" ? (
              <WorkbenchSection
                title="LLM Judge"
                description={
                  zh
                    ? "Judge 使用独立 Runtime 配置对执行结果评分。"
                    : "The Judge uses a separate Runtime config to score each result."
                }
              >
                <div className="workbench-form-grid">
                  <label>
                    <span>{zh ? "评分 Runtime" : "Judge Runtime"}</span>
                    <select
                      value={selected.runtimeId ?? ""}
                      onChange={(event) =>
                        onChange({ ...selected, runtimeId: event.target.value })
                      }
                    >
                      <option value="">
                        {zh ? "选择 Runtime 配置" : "Select a Runtime config"}
                      </option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.label} · {channel.agentId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="is-wide">
                    <span>
                      {zh ? "完整评分 Prompt" : "Complete scoring prompt"}
                    </span>
                    <textarea
                      className="evaluator-prompt-editor"
                      rows={24}
                      value={selected.prompt ?? ""}
                      placeholder={
                        zh
                          ? "填写完整的 Rubric、评估步骤、评分锚点和输出格式。"
                          : "Define the rubric, evaluation steps, score anchors, and output format."
                      }
                      onChange={(event) =>
                        onChange({ ...selected, prompt: event.target.value })
                      }
                    />
                  </label>
                </div>
              </WorkbenchSection>
            ) : null}
          </div>
        </>
      ) : (
        <WorkbenchEmpty
          icon={<ClipboardCheck size={22} />}
          title={zh ? "还没有评估器" : "No evaluators"}
          description={
            zh
              ? "创建确定性规则或 LLM Judge。"
              : "Create a deterministic rule or LLM Judge."
          }
          actionLabel={zh ? "新建评估器" : "New evaluator"}
          onAction={onCreate}
        />
      )}
    </WorkbenchLayout>
  );
}
