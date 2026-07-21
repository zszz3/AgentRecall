import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultSettings } from "../../core/platform";
import {
  migrationTargetsForSession,
  migrationTargetsForSource,
  projectDisplayLabel,
  projectSortTimestamp,
  resumeActionLabel,
  resumeRouteMessage,
  sessionSortTimestamp,
  sourceFilterLabel,
  sourceFilters,
  usageStatsDisplayRows,
  hasTokenUsage,
} from "./session-ui";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const sessionRowSource = readFileSync(new URL("./features/search/session-row.tsx", import.meta.url), "utf8");
const detailPanelSource = readFileSync(new URL("./features/session-detail/detail-panel.tsx", import.meta.url), "utf8");

describe("session source labels", () => {
  it("renders structured project labels in both languages", () => {
    expect(projectDisplayLabel({ label: "app", labelKind: "path", labelSuffix: "Local" }, "zh")).toBe("app · Local");
    expect(projectDisplayLabel({ label: "Hermes 重写", labelKind: "codex-task-title", labelSuffix: "07-18" }, "zh")).toBe(
      "Hermes 重写 · 07-18",
    );
    expect(
      projectDisplayLabel(
        { label: "Untitled session", labelKind: "codex-task-untitled", labelSuffix: "07-19 19:25" },
        "zh",
      ),
    ).toBe("未命名会话 · 07-19 19:25");
    expect(
      projectDisplayLabel(
        { label: "Untitled session", labelKind: "codex-task-untitled", labelSuffix: null },
        "en",
      ),
    ).toBe("Untitled session");
  });

  it("uses the structured project label everywhere the selected project is shown", () => {
    expect(appSource).toContain(
      'const selectedProjectLabel = selectedProject ? projectDisplayLabel(selectedProject, language) : ""',
    );
    expect(appSource).toContain("label: selectedProjectLabel");
    expect(appSource).toContain('Search within ${selectedProjectLabel || "project"}');
    expect(appSource).toContain("projectDisplayLabel(project, language)");
  });

  it("uses Codex App wording for App resume actions and results", () => {
    expect(resumeActionLabel("codex-app", "en")).toBe("Opening in Codex");
    expect(resumeActionLabel("codex-app", "zh")).toBe("正在 Codex 中打开");
    expect(resumeRouteMessage({ route: "app" }, "en")).toBe("Codex task opened.");
    expect(resumeRouteMessage({ route: "app" }, "zh")).toBe("已打开 Codex 会话。");
    expect(resumeActionLabel("codex-cli", "en")).toBe("Opening terminal");
  });

  it("routes keyboard, detail, and context-menu actions through Codex-aware Resume UI", () => {
    expect(appSource.match(/resumeActionLabel\(/g)).toHaveLength(4);
    expect(appSource).toContain('showItermAction={IS_MAC && detail.source !== "codex-app"}');
    expect(appSource).toContain('state.session.source !== "codex-app"');
    expect(detailPanelSource).toContain('session.source === "codex-app"');
    expect(detailPanelSource).toContain('l("Open in Codex", "在 Codex 中打开")');
  });

  it("renders structured message hits with role, count, highlighting, and a dedicated open action", () => {
    const sessionRow = sessionRowSource;
    expect(sessionRow).toContain("session.messageMatchCount");
    expect(sessionRow).toContain("matchHits.map");
    expect(sessionRow).toContain("HighlightedSearchText");
    expect(sessionRow).toContain('hit.role === "user"');
    expect(sessionRow).toContain("onOpenMatch(session, hit)");
    expect(sessionRow).toContain("event.stopPropagation()");
    expect(sessionRow).toContain("Matched session title");
    expect(sessionRow).toContain("Matched project path");
  });

  it("keeps Claude Code and Codex as the only first-party source filters", () => {
    const filters = sourceFilters(null);
    const labels = filters.map((filter) => sourceFilterLabel(filter, "en"));
    const zhLabels = filters.map((filter) => sourceFilterLabel(filter, "zh"));

    expect(labels).toEqual(expect.arrayContaining(["All", "Claude Code", "Codex"]));
    expect(zhLabels).toEqual(expect.arrayContaining(["全部", "Claude Code", "Codex"]));
    expect(labels).not.toEqual(expect.arrayContaining(["Claude", "Claude App", "Codex CLI", "Codex App"]));
  });

  it("shows only Claude Code and Codex source filters on a fresh install", () => {
    expect(sourceFilters(defaultSettings).map((filter) => filter.label)).toEqual(["All", "Claude Code", "Codex"]);
  });

  it("shows optional local agent sources only after they are enabled in settings", () => {
    const defaultLabels = sourceFilters(defaultSettings).map((filter) => sourceFilterLabel(filter, "en"));

    expect(defaultLabels).not.toEqual(expect.arrayContaining(["OpenClaw", "Hermes", "OpenCode", "Cursor Agent", "Trae"]));

    const enabledLabels = sourceFilters({
      ...defaultSettings,
      includeOpenClaw: true,
      includeHermes: true,
      includeOpenCode: true,
      includeCursorAgent: true,
      includeTrae: true,
    }).map((filter) => sourceFilterLabel(filter, "en"));

    expect(enabledLabels).toEqual(expect.arrayContaining(["OpenClaw", "Hermes", "OpenCode", "Cursor Agent", "Trae"]));
  });

  it("uses Internal labels for all four optional migration sources", () => {
    const labels = sourceFilters({
      ...defaultSettings,
      includeTclaude: true,
      includeTcodex: true,
      includeClaudeInternal: true,
      includeCodexInternal: true,
    }).map((filter) => sourceFilterLabel(filter, "en"));

    expect(labels).toEqual(expect.arrayContaining(["TClaude", "TCodex", "Claude Code Internal", "Codex Internal"]));
  });

  it("combines CLI and app usage rows without merging internal sources", () => {
    expect(
      usageStatsDisplayRows([
        {
          source: "codex-app",
          sessionCount: 1,
          messageCount: 2,
          inputTokens: 3,
          outputTokens: 4,
          cachedInputTokens: 5,
          reasoningOutputTokens: 6,
          totalTokens: 18,
        },
        {
          source: "codex-cli",
          sessionCount: 7,
          messageCount: 8,
          inputTokens: 9,
          outputTokens: 10,
          cachedInputTokens: 11,
          reasoningOutputTokens: 12,
          totalTokens: 42,
        },
        {
          source: "codex-internal",
          sessionCount: 1,
          messageCount: 1,
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 1,
          reasoningOutputTokens: 1,
          totalTokens: 4,
        },
      ]),
    ).toEqual([
      {
        key: "codex",
        label: "Codex",
        sessionCount: 8,
        messageCount: 10,
        inputTokens: 12,
        outputTokens: 14,
        cachedInputTokens: 16,
        reasoningOutputTokens: 18,
        totalTokens: 60,
      },
      {
        key: "codex-internal",
        label: "Codex Internal",
        sessionCount: 1,
        messageCount: 1,
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 1,
        reasoningOutputTokens: 1,
        totalTokens: 4,
      },
    ]);
  });

  it("treats zero-token sources as unknown usage instead of displayable usage", () => {
    expect(hasTokenUsage({ totalTokens: 0 })).toBe(false);
    expect(hasTokenUsage({ totalTokens: 1 })).toBe(true);
    expect(appSource).toContain("hasTokenUsage(stats.total)");
    expect(sessionRowSource).toContain("hasTokenUsage(session.tokenUsage)");
  });

  it("derives migration targets from enabled settings in registry order", () => {
    expect(migrationTargetsForSource("claude-cli", defaultSettings)).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor"]);
    expect(migrationTargetsForSource("claude-cli", { ...defaultSettings, includeTcodex: true })).toEqual([
      "claude", "codex", "codebuddy", "codewiz", "cursor", "tcodex",
    ]);
    expect(migrationTargetsForSource("claude-cli", {
      ...defaultSettings,
      includeTclaude: true,
      includeTcodex: true,
      includeClaudeInternal: true,
      includeCodexInternal: true,
    })).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor", "tclaude", "tcodex", "claude-internal", "codex-internal"]);
    expect(migrationTargetsForSource("hermes", defaultSettings)).toEqual([]);
  });

  it("returns no dialog targets for remote sessions without changing local targets", () => {
    const settings = {
      ...defaultSettings,
      includeTclaude: true,
      includeTcodex: true,
      includeClaudeInternal: true,
      includeCodexInternal: true,
    };
    const local = { source: "claude-cli", environmentId: "local", environmentKind: "local" } as const;
    const importedLocal = { source: "claude-cli", environmentId: "imported-local", environmentKind: "local" } as const;
    const remote = { source: "claude-cli", environmentId: "ssh-dev", environmentKind: "ssh" } as const;

    expect(migrationTargetsForSession(remote, settings)).toEqual([]);
    expect(migrationTargetsForSession(importedLocal, settings)).toEqual([]);
    expect(migrationTargetsForSession(local, settings)).toEqual([
      "claude", "codex", "codebuddy", "codewiz", "cursor", "tclaude", "tcodex", "claude-internal", "codex-internal",
    ]);
  });

  it("uses the latest activity timestamp shown in session rows", () => {
    const session = {
      timestamp: 100,
      fileMtimeMs: 300,
      lastResumedAt: 500,
      lastActivityAt: 400,
    };

    expect(sessionSortTimestamp(session)).toBe(400);
  });

  it("uses latest activity instead of creation time for project rows", () => {
    const project = {
      createdAt: 100,
      lastActivityAt: 900,
    };

    expect(projectSortTimestamp(project)).toBe(900);
  });
});
