import type { WorkflowV2ReviewTraceEntry } from "../../../../shared/workflow-v2/review";

interface WorkflowReviewTraceProps {
  trace: readonly WorkflowV2ReviewTraceEntry[];
  language?: "en" | "zh";
}

export function WorkflowReviewTrace({ trace, language = "en" }: WorkflowReviewTraceProps) {
  return <div className="workflow-review-trace">
    {trace.map((entry) => <details className={`workflow-review-trace-entry is-${entry.kind}`} key={entry.id} open={entry.kind === "error"}>
      <summary>
        <span>{traceKindLabel(entry.kind, language)}{entry.name ? ` · ${entry.name}` : ""}</span>
        <time>{entry.infrastructureAttempt ? `#${entry.infrastructureAttempt} · ` : ""}{new Date(entry.at).toLocaleString()}</time>
      </summary>
      <pre>{entry.content}</pre>
      {entry.metadata && Object.keys(entry.metadata).length > 0 ? <pre className="is-metadata">{JSON.stringify(entry.metadata, null, 2)}</pre> : null}
    </details>)}
  </div>;
}

function traceKindLabel(kind: WorkflowV2ReviewTraceEntry["kind"], language: "en" | "zh"): string {
  if (language === "zh") {
    const labels: Record<WorkflowV2ReviewTraceEntry["kind"], string> = {
      request: "审查请求",
      response: "审查返回",
      tool_call: "工具调用",
      tool_result: "工具结果",
      system: "系统事件",
      handoff: "任务移交",
      approval_request: "审批请求",
      approval_response: "审批结果",
      user_input_request: "输入请求",
      user_input_response: "输入响应",
      error: "错误",
    };
    return labels[kind];
  }
  return kind.replaceAll("_", " ");
}
