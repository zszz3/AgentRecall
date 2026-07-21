export const RUNTIME_DEFINITIONS = [
  {
    id: "codex",
    label: "Codex",
    executable: "codex",
    executableEnv: "CODEX_PATH",
    detection: "cli",
    localConfigImport: true,
    defaultChannel: {
      id: "codex-openai",
      label: "Codex OpenAI",
      modelProvider: "openai",
      providerName: "OpenAI",
    },
  },
  {
    id: "claude",
    label: "Claude Code",
    executable: "claude",
    executableEnv: "CLAUDE_PATH",
    detection: "cli",
    localConfigImport: true,
    defaultChannel: {
      id: "claude-code",
      label: "Claude Code",
    },
  },
  {
    id: "api",
    label: "API",
    executable: "api",
    detection: "virtual",
    localConfigImport: false,
    defaultChannel: {
      id: "api-openai",
      label: "OpenAI API",
      modelProvider: "openai-api",
      providerName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
    },
  },
  {
    id: "hermes",
    label: "Hermes",
    executable: "hermes",
    executableEnv: "HERMES_PATH",
    detection: "cli",
    localConfigImport: true,
    defaultChannel: {
      id: "hermes-default",
      label: "Hermes Default",
      presetId: "hermes-default",
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    executable: "opencode",
    executableEnv: "OPENCODE_PATH",
    detection: "cli",
    localConfigImport: true,
    defaultChannel: {
      id: "opencode-default",
      label: "OpenCode Default",
      presetId: "opencode-default",
    },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    executable: "openclaw",
    executableEnv: "OPENCLAW_PATH",
    detection: "cli",
    localConfigImport: true,
    defaultChannel: {
      id: "openclaw-default",
      label: "OpenClaw Default",
      presetId: "openclaw-default",
    },
  },
] as const;

export type RuntimeId = (typeof RUNTIME_DEFINITIONS)[number]["id"];
export type RuntimeDefinition = (typeof RUNTIME_DEFINITIONS)[number];

export const RUNTIME_IDS: RuntimeId[] = RUNTIME_DEFINITIONS.map((definition) => definition.id);

export function isRuntimeId(value: unknown): value is RuntimeId {
  return typeof value === "string" && RUNTIME_IDS.some((runtimeId) => runtimeId === value);
}

export function runtimeDefinition(runtimeId: RuntimeId): RuntimeDefinition {
  const definition = RUNTIME_DEFINITIONS.find((item) => item.id === runtimeId);
  if (!definition) throw new Error(`Unknown runtime: ${runtimeId}`);
  return definition;
}

export function runtimeLabel(runtimeId: RuntimeId): string {
  return runtimeDefinition(runtimeId).label;
}
