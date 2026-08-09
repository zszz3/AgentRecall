import { resolveSummaryEndpoint, type SummaryEndpoint } from "./session-summarizer";
import type { AppSettings } from "./platform";
import { resolveProviderConfigDirectory } from "./provider-config-path";

export interface TemporarySessionCleaner {
  (sessionKey: string): void;
}

export interface BuildExecEndpointOptions {
  /** Invoked when an ephemeral CLI run is indexed before it exits, so the caller can delete the dirty row. */
  onTemporarySession?: TemporarySessionCleaner;
  /** Working directory the CLI should run in. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Environment that points a CLI at a config directory other than the machine's own.
 *
 * An empty setting means "follow the machine", and in that case we deliberately inject nothing:
 * passing an explicit `CODEX_HOME` / `CLAUDE_CONFIG_DIR` would override whatever the user already
 * has exported in their own shell, which is not what "follow the machine" promises. Resolution is
 * read-only on purpose — a summary must never create or write a provider config directory.
 */
function configDirEnv(variable: string, configuredPath: string | undefined, defaultDirectoryName: string) {
  const value = (configuredPath ?? "").trim();
  if (!value) return undefined;
  return { [variable]: resolveProviderConfigDirectory(value, defaultDirectoryName) };
}

// Builds a `codex_exec` summary endpoint that drives `codex exec --ephemeral`.
// The endpoint itself is just a description; session-summarizer runs the binary.
export function buildCodexExecEndpoint(
  settings: Pick<AppSettings, "codexBinary">
    & Partial<Pick<AppSettings, "summaryCodexModel" | "summaryCodexConfigDir" | "summaryReasoningEffort">>,
  options: BuildExecEndpointOptions = {},
): SummaryEndpoint {
  const model = settings.summaryCodexModel?.trim() ?? "";
  const env = configDirEnv("CODEX_HOME", settings.summaryCodexConfigDir, ".codex");
  return {
    baseUrl: "",
    model: model || "codex",
    apiKey: "",
    apiFormat: "codex_exec",
    command: settings.codexBinary,
    cwd: options.cwd ?? process.cwd(),
    modelArg: model || undefined,
    reasoningEffort: settings.summaryReasoningEffort || undefined,
    ...(env ? { env } : {}),
    onTemporarySession: options.onTemporarySession,
  };
}

// Builds a `claude_exec` summary endpoint that drives `claude --print`.
export function buildClaudeExecEndpoint(
  settings: Pick<AppSettings, "claudeBinary">
    & Partial<Pick<AppSettings, "summaryClaudeModel" | "summaryClaudeConfigDir">>,
  options: BuildExecEndpointOptions = {},
): SummaryEndpoint {
  const model = settings.summaryClaudeModel?.trim() ?? "";
  const env = configDirEnv("CLAUDE_CONFIG_DIR", settings.summaryClaudeConfigDir, ".claude");
  return {
    baseUrl: "",
    model: model || "claude",
    apiKey: "",
    apiFormat: "claude_exec",
    command: settings.claudeBinary,
    cwd: options.cwd ?? process.cwd(),
    modelArg: model || undefined,
    // No reasoning effort: the Claude CLI has no equivalent parameter.
    ...(env ? { env } : {}),
    onTemporarySession: options.onTemporarySession,
  };
}

// Resolves the summary endpoint from the user's configured source:
//   - "custom": a direct HTTP provider built from `summaryApiConfig`.
//   - "claude": `claude --print`.
//   - "codex" (default): `codex exec --ephemeral`.
// Returns null only when "custom" is selected but incomplete (no usable provider).
export function resolveSummaryEndpointFromSettings(
  settings: Pick<AppSettings, "summarySource" | "summaryApiConfig" | "claudeBinary" | "codexBinary">
    & Partial<Pick<AppSettings,
      | "summaryApiConfigMode"
      | "apiConfig"
      | "summaryCodexModel"
      | "summaryClaudeModel"
      | "summaryCodexConfigDir"
      | "summaryClaudeConfigDir"
      | "summaryReasoningEffort"
    >>,
  options: BuildExecEndpointOptions = {},
): SummaryEndpoint | null {
  if (settings.summarySource === "custom") {
    const config = settings.summaryApiConfigMode === "inherit_codex" && settings.apiConfig
      ? settings.apiConfig
      : settings.summaryApiConfig;
    const endpoint = resolveSummaryEndpoint([config]);
    if (!endpoint) return null;
    return { ...endpoint, reasoningEffort: settings.summaryReasoningEffort || undefined };
  }
  if (settings.summarySource === "claude") {
    return buildClaudeExecEndpoint(settings, options);
  }
  return buildCodexExecEndpoint(settings, options);
}
