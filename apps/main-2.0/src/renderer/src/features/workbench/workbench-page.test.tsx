import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchPage, normalizeWorkbenchCardOrder, reorderWorkbenchCard, type WorkbenchPageProps } from "./workbench-page";
import type { SessionStats } from "../../../../core/types";

const usageStats: SessionStats = {
  total: {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  },
  bySource: [],
  dailyTokenUsage: [],
  previousTotal: null,
  range: { period: "today", since: null, until: 0 },
};

function workbenchProps(): WorkbenchPageProps & { stats: SessionStats };
function workbenchProps(overrides: Partial<WorkbenchPageProps>): WorkbenchPageProps;
function workbenchProps(overrides: Partial<WorkbenchPageProps> = {}): WorkbenchPageProps {
  const noop = vi.fn();
  return {
    stats: { ...usageStats, total: { ...usageStats.total }, range: { ...usageStats.range } },
    statsPeriod: "today", statsRefreshing: false, statsFeedback: null,
    quotas: { generatedAt: "2026-09-20T00:00:00Z", providers: [] }, quotaLoading: false, quotaFeedback: null,
    sessions: [], sessionQuery: "", liveSessionKeys: new Set(), liveDetectionFailed: false,
    platform: "darwin", language: "en", workflows: [], workflowTotalCount: 0, activeWorkflowCount: 0,
    workflowsLoading: false, workflowsError: "Workflow needs attention", runtimes: [], runtimeChannels: [],
    runtimeOverviewAvailable: true, mcpServers: [], memoryEnabled: false,
    memorySnapshot: null, memoryLoading: false, skills: [], skillsLoading: false,
    onStatsPeriodChange: noop, onRefreshStats: noop, onRefreshQuotas: noop,
    onOpenSettings: noop, onSearchSessions: noop, onOpenSession: noop, onResumeSession: noop,
    onShowSessions: noop, onSelectTrendDay: noop, onOpenWorkflow: noop, onNewWorkflow: noop,
    onShowWorkflows: noop, onShowRuntimes: noop, onShowMcp: noop,
    onShowMemories: noop, onShowSkills: noop,
    ...overrides,
  };
}

describe("workbench overview and work entries", () => {
  it("places the overview above work without losing task entries or failure feedback", () => {
    const props = workbenchProps();
    const html = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(html.indexOf("workbench-overview")).toBeLessThan(html.indexOf("workbench-primary-grid"));
    expect(html).toContain('aria-label="Continue work"');
    expect(html).toContain("Workflow needs attention");
    expect(html).toContain("Refresh usage");
    expect(html).toContain('aria-label="Token breakdown"');
    expect(html).toContain("Cache write");
    expect(html).toContain("Cache read");
    expect(html).toContain("Cache hit rate");
    expect(html).toContain("Cache hit rate unavailable");
    expect(html).toContain('aria-label="Token usage by Agent"');
    expect(html).not.toContain('aria-label="Session origin"');
    expect(html).toContain("Refresh model quotas");
    props.stats.total = {
      sessionCount: 2, messageCount: 4, inputTokens: 100, outputTokens: 50,
      cachedInputTokens: 300, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1_000,
    };
    props.stats.previousTotal = {
      sessionCount: 1, messageCount: 2, inputTokens: 50, outputTokens: 50,
      cachedInputTokens: 100, cacheCreationInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 500,
    };
    const compared = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(compared).toContain("Cache hit rate 75%");
    expect(compared).toContain("+100%");
    expect(compared).toContain("+200%");
    expect(compared.match(/workbench-token-delta/g)).toHaveLength(2);
    props.stats.total.cacheCreationInputTokens = 100;
    delete props.stats.previousTotal.cacheCreationInputTokens;
    const newCacheWrites = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(newCacheWrites).toContain('class="workbench-token-delta is-new">NEW</em>');
    expect(newCacheWrites.match(/workbench-token-delta/g)).toHaveLength(3);
    props.stats.previousTotal = null;
    props.statsPeriod = "allTime";
    props.stats.range.period = "allTime";
    const noComparison = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(noComparison).not.toContain("workbench-token-delta");
    props.quotas.providers = [{ provider: "codex", displayName: "Codex", status: "not_configured", quotas: [], detail: "Existing quota guidance" }];
    props.quotaLoading = true;
    const refreshing = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(refreshing).toContain("Existing quota guidance");
    expect(refreshing).toContain("Open settings");
  });

  it("prioritizes sessions/workflows for new layouts without resetting existing custom order", () => {
    expect(normalizeWorkbenchCardOrder(null).slice(0, 2)).toEqual(["sessions", "workflows"]);
    expect(normalizeWorkbenchCardOrder(["skills", "memories", "skills", "unknown"]).slice(0, 2)).toEqual(["skills", "memories"]);
    expect(reorderWorkbenchCard(normalizeWorkbenchCardOrder(null), "skills", "sessions")[0]).toBe("skills");
  });
});

it("drops the retired Chat card while preserving other saved positions", () => {
  expect(normalizeWorkbenchCardOrder(["skills", "chat", "sessions", "workflows", "memories", "runtimes", "mcp"]))
    .toEqual(["skills", "sessions", "workflows", "memories", "runtimes", "mcp"]);
});

it("reports pending usage instead of zero before the first statistics arrive", () => {
  const pending = renderToStaticMarkup(<WorkbenchPage {...workbenchProps({ stats: null })} />);
  expect(pending).toContain("Collecting usage...");
  expect(pending).not.toContain("No source data");
  expect(pending).toContain('aria-label="Sessions: —"');

  const stale = renderToStaticMarkup(<WorkbenchPage {...workbenchProps({
    stats: { ...usageStats, bySource: [{ ...usageStats.total, source: "codex-cli", totalTokens: 1234 }], range: { period: "sevenDay", since: null, until: 0 } },
  })} />);
  expect(stale).toContain("Collecting usage...");
  expect(stale).not.toContain('data-source="codex-cli"');

  const failed = renderToStaticMarkup(<WorkbenchPage {...workbenchProps({
    stats: null,
    statsFeedback: { kind: "error", message: "statistics failed" },
  })} />);
  expect(failed).toContain("Usage unavailable. Try again.");
  expect(failed).not.toContain("Collecting usage...");
});

it.each([null, {
  ...usageStats,
  total: { ...usageStats.total, sessionCount: 7, messageCount: 20, totalTokens: 150 },
  range: { period: "sevenDay" as const, since: null, until: 0 },
}])("keeps unmeasured metrics unavailable after a statistics failure (%j)", (stats) => {
  const html = renderToStaticMarkup(<WorkbenchPage {...workbenchProps({
    stats,
    statsFeedback: { kind: "error", message: "statistics failed" },
  })} />);
  expect(html).toContain("Usage unavailable. Try again.");
  expect(html).not.toContain("Collecting usage...");
  for (const label of ["Sessions", "Messages", "Token"]) {
    expect(html).toContain(`aria-label="${label}: —"`);
  }
});

it.each([false, true])("hides Token details for an unmeasured period (failed=%s)", (failed) => {
  for (const stats of [null, {
    ...usageStats,
    total: { ...usageStats.total, inputTokens: 120, outputTokens: 40, cachedInputTokens: 60, cacheCreationInputTokens: 20 },
    previousTotal: usageStats.total,
    range: { period: "sevenDay" as const, since: null, until: 0 },
  }]) {
    const html = renderToStaticMarkup(<WorkbenchPage {...workbenchProps({
      stats,
      statsFeedback: failed ? { kind: "error", message: "statistics failed" } : null,
    })} />);
    const breakdown = html.slice(html.indexOf('<div class="workbench-usage-breakdown"'), html.indexOf('<div class="workbench-source-usage"'));
    expect(breakdown.match(/<strong>—<\/strong>/g)).toHaveLength(5);
    expect(breakdown).not.toContain("workbench-token-delta");
    expect(breakdown).toContain("Cache hit rate unavailable");
  }
});
