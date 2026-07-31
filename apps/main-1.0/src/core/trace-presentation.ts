import type {
  SessionTraceCategory,
  SessionTraceEvent,
  SessionTraceStatus,
  SessionTraceVisibility,
} from "./types";

export interface SessionTracePresentation {
  category: SessionTraceCategory;
  visibility: SessionTraceVisibility;
}

export function normalizeSessionTraceStatus(value: unknown): SessionTraceStatus | null {
  if (value === "success" || value === "completed") return "completed";
  if (value === "failure" || value === "failed") return "failed";
  if (value === "running" || value === "aborted" || value === "unknown") return value;
  return null;
}

export function tracePresentation(
  event: Pick<SessionTraceEvent, "kind" | "eventType">,
): SessionTracePresentation {
  const eventType = event.eventType || "";
  if (eventType === "codex.turn.started" || eventType === "task_started") {
    return { category: "lifecycle", visibility: "hidden" };
  }
  if (
    eventType === "codex.turn.completed"
    || eventType === "codex.turn.aborted"
    || eventType === "task_complete"
    || eventType === "turn_aborted"
  ) {
    return { category: "lifecycle", visibility: "turn_summary" };
  }
  if (eventType === "codex.reasoning_summary" || eventType === "agent_reasoning") {
    return { category: "reasoning", visibility: "timeline" };
  }
  if (
    eventType === "codex.plan"
    || eventType === "codex.review.entered"
    || eventType === "codex.review.exited"
    || eventType === "codex.goal.updated"
  ) {
    return { category: "annotation", visibility: "timeline" };
  }
  if (eventType.startsWith("codex.collaboration.")) {
    return { category: "collaboration", visibility: "timeline" };
  }
  if (
    eventType === "codex.context.compaction"
    || eventType === "codex.thread.settings"
    || eventType === "codex.thread.rolled_back"
    || eventType === "context_compacted"
    || eventType === "thread_rolled_back"
  ) {
    return { category: "context", visibility: "timeline" };
  }
  return { category: "tool", visibility: "timeline" };
}

function readableJsonText(value: unknown, indent = ""): string | null {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return null;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  if (entries.length === 0) return null;
  const nested = `${indent}  `;
  return entries
    .map(([key, nestedValue]) => {
      if (typeof nestedValue === "string") {
        return nestedValue.includes("\n")
          ? `${indent}${key}:\n${nestedValue}`
          : `${indent}${key}: ${nestedValue}`;
      }
      const rendered = readableJsonText(nestedValue, nested);
      return rendered === null
        ? `${indent}${key}: ${JSON.stringify(nestedValue)}`
        : `${indent}${key}:\n${rendered}`;
    })
    .join("\n");
}

function unescapeJsonFragment(detail: string): string {
  return detail.replaceAll(/\\(["\\/bfnrt])/gu, (match, escape: string) => {
    if (escape === "n") return "\n";
    if (escape === "t") return "\t";
    if (escape === "r") return "\r";
    if (escape === "b" || escape === "f") return match;
    return escape;
  });
}

export function traceDetailText(detail: string): string {
  if (!detail.includes("\\n") && !detail.includes('\\"')) return detail;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return unescapeJsonFragment(detail);
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  if (record?.truncated === true && typeof record.preview === "string") {
    return traceDetailText(record.preview);
  }
  return readableJsonText(parsed) ?? detail;
}

export function traceDurationLabel(attributes: Record<string, unknown> | undefined): string | null {
  const value = attributes?.durationMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
