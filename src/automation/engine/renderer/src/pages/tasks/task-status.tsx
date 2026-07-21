import type { TaskProgress, TaskRun } from "../../../../shared/types";

export type TaskStatusFilterValue = "all" | TaskProgress;

export const TASK_STATUS_FILTERS: Array<{ id: TaskStatusFilterValue; label: string }> = [
  { id: "all", label: "All" },
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "Todo" },
  { id: "in_progress", label: "Working" },
  { id: "in_review", label: "Review" },
  { id: "done", label: "Done" },
];

export function taskStatusCount(tasks: TaskRun[], status: TaskStatusFilterValue): number {
  if (status === "all") return tasks.length;
  return tasks.filter((task) => task.progress === status).length;
}

export function taskProgressLabel(progress: TaskProgress): string {
  return TASK_STATUS_FILTERS.find((item) => item.id === progress)?.label ?? progress;
}

export function TaskStatusFilter({
  tasks,
  value,
  onChange,
}: {
  tasks: TaskRun[];
  value: TaskStatusFilterValue;
  onChange: (value: TaskStatusFilterValue) => void;
}) {
  return (
    <div className="task-progress-filter" aria-label="Task progress">
      {TASK_STATUS_FILTERS.map((filter) => {
        const count = taskStatusCount(tasks, filter.id);
        return (
          <button
            key={filter.id}
            className={`task-progress-option ${value === filter.id ? "is-active" : ""}`}
            onClick={() => onChange(filter.id)}
          >
            <span>{filter.label}</span>
            <strong>{count}</strong>
          </button>
        );
      })}
    </div>
  );
}

export function TaskMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="task-meta-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function TaskStatusChip({ label, tone }: { label: string; tone: string }) {
  return <span className={`task-status-chip task-status-${tone}`}>{label}</span>;
}
