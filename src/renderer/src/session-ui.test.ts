import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultSettings } from "../../core/platform";
import {
  migrationTargetsForSession,
  migrationTargetsForSource,
  projectSortTimestamp,
  sessionSortTimestamp,
  sourceFilterLabel,
  sourceFilters,
  usageStatsDisplayRows,
} from "./session-ui";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("session source labels", () => {
  it("renders structured message hits with role, count, highlighting, and a dedicated open action", () => {
    const sessionRow = appSource.slice(appSource.indexOf("const SessionRow = memo"), appSource.indexOf("function ActionToast"));
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
