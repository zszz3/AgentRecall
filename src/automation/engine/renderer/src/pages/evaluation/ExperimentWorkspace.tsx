import { Beaker, ChevronDown, Play, Save, Trash2 } from "lucide-react";
import type {
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
} from "../../../../shared/types";
import {
  BrowserHeader,
  BrowserItem,
  DetailToolbar,
  InlineStatus,
  MetricStrip,
  WorkbenchEmpty,
  WorkbenchLayout,
  WorkbenchSection,
} from "../../ui/workbench/Workbench";
import { useEntityDraft } from "../../ui/workbench/useEntityDraft";
import {
  averageCaseScore,
  formatDuration,
  formatPassRate,
  formatScore,
} from "./evaluation-format";

export function ExperimentWorkspace({
  zh,
  experiments,
  selected: persistedSelected,
  datasets,
  evaluators,
  agents,
  runs,
  busy,
  onSelect,
  onCreate,
  onDraftChange,
  onSave,
  onDelete,
  onRun,
}: {
  zh: boolean;
  experiments: EvaluationExperiment[];
  selected: EvaluationExperiment | undefined;
  datasets: EvaluationDataset[];
  evaluators: EvaluationEvaluator[];
  agents: ConfiguredAgent[];
  runs: EvaluationRun[];
  busy: string | undefined;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDraftChange?: (value: EvaluationExperiment) => void;
  onSave: (value: EvaluationExperiment) => void;
  onDelete: () => void;
  onRun: (value: EvaluationExperiment) => void;
}) {
  const [selected, onChange] = useEntityDraft(persistedSelected, onDraftChange);
  const latest = runs[0];
  const selectedAgent = agents.find((item) => item.id === selected?.agentId);
  return (
    <WorkbenchLayout
      browser={
        <>
          <BrowserHeader
            label={zh ? "实验" : "Experiments"}
            actionLabel={zh ? "新建实验" : "New experiment"}
            onAdd={onCreate}
          />
          <div className="workbench-browser-list">
            {experiments.map((item) => {
              const run = runsFor(
                item.id,
                item.id === selected?.id ? runs : [],
              );
              return (
                <BrowserItem
                  key={item.id}
                  selected={item.id === selected?.id}
                  title={item.name}
                  meta={`${datasets.find((dataset) => dataset.id === item.datasetId)?.name ?? (zh ? "未选择数据集" : "No dataset")} · ${item.repetitions}x`}
                  status={
                    run?.status === "completed"
                      ? "success"
                      : run?.status === "failed"
                        ? "danger"
                        : "muted"
                  }
                  onClick={() => onSelect(item.id)}
                />
              );
            })}
          </div>
        </>
      }
    >
      {selected ? (
        <>
          <DetailToolbar
            title={selected.name}
            meta={`${selectedAgent?.name ?? (selected.agentId || (zh ? "未选择 Agent" : "No Agent"))} ${selectedAgent?.revision ? `· v${selectedAgent.revision}` : ""}`}
            actions={
              <>
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
                  className="control-btn compact secondary"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => selected && onSave(selected)}
                >
                  <Save size={13} />
                  {zh ? "保存" : "Save"}
                </button>
                <button
                  className="control-btn compact is-active"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => selected && onRun(selected)}
                >
                  <Play size={13} fill="currentColor" />
                  {busy === "run"
                    ? zh
                      ? "运行中"
                      : "Running"
                    : zh
                      ? "运行实验"
                      : "Run experiment"}
                </button>
              </>
            }
          />
          <div className="workbench-scroll">
            <WorkbenchSection title={zh ? "实验配置" : "Experiment setup"}>
              <div className="experiment-setup-grid">
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
                  <span>{zh ? "目标 Agent" : "Target Agent"}</span>
                  <select
                    value={selected.agentId}
                    onChange={(event) =>
                      onChange({ ...selected, agentId: event.target.value })
                    }
                  >
                    <option value="">
                      {zh ? "选择 Agent" : "Select an Agent"}
                    </option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                        {agent.revision ? ` · v${agent.revision}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{zh ? "数据集" : "Dataset"}</span>
                  <select
                    value={selected.datasetId}
                    onChange={(event) =>
                      onChange({ ...selected, datasetId: event.target.value })
                    }
                  >
                    <option value="">
                      {zh ? "选择数据集" : "Select a dataset"}
                    </option>
                    {datasets.map((dataset) => (
                      <option key={dataset.id} value={dataset.id}>
                        {dataset.name} · {dataset.items.length} cases
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{zh ? "重复次数" : "Repetitions"}</span>
                  <div className="repetition-control">
                    {[1, 2, 3, 4, 5].map((count) => (
                      <button
                        type="button"
                        key={count}
                        className={
                          selected.repetitions === count ? "is-active" : ""
                        }
                        onClick={() =>
                          onChange({ ...selected, repetitions: count })
                        }
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                </label>
              </div>
              <div className="experiment-evaluators">
                <span>{zh ? "评估器" : "Evaluators"}</span>
                <div>
                  {evaluators.map((evaluator) => (
                    <label
                      key={evaluator.id}
                      className={
                        selected.evaluatorIds.includes(evaluator.id)
                          ? "is-active"
                          : ""
                      }
                    >
                      <input
                        type="checkbox"
                        checked={selected.evaluatorIds.includes(evaluator.id)}
                        onChange={(event) =>
                          onChange({
                            ...selected,
                            evaluatorIds: event.target.checked
                              ? [...selected.evaluatorIds, evaluator.id]
                              : selected.evaluatorIds.filter(
                                  (id) => id !== evaluator.id,
                                ),
                          })
                        }
                      />
                      <span>
                        <strong>{evaluator.name}</strong>
                        <small>
                          {evaluator.kind.replaceAll("_", " ")} ·{" "}
                          {Math.round(evaluator.threshold * 100)}%
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </WorkbenchSection>
            {latest ? (
              <>
                <MetricStrip
                  items={[
                    {
                      label: zh ? "平均分" : "Average score",
                      value: formatScore(latest.averageScore),
                    },
                    {
                      label: zh ? "最低分" : "Minimum score",
                      value: formatScore(latest.minimumScore),
                      ...(latest.minimumScore !== undefined &&
                      latest.minimumScore < 0.7
                        ? { tone: "danger" as const }
                        : {}),
                    },
                    {
                      label: zh ? "通过率" : "Pass rate",
                      value: formatPassRate(latest.passRate),
                      tone:
                        latest.passRate !== undefined && latest.passRate >= 0.8
                          ? "success"
                          : "danger",
                    },
                    {
                      label: zh ? "总耗时" : "Duration",
                      value: formatDuration(latest.totalDurationMs),
                      detail: `${latest.results.length} results`,
                    },
                  ]}
                />
                <WorkbenchSection
                  title={zh ? "Case 结果" : "Case results"}
                  description={`${new Date(latest.startedAt).toLocaleString()} · ${latest.agentRevisionId ?? (zh ? "未固定版本" : "No revision snapshot")}`}
                >
                  <div className="workbench-table-wrap">
                    <table className="workbench-table evaluation-results-table">
                      <thead>
                        <tr>
                          <th>Case</th>
                          <th>{zh ? "重复" : "Run"}</th>
                          <th>{zh ? "得分" : "Score"}</th>
                          <th>{zh ? "耗时" : "Duration"}</th>
                          <th>{zh ? "状态" : "Status"}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {latest.results.map((result) => {
                          const score = averageCaseScore(result.scores);
                          const passed =
                            !result.error &&
                            result.scores.every((item) => item.passed);
                          return (
                            <tr key={result.id}>
                              <td>
                                <strong>{result.datasetItemId}</strong>
                                <small>{result.input}</small>
                                <details>
                                  <summary>
                                    <ChevronDown size={12} />
                                    {zh
                                      ? "查看输出和评分"
                                      : "View output and scores"}
                                  </summary>
                                  <div className="result-detail">
                                    <span>Output</span>
                                    <pre>
                                      {result.output || result.error || "-"}
                                    </pre>
                                    {result.scores.map((item) => (
                                      <p key={item.evaluatorId}>
                                        <strong>
                                          {evaluators.find(
                                            (evaluator) =>
                                              evaluator.id === item.evaluatorId,
                                          )?.name ?? item.evaluatorId}
                                        </strong>
                                        <span>
                                          {item.score.toFixed(2)} ·{" "}
                                          {item.passed ? "PASS" : "FAIL"}
                                        </span>
                                        <small>{item.reason}</small>
                                      </p>
                                    ))}
                                  </div>
                                </details>
                              </td>
                              <td className="numeric">#{result.repetition}</td>
                              <td className="numeric strong">
                                {formatScore(score)}
                              </td>
                              <td className="numeric">
                                {formatDuration(result.durationMs)}
                              </td>
                              <td>
                                <InlineStatus
                                  tone={passed ? "success" : "danger"}
                                >
                                  {passed ? "PASS" : "FAIL"}
                                </InlineStatus>
                              </td>
                              <td />
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </WorkbenchSection>
              </>
            ) : (
              <WorkbenchEmpty
                icon={<Beaker size={20} />}
                title={zh ? "实验尚未运行" : "Experiment not run yet"}
                description={
                  zh
                    ? "确认 Agent、数据集和评估器后开始第一次运行。"
                    : "Choose an Agent, dataset, and evaluators, then run the experiment."
                }
              />
            )}
            {runs.length ? (
              <WorkbenchSection title={zh ? "运行历史" : "Run history"}>
                <div className="run-history-list">
                  {runs.map((run) => (
                    <div key={run.id}>
                      <InlineStatus
                        tone={
                          run.status === "completed"
                            ? "success"
                            : run.status === "failed"
                              ? "danger"
                              : "busy"
                        }
                      >
                        {run.status}
                      </InlineStatus>
                      <span>
                        <strong>{formatScore(run.averageScore)}</strong>
                        <small>
                          {formatPassRate(run.passRate)} pass ·{" "}
                          {formatDuration(run.totalDurationMs)}
                        </small>
                      </span>
                      <time>{new Date(run.startedAt).toLocaleString()}</time>
                    </div>
                  ))}
                </div>
              </WorkbenchSection>
            ) : null}
          </div>
        </>
      ) : (
        <WorkbenchEmpty
          icon={<Beaker size={22} />}
          title={zh ? "还没有实验" : "No experiments"}
          description={
            zh
              ? "组合数据集、Agent 和评估器，建立可重复的质量检查。"
              : "Combine a dataset, Agent, and evaluators into a repeatable quality check."
          }
          actionLabel={zh ? "新建实验" : "New experiment"}
          onAction={onCreate}
        />
      )}
    </WorkbenchLayout>
  );
}

function runsFor(
  _experimentId: string,
  runs: EvaluationRun[],
): EvaluationRun | undefined {
  return runs[0];
}
