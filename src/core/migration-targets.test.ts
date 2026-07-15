import { describe, expect, it } from "vitest";
import {
  BASE_MIGRATION_TARGETS,
  MIGRATION_TARGET_IDS,
  MIGRATION_TARGETS,
  assertMigrationTargetEnabled,
  enabledMigrationTargets,
  migrationTargetDescriptor,
  type MigrationTargetSettings,
} from "./migration-targets";

const allDisabled: MigrationTargetSettings = {
  includeTclaude: false,
  includeTcodex: false,
  includeClaudeInternal: false,
  includeCodexInternal: false,
};

describe("migration target registry", () => {
  it("defines the renderer display order with unique ids", () => {
    expect(MIGRATION_TARGET_IDS).toEqual([
      "claude",
      "codex",
      "codebuddy",
      "codewiz",
      "cursor",
      "tclaude",
      "tcodex",
      "claude-internal",
      "codex-internal",
    ]);
    expect(new Set(MIGRATION_TARGET_IDS).size).toBe(MIGRATION_TARGET_IDS.length);
    expect(MIGRATION_TARGETS.map(({ id }) => id)).toEqual(MIGRATION_TARGET_IDS);
  });

  it("defines the four base migration targets", () => {
    expect(BASE_MIGRATION_TARGETS).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor"]);
    expect(MIGRATION_TARGETS.slice(0, 5)).toEqual([
      {
        id: "claude",
        label: "Claude Code",
        family: "claude",
        source: "claude-cli",
        enabledSetting: null,
      },
      {
        id: "codex",
        label: "Codex",
        family: "codex",
        source: "codex-cli",
        enabledSetting: null,
      },
      {
        id: "codebuddy",
        label: "CodeBuddy",
        family: "codebuddy",
        source: "codebuddy-cli",
        enabledSetting: null,
      },
      {
        id: "codewiz",
        label: "CodeWiz",
        family: "codewiz",
        source: "codewiz-cli",
        enabledSetting: null,
      },
      {
        id: "cursor",
        label: "Cursor Agent",
        family: "cursor",
        source: "cursor-agent",
        enabledSetting: null,
      },
    ]);
  });

  it("maps the four optional migration targets", () => {
    expect(MIGRATION_TARGETS.slice(5)).toEqual([
      {
        id: "tclaude",
        label: "TClaude",
        family: "claude",
        source: "tclaude-cli",
        enabledSetting: "includeTclaude",
      },
      {
        id: "tcodex",
        label: "TCodex",
        family: "codex",
        source: "tcodex-cli",
        enabledSetting: "includeTcodex",
      },
      {
        id: "claude-internal",
        label: "Claude Code Internal",
        family: "claude",
        source: "claude-internal",
        enabledSetting: "includeClaudeInternal",
      },
      {
        id: "codex-internal",
        label: "Codex Internal",
        family: "codex",
        source: "codex-internal",
        enabledSetting: "includeCodexInternal",
      },
    ]);
  });

  it("always enables base targets and gates each optional target independently", () => {
    expect(enabledMigrationTargets(allDisabled)).toEqual(BASE_MIGRATION_TARGETS);

    for (const descriptor of MIGRATION_TARGETS.slice(BASE_MIGRATION_TARGETS.length)) {
      const settings = { ...allDisabled, [descriptor.enabledSetting!]: true };
      expect(enabledMigrationTargets(settings)).toEqual([...BASE_MIGRATION_TARGETS, descriptor.id]);
    }

    expect(enabledMigrationTargets({
      includeTclaude: true,
      includeTcodex: true,
      includeClaudeInternal: true,
      includeCodexInternal: true,
    })).toEqual(MIGRATION_TARGET_IDS);
  });

  it("looks up registered targets and rejects unsupported ids", () => {
    expect(migrationTargetDescriptor("tcodex")).toEqual(MIGRATION_TARGETS[6]);
    expect(() => migrationTargetDescriptor("unsupported" as never)).toThrow("Unsupported migration target");
  });

  it("rejects disabled optional targets with their display label", () => {
    expect(() => assertMigrationTargetEnabled("claude-internal", allDisabled)).toThrow(
      "Claude Code Internal migration target is disabled in Settings.",
    );
    expect(() => assertMigrationTargetEnabled("claude", allDisabled)).not.toThrow();
  });
});
