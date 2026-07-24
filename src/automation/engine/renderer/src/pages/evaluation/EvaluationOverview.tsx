import {
  AlertTriangle,
  Beaker,
  CheckCircle2,
  Database,
  Gauge,
  ListChecks,
} from "lucide-react";
import type {
  ConfiguredAgent,
  EvaluationDataset,
  EvaluationEvaluator,
  EvaluationExperiment,
  EvaluationRun,
  EvaluationRunSummary,
} from "../../../../shared/types";
import {
  InlineStatus,
  MetricStrip,
  WorkbenchEmpty,
  WorkbenchSection,
} from "../../ui/workbench/Workbench";

export function EvaluationOverview({
  zh,
  datasets,
  evaluators,
  experiments,
  runs,
  runDetails,
  runTotal,
  agents,
  onCreateExperiment,
}: {
  zh: boolean;
  datasets: EvaluationDataset[];
  evaluators: EvaluationEvaluator[];
  experiments: EvaluationExperiment[];
  runs: EvaluationRunSummary[];
  runDetails: EvaluationRun[];
  runTotal: number;
  agents: ConfiguredAgent[];
  onCreateExperiment: () => void;
}) {
  const completed = runs.filter((run) => run.status === "completed");
  const failedCases = runDetails
    .flatMap((run) => run.results)
    .filter(
      (result) => result.error || result.scores.some((score) => !score.passed),
    );
  const average = completed.length
    ? completed.reduce((sum, run) => sum + (run.averageScore ?? 0), 0) /
      completed.length
    : 0;
  const passRate = completed.length
    ? completed.reduce((sum, run) => sum + (run.passRate ?? 0), 0) /
      completed.length
    : 0;
  return (
    <div className="evaluation-overview">
      <MetricStrip
        items={[
          {
            label: zh ? "数据集" : "Datasets",
            value: String(datasets.length),
            detail: `${datasets.reduce((sum, item) => sum + item.items.length, 0)} cases`,
          },
          {
            label: zh ? "评估器" : "Evaluators",
            value: String(evaluators.length),
            detail: `${evaluators.filter((item) => item.enabled).length} enabled`,
          },
          {
            label: zh ? "平均得分" : "Average score",
            value: completed.length ? average.toFixed(2) : "—",
          },
          {
            label: zh ? "通过率" : "Pass rate",
            value: completed.length ? `${Math.round(passRate * 100)}%` : "—",
            ...(completed.length && passRate >= 0.8
              ? { tone: "success" as const }
              : {}),
          },
        ]}
      />
      <div className="evaluation-overview-grid">
        <WorkbenchSection
          title={zh ? "最近实验" : "Recent experiments"}
          description={
            zh ? "最近执行的 Agent 评测" : "Latest Agent evaluation activity"
          }
        >
          {runs.length ? (
            <div className="workbench-table-wrap">
              <table className="workbench-table">
                <thead>
                  <tr>
                    <th>{zh ? "实验" : "Experiment"}</th>
                    <th>Agent</th>
                    <th>{zh ? "得分" : "Score"}</th>
                    <th>{zh ? "状态" : "Status"}</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.slice(0, 6).map((run) => {
                    const experiment = experiments.find(
                      (item) => item.id === run.experimentId,
                    );
                    const agent = agents.find(
                      (item) => item.id === experiment?.agentId,
                    );
                    return (
                      <tr key={run.id}>
                        <td>
                          <strong>
                            {experiment?.name ?? run.experimentId}
                          </strong>
                          <small>
                            {new Date(run.startedAt).toLocaleString()}
                          </small>
                        </td>
                        <td>{agent?.name ?? experiment?.agentId ?? "-"}</td>
                        <td className="numeric">
                          {run.averageScore?.toFixed(2) ?? "-"}
                        </td>
                        <td>
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
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <WorkbenchEmpty
              icon={<Beaker size={20} />}
              title={zh ? "还没有实验记录" : "No experiment runs yet"}
              description={
                zh
                  ? "创建实验并运行后，质量趋势会出现在这里。"
                  : "Create and run an experiment to start tracking quality."
              }
              actionLabel={zh ? "新建实验" : "New experiment"}
              onAction={onCreateExperiment}
            />
          )}
        </WorkbenchSection>
        <WorkbenchSection
          title={zh ? "需要关注" : "Needs attention"}
          description={
            zh ? "最近运行中未通过的 Case" : "Cases that missed a quality gate"
          }
        >
          {failedCases.length ? (
            <div className="attention-list">
              {failedCases.slice(0, 5).map((result) => (
                <div key={result.id}>
                  <AlertTriangle size={14} />
                  <span>
                    <strong>{result.datasetItemId}</strong>
                    <small>
                      {result.error ??
                        result.scores.find((score) => !score.passed)?.reason ??
                        (zh ? "未达到评估门槛" : "Below evaluator threshold")}
                    </small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="overview-healthy">
              <CheckCircle2 size={22} />
              <strong>
                {zh ? "最近没有失败 Case" : "No recent failing cases"}
              </strong>
              <span>
                {zh
                  ? "运行新的实验后会持续更新。"
                  : "This updates as new experiments finish."}
              </span>
            </div>
          )}
        </WorkbenchSection>
      </div>
      <div className="overview-resource-row">
        <div>
          <Database size={16} />
          <span>{zh ? "数据覆盖" : "Data coverage"}</span>
          <strong>
            {datasets.length
              ? `${datasets.reduce((sum, item) => sum + item.items.length, 0)} cases`
              : "-"}
          </strong>
        </div>
        <div>
          <ListChecks size={16} />
          <span>{zh ? "质量规则" : "Quality gates"}</span>
          <strong>{evaluators.filter((item) => item.enabled).length}</strong>
        </div>
        <div>
          <Gauge size={16} />
          <span>{zh ? "累计运行" : "Total runs"}</span>
          <strong>{runTotal}</strong>
        </div>
      </div>
    </div>
  );
}
