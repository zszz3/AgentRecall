import type { MigrationAgent, MigrationTarget, SessionSource } from "./types";

export type OptionalMigrationTargetSetting =
  | "includeTclaude"
  | "includeTcodex"
  | "includeClaudeInternal"
  | "includeCodexInternal";

export type MigrationTargetSettings = Record<OptionalMigrationTargetSetting, boolean>;

export interface MigrationTargetDescriptor {
  id: MigrationTarget;
  label: string;
  family: MigrationAgent;
  source: SessionSource;
  enabledSetting: OptionalMigrationTargetSetting | null;
}

export const MIGRATION_TARGETS: readonly MigrationTargetDescriptor[] = [
  { id: "claude", label: "Claude Code", family: "claude", source: "claude-cli", enabledSetting: null },
  { id: "codex", label: "Codex", family: "codex", source: "codex-cli", enabledSetting: null },
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
] as const satisfies readonly MigrationTargetDescriptor[];

export const MIGRATION_TARGET_IDS = [
  "claude",
  "codex",
  "codebuddy",
  "codewiz",
  "cursor",
  "tclaude",
  "tcodex",
  "claude-internal",
  "codex-internal",
] as const satisfies readonly MigrationTarget[];

export const BASE_MIGRATION_TARGETS = ["claude", "codex", "codebuddy", "codewiz", "cursor"] as const satisfies readonly MigrationTarget[];

export function isMigrationTarget(value: unknown): value is MigrationTarget {
  return typeof value === "string" && (MIGRATION_TARGET_IDS as readonly string[]).includes(value);
}

export function migrationTargetDescriptor(target: unknown): MigrationTargetDescriptor {
  const descriptor = MIGRATION_TARGETS.find(({ id }) => id === target);
  if (!descriptor) throw new Error(`Unsupported migration target: ${target}`);
  return descriptor;
}

export function enabledMigrationTargets(settings: MigrationTargetSettings): MigrationTarget[] {
  return MIGRATION_TARGETS
    .filter(({ enabledSetting }) => !enabledSetting || settings[enabledSetting])
    .map(({ id }) => id);
}

export function assertMigrationTargetEnabled(target: MigrationTarget, settings: MigrationTargetSettings): void {
  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.enabledSetting && !settings[descriptor.enabledSetting]) {
    throw new Error(`${descriptor.label} migration target is disabled in Settings.`);
  }
}
