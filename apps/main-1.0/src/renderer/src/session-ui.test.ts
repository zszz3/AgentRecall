import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../core/platform";
import { canMigrateSession, migrationTargetsForSession, sourceFilters } from "./session-ui";

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
    expect(migrationTargetsForSession({ source: "claude-cli", environmentId: "local", environmentKind: "local" }, settings)).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor"]);
    expect(migrationTargetsForSession({ source: "codex-cli", environmentId: "wsl-1", environmentKind: "wsl" }, settings)).toEqual(["claude", "codex"]);
  });
});

describe("sourceFilters", () => {
  it("shows WorkBuddy only when its optional source is enabled", () => {
    expect(sourceFilters(defaultSettings)).not.toContainEqual({ label: "WorkBuddy", value: "workbuddy-cli" });
    expect(sourceFilters({ ...defaultSettings, includeWorkBuddy: true })).toContainEqual({
      label: "WorkBuddy",
      value: "workbuddy-cli",
    });
  });

  it("shows DeepSeek Harness only when its optional source is enabled", () => {
    expect(sourceFilters(defaultSettings)).not.toContainEqual({
      label: "DeepSeek Harness",
      value: "deepseek-harness",
    });
    expect(sourceFilters({ ...defaultSettings, includeDeepSeekHarness: true })).toContainEqual({
      label: "DeepSeek Harness",
      value: "deepseek-harness",
    });
  });
});
