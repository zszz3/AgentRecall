import { resolveSummaryEndpoint, type SummaryEndpoint } from "./session-summarizer";
import type { AppSettings } from "./platform";

export interface TemporarySessionCleaner {
  (sessionKey: string): void;
}

export interface BuildExecEndpointOptions {
  /** Invoked when an ephemeral CLI run is indexed before it exits, so the caller can delete the dirty row. */
  onTemporarySession?: TemporarySessionCleaner;
  /** Working directory the CLI should run in. Defaults to `process.cwd()`. */
  cwd?: string;
}

// Builds a `codex_exec` summary endpoint that drives `codex exec --ephemeral`.
// The endpoint itself is just a description; session-summarizer runs the binary.
export function buildCodexExecEndpoint(
  settings: Pick<AppSettings, "codexBinary">
    & Partial<Pick<AppSettings, "summaryCodexModel" | "openVikingExtractionReasoningEffort">>,
  options: BuildExecEndpointOptions = {},
): SummaryEndpoint {
  const model = settings.summaryCodexModel?.trim() ?? "";
  return {
    baseUrl: "",
    model: model || "codex",
    apiKey: "",
    apiFormat: "codex_exec",
    command: settings.codexBinary,
    cwd: options.cwd ?? process.cwd(),
    modelArg: model || undefined,
    reasoningEffort: settings.openVikingExtractionReasoningEffort ?? "medium",
    onTemporarySession: options.onTemporarySession,
  };
}

// Builds a `claude_exec` summary endpoint that drives `claude --print`.
export function buildClaudeExecEndpoint(settings: Pick<AppSettings, "claudeBinary">, options: BuildExecEndpointOptions = {}): SummaryEndpoint {
  return {
    baseUrl: "",
    model: "claude",
    apiKey: "",
    apiFormat: "claude_exec",
    command: settings.claudeBinary,
    cwd: options.cwd ?? process.cwd(),
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
    & Partial<Pick<AppSettings, "summaryApiConfigMode" | "apiConfig" | "summaryCodexModel" | "openVikingExtractionReasoningEffort">>,
  options: BuildExecEndpointOptions = {},
): SummaryEndpoint | null {
  if (settings.summarySource === "custom") {
    const config = settings.summaryApiConfigMode === "inherit_codex" && settings.apiConfig
      ? settings.apiConfig
      : settings.summaryApiConfig;
    return resolveSummaryEndpoint([config]);
  }
  if (settings.summarySource === "claude") {
    return buildClaudeExecEndpoint(settings, options);
  }
  return buildCodexExecEndpoint(settings, options);
}
