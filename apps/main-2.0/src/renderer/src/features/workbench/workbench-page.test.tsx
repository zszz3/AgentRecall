import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkbenchPage, normalizeWorkbenchCardOrder, reorderWorkbenchCard, type WorkbenchPageProps } from "./workbench-page";

describe("workbench overview and work entries", () => {
  it("places the overview above work without losing task entries or failure feedback", () => {
    const noop = vi.fn();
    const props: WorkbenchPageProps = {
      stats: { total: { sessionCount: 0, messageCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
        bySource: [], dailyTokenUsage: [], range: { period: "today", since: null, until: 0 }, previousTotal: null },
      statsPeriod: "today", statsOrigin: "all", statsRefreshing: false, statsFeedback: null,
      quotas: { generatedAt: "2026-09-20T00:00:00Z", providers: [] }, quotaLoading: false, quotaFeedback: null,
      sessions: [], sessionQuery: "", liveSessionKeys: new Set(), liveDetectionFailed: false,
      platform: "darwin", language: "en", workflows: [], workflowTotalCount: 0, activeWorkflowCount: 0,
      workflowsLoading: false, workflowsError: "Workflow needs attention", runtimes: [], runtimeChannels: [],
      runtimeOverviewAvailable: true, mcpServers: [], chatRooms: [], memoryEnabled: false,
      memorySnapshot: null, memoryLoading: false, skills: [], skillsLoading: false,
      onStatsPeriodChange: noop, onStatsOriginChange: noop, onRefreshStats: noop, onRefreshQuotas: noop,
      onOpenSettings: noop, onSearchSessions: noop, onOpenSession: noop, onResumeSession: noop,
      onShowSessions: noop, onSelectTrendDay: noop, onOpenWorkflow: noop, onNewWorkflow: noop,
      onShowWorkflows: noop, onShowRuntimes: noop, onShowMcp: noop, onShowChat: noop,
      onShowMemories: noop, onShowSkills: noop,
    };
    const html = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(html.indexOf("workbench-overview")).toBeLessThan(html.indexOf("workbench-primary-grid"));
    expect(html).toContain('aria-label="Continue work"');
    expect(html).toContain("Workflow needs attention");
    expect(html).toContain("Refresh usage");
    expect(html).toContain("Refresh model quotas");
    props.quotas.providers = [{ provider: "codex", displayName: "Codex", status: "not_configured", quotas: [], detail: "Existing quota guidance" }];
    props.quotaLoading = true;
    const refreshing = renderToStaticMarkup(<WorkbenchPage {...props} />);
    expect(refreshing).toContain("Existing quota guidance");
    expect(refreshing).toContain("Open settings");
  });

  it("prioritizes sessions/workflows/chat for new layouts without resetting existing custom order", () => {
    expect(normalizeWorkbenchCardOrder(null).slice(0, 3)).toEqual(["sessions", "workflows", "chat"]);
    expect(normalizeWorkbenchCardOrder(["skills", "memories", "skills", "unknown"]).slice(0, 2)).toEqual(["skills", "memories"]);
    expect(reorderWorkbenchCard(normalizeWorkbenchCardOrder(null), "chat", "sessions")[0]).toBe("chat");
  });
});
