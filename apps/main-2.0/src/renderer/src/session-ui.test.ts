import { describe, expect, it } from "vitest";
import { canMigrateSession, migrationTargetsForSession, usageCacheRate } from "./session-ui";

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

describe("usageCacheRate", () => {
  it("treats cache creation as a miss and cache reads as hits", () => {
    expect(usageCacheRate({
      inputTokens: 500,
      cachedInputTokens: 300,
      cacheCreationInputTokens: 2_000,
    })).toBe(10.7);
  });
});
