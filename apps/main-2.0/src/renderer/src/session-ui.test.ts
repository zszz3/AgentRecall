import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../core/platform";
import {
  canMigrateSession,
  environmentBadgeLabel,
  environmentBadgeTitle,
  isSidebarProjectVisible,
  migrationTargetsForSession,
  sessionAvailableSources,
  sourceMigrationAgent,
  projectDisplayLabel,
  sourceFilters,
  sourceUiFamily,
  supportsOpenAppSource,
  supportsResumeSource,
  usageCacheRate,
} from "./session-ui";

const settings = { includeTclaude: false, includeTcodex: false };

describe("migrationTargetsForSession", () => {
  it("offers only Codex for an SSH Claude Code session", () => {
    const session = { source: "claude-cli", environmentId: "ssh-1", environmentKind: "ssh" } as const;
    expect(migrationTargetsForSession(session, settings)).toEqual(["codex"]);
    expect(canMigrateSession(session, settings)).toBe(true);
  });

  it("offers only Claude Code for an SSH Codex session", () => {
    expect(migrationTargetsForSession({ source: "codex-cli", environmentId: "ssh-1", environmentKind: "ssh" }, settings)).toEqual(["claude"]);
  });

  it("does not offer SSH migration for other sources", () => {
    const session = { source: "tclaude-cli", environmentId: "ssh-1", environmentKind: "ssh" } as const;
    expect(migrationTargetsForSession(session, settings)).toEqual([]);
    expect(canMigrateSession(session, settings)).toBe(false);
  });

  it("keeps local and WSL target behavior", () => {
    expect(migrationTargetsForSession({ source: "claude-cli", environmentId: "local", environmentKind: "local" }, settings)).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor", "zcode"]);
    expect(migrationTargetsForSession({ source: "codex-cli", environmentId: "wsl-1", environmentKind: "wsl" }, settings)).toEqual(["claude", "codex", "codebuddy", "cursor"]);
  });

  it("does not offer WSL or ZCode-source sessions as migratable into ZCode twice", () => {
    expect(migrationTargetsForSession({ source: "zcode-cli", environmentId: "local", environmentKind: "local" }, settings)).toEqual([]);
  });

  it("safely disables actions for a stale persisted source", () => {
    const source = "workbuddy-cli" as never;
    const session = { source, environmentId: "local", environmentKind: "local" } as const;
    expect(sourceUiFamily(source)).toBe("other");
    expect(supportsResumeSource(source)).toBe(false);
    expect(sourceMigrationAgent(source)).toBeNull();
    expect(migrationTargetsForSession(session, settings)).toEqual([]);
  });
});

describe("supportsOpenAppSource", () => {
  it("offers Open App only for sources that ship a desktop app", () => {
    expect(supportsOpenAppSource("claude-cli")).toBe(true);
    expect(supportsOpenAppSource("codex-app")).toBe(true);
    expect(supportsOpenAppSource("codebuddy-cli")).toBe(true);
  });

  it("keeps Open App away from resumable sources that have no desktop app", () => {
    for (const source of ["tclaude-cli", "tcodex-cli", "codewiz-cli", "deepseek-cli"] as const) {
      expect(supportsResumeSource(source)).toBe(true);
      expect(supportsOpenAppSource(source)).toBe(false);
    }
  });

  it("stays false for a stale persisted source", () => {
    expect(supportsOpenAppSource("not-a-source" as never)).toBe(false);
  });
});

describe("usageCacheRate", () => {
  it("treats cache creation as a miss and cache reads as hits", () => {
    expect(usageCacheRate({ inputTokens: 500, cachedInputTokens: 300, cacheCreationInputTokens: 2_000 })).toBe(10.7);
  });
});

describe("environment badges", () => {
  it("identifies WSL sessions without presenting them as ordinary local sessions", () => {
    const session = { environmentKind: "wsl", environmentLabel: "Ubuntu-24.04" } as const;
    expect(environmentBadgeLabel(session, "en")).toBe("WSL · Ubuntu-24.04");
    expect(environmentBadgeTitle(session, "en")).toBe("Local WSL environment: Ubuntu-24.04");
    expect(environmentBadgeTitle(session, "zh")).toBe("本地 WSL 环境：Ubuntu-24.04");
  });
});

describe("sidebar project presentation", () => {
  it("keeps empty workspace rows out of the active project list unless selected", () => {
    const project = { path: "C:/workspace/ebb3b242", environmentId: "local", sessionCount: 0 };
    expect(isSidebarProjectVisible(project, undefined, undefined)).toBe(false);
    expect(isSidebarProjectVisible(project, project.path, project.environmentId)).toBe(true);
  });

  it("uses a readable label for opaque workspace ids", () => {
    expect(projectDisplayLabel({ label: "ebb3b242-1234-5678-90ab-cdef01234567", labelKind: "path", labelSuffix: null }, "zh"))
      .toBe("未命名工作区 · 01234567");
  });
});

describe("sourceFilters", () => {
  it("places StepCode before the other optional sources", () => {
    const filters = sourceFilters({
      ...defaultSettings,
      includeStepcode: true,
      includeWorkBuddy: true,
    });

    expect(filters.slice(3, 5)).toEqual([
      { label: "StepCode", value: "stepcode" },
      { label: "WorkBuddy", value: "workbuddy-cli" },
    ]);
  });

  it("shows WorkBuddy only when its setting is enabled", () => {
    expect(sourceFilters(defaultSettings)).not.toContainEqual({ label: "WorkBuddy", value: "workbuddy-cli" });
    expect(sourceFilters({ ...defaultSettings, includeWorkBuddy: true })).toContainEqual({
      label: "WorkBuddy",
      value: "workbuddy-cli",
    });
  });
});

describe("sessionAvailableSources", () => {
  it("shows the native agent alongside a real StepCode session", () => {
    expect(sessionAvailableSources({ source: "stepcode-claude" })).toEqual(["stepcode-claude", "claude-cli"]);
    expect(sessionAvailableSources({ source: "stepcode-codex" })).toEqual(["stepcode-codex", "codex-cli"]);
  });

  it("does not label a native Codex Desktop session as StepCode", () => {
    expect(sessionAvailableSources({ source: "codex-app" })).toEqual(["codex-app"]);
  });
});
