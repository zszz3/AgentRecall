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
  includeDeepSeekCli: false,
};

describe("migration target registry", () => {
  it("defines the renderer display order with unique ids", () => {
    expect(MIGRATION_TARGET_IDS).toEqual([
      "claude",
      "codex",
      "codebuddy",
      "codewiz",
      "cursor",
      "zcode",
      "tclaude",
      "tcodex",
      "deepseek",
    ]);
    expect(new Set(MIGRATION_TARGET_IDS).size).toBe(MIGRATION_TARGET_IDS.length);
    expect(MIGRATION_TARGETS.map(({ id }) => id)).toEqual(MIGRATION_TARGET_IDS);
  });

  it("defines the base migration targets", () => {
    expect(BASE_MIGRATION_TARGETS).toEqual(["claude", "codex", "codebuddy", "codewiz", "cursor", "zcode"]);
    expect(MIGRATION_TARGETS.slice(0, 6)).toEqual([
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
      {
        id: "zcode",
        label: "ZCode",
        family: "zcode",
        source: "zcode-cli",
        enabledSetting: null,
      },
    ]);
  });

  it("maps the optional migration targets", () => {
    expect(MIGRATION_TARGETS.slice(6)).toEqual([
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
        id: "deepseek",
        label: "DeepSeek Harness",
        family: "deepseek",
        source: "deepseek-cli",
        enabledSetting: "includeDeepSeekCli",
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
      includeDeepSeekCli: true,
    })).toEqual(MIGRATION_TARGET_IDS);
  });

  it("looks up registered targets and rejects unsupported ids", () => {
    expect(migrationTargetDescriptor("tcodex")).toEqual(MIGRATION_TARGETS[7]);
    expect(() => migrationTargetDescriptor("unsupported" as never)).toThrow("Unsupported migration target");
  });

  it("rejects disabled optional targets with their display label", () => {
    expect(() => assertMigrationTargetEnabled("tclaude", allDisabled)).toThrow(
      "TClaude migration target is disabled in Settings.",
    );
    expect(() => assertMigrationTargetEnabled("claude", allDisabled)).not.toThrow();
  });
});
