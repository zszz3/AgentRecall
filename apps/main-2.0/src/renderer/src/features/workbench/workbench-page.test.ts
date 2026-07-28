import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManagedSkill } from "../../../../core/managed-skill-library";
import type { OpenVikingMemorySnapshot } from "../../../../core/openviking-memory";
import type { SessionSearchResult, SessionStats } from "../../../../core/types";
import type { TeamChatRoomSummary } from "../../../../shared/team-chat";
import {
  DEFAULT_WORKBENCH_CARD_ORDER,
  WorkbenchPage,
  normalizeWorkbenchCardOrder,
  reorderWorkbenchCard,
  type WorkbenchPageProps,
} from "./workbench-page";

const workbenchStyles = readFileSync(new URL("../../styles/workbench.css", import.meta.url), "utf8");

const EMPTY_STATS: SessionStats = {
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

function props(overrides: Partial<WorkbenchPageProps> = {}): WorkbenchPageProps {
  return {
    stats: EMPTY_STATS,
    statsPeriod: "today",
    statsRefreshing: false,
    statsFeedback: null,
    quotas: {
      generatedAt: "2026-07-24T00:00:00.000Z",
      providers: [{
        provider: "codex",
        displayName: "Codex",
        status: "supported",
        quotas: [],
      }],
      hiddenProviders: ["claude-code"],
    },
    quotaLoading: false,
    quotaFeedback: null,
    sessions: [],
    sessionQuery: "",
    liveSessionKeys: new Set(),
    liveDetectionFailed: false,
    platform: "darwin",
    language: "zh",
    onStatsPeriodChange: () => undefined,
    onRefreshStats: () => undefined,
    onRefreshQuotas: () => undefined,
    onOpenSettings: () => undefined,
    onSearchSessions: () => undefined,
    onOpenSession: () => undefined,
    onResumeSession: () => undefined,
    onShowSessions: () => undefined,
    onSelectTrendDay: () => undefined,
    workflows: [],
    workflowsLoading: false,
    workflowsError: null,
    onOpenWorkflow: () => undefined,
    onNewWorkflow: () => undefined,
    onShowWorkflows: () => undefined,
    runtimes: [],
    runtimeChannels: [],
    mcpServers: [],
    chatRooms: [],
    onShowRuntimes: () => undefined,
    onShowMcp: () => undefined,
    onShowChat: () => undefined,
    memoryEnabled: true,
    memorySnapshot: null,
    memoryLoading: false,
    skills: [],
    skillsLoading: false,
    onShowMemories: () => undefined,
    onShowSkills: () => undefined,
    ...overrides,
  };
}

describe("WorkbenchPage quotas", () => {
  it("does not render a provider hidden in settings", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props()));

    expect(html).toContain("Codex");
    expect(html).not.toContain("Claude Code");
  });

  it("explains when every quota provider is hidden", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props({
      quotas: {
        generatedAt: "2026-07-24T00:00:00.000Z",
        providers: [],
        hiddenProviders: ["codex", "claude-code"],
      },
    })));

    expect(html).not.toContain("<strong>Codex</strong>");
    expect(html).not.toContain("<strong>Claude Code</strong>");
    expect(html).toContain("额度已在设置中隐藏");
  });
});

describe("WorkbenchPage cards", () => {
  it("shows the requested capability bands in matching reading order", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props()));
    const cardIds = [...html.matchAll(/data-card-id="([^"]+)"/g)].map((match) => match[1]);

    expect(html).toContain("调整布局");
    expect(cardIds).toEqual([
      "sessions",
      "workflows",
      "memories",
      "chat",
      "runtimes",
      "mcp",
      "skills",
    ]);
    expect(html).toContain(">Memory<");
    expect(html).toContain(">Chat<");
    expect(html).toContain(">Runtime<");
    expect(html).toContain(">MCP<");
    expect(html).toContain(">Skills<");
    for (const cardId of ["sessions", "workflows", "memories", "chat"]) {
      expect(html).toMatch(new RegExp(
        `class="workbench-card-slot [^"]*is-secondary[^"]*" data-card-id="${cardId}"`,
      ));
    }
    expect(html.match(/workbench-feature-card-head/g)).toHaveLength(7);
  });

  it("keeps the layout action outside the Electron titlebar drag region", () => {
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props()));

    expect(html).toContain('style="-webkit-app-region:no-drag"');
  });

  it("shows the first thirty sessions in the Workbench preview", () => {
    const sessions: SessionSearchResult[] = Array.from({ length: 35 }, (_, index) => ({
      sessionKey: `codex:session-${index}`,
      rawId: `session-${index}`,
      source: "codex-cli",
      projectPath: "/work/agent-recall",
      filePath: `/fixtures/session-${index}.jsonl`,
      originalTitle: `Session ${index + 1}`,
      firstQuestion: `Question ${index + 1}`,
      timestamp: 1_000 - index,
      fileMtimeMs: 1_000 - index,
      fileSize: 100,
      prUrl: null,
      prNumber: null,
      environmentId: "local",
      environmentKind: "local",
      environmentLabel: "Local",
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      customTitle: null,
      displayTitle: `Session ${index + 1}`,
      favorited: false,
      hidden: false,
      tags: [],
      matchSnippet: null,
      lastOpenedAt: null,
      lastResumedAt: null,
      lastActivityAt: 1_000 - index,
      messageCount: 1,
      aiSummary: null,
      aiSummaryStale: false,
    }));
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props({ sessions })));

    expect(html).toContain("30 条最近会话");
    expect(html).toContain("Session 30");
    expect(html).not.toContain("Session 31");
  });

  it("keeps the thirty-session preview inside a scrollable card", () => {
    expect(workbenchStyles).toMatch(
      /\.workbench-session-list\s*\{[^}]*max-height:\s*160px;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it("shows existing chat groups instead of configured employees", () => {
    const rooms: TeamChatRoomSummary[] = [{
      id: "room-1",
      name: "发布协作群",
      workDir: "/repo",
      archived: false,
      agentCount: 3,
      lastMessage: "准备开始发布检查",
      lastMessageAt: "2026-07-24T08:00:00.000Z",
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T08:00:00.000Z",
    }];
    const html = renderToStaticMarkup(createElement(
      WorkbenchPage,
      props({
        chatRooms: rooms,
      }),
    ));

    expect(html).toContain("1 个聊天群");
    expect(html).toContain("发布协作群");
    expect(html).toContain("3 名员工");
    expect(html).not.toContain("个员工可用");
  });

  it("summarizes managed directories and App Skills", () => {
    const memorySnapshot: OpenVikingMemorySnapshot = {
      runtime: { state: "running", version: "0.2.0" },
      model: { model: "BAAI/bge-small-zh-v1.5", installed: true },
      workspaces: [{
        id: "memory-1",
        userId: "workspace_repo",
        rootPath: "/repo",
        identity: "git:repo",
        displayName: "AgentRecall",
        managed: true,
        importState: "completed",
        importedTurns: 42,
        totalTurns: 42,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T08:00:00.000Z",
      }],
    };
    const skills: ManagedSkill[] = [{
      id: "design-review",
      managedId: "design-review",
      name: "Design Review",
      description: "Review product interfaces.",
      agent: "codex",
      source: "agent-recall-v2",
      path: "/app-skills/design-review/SKILL.md",
      directoryPath: "/app-skills/design-review",
      rootPath: "/app-skills",
      markdown: "# Design Review",
      mtimeMs: 1_000,
      usageCount: 12,
      lastUsedAt: 900,
      origin: { kind: "local", label: "Local", sourcePath: "/source/design-review" },
      installations: [{
        target: "codex",
        path: "/codex/skills/design-review",
        state: "installed",
      }],
    }];
    const html = renderToStaticMarkup(createElement(WorkbenchPage, props({
      memorySnapshot,
      skills,
    })));

    expect(html).toContain("1 个受管理目录");
    expect(html).toContain("AgentRecall");
    expect(html).toContain("42/42 轮");
    expect(html).toContain("1 个本 App Skill");
    expect(html).toContain("Design Review");
    expect(html).toContain("使用 12 次");
  });

  it("normalizes persisted layouts and moves a card without losing any entries", () => {
    expect(normalizeWorkbenchCardOrder(["chat", "sessions", "unknown", "chat"]))
      .toEqual(["chat", "sessions", "workflows", "memories", "runtimes", "mcp", "skills"]);
    expect(reorderWorkbenchCard(DEFAULT_WORKBENCH_CARD_ORDER, "chat", "sessions"))
      .toEqual(["chat", "sessions", "workflows", "memories", "runtimes", "mcp", "skills"]);
  });
});
