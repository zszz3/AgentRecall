import type { AgentChannel } from "../../../shared/types";

export function codexEnvironmentForChannel(
  channel: AgentChannel | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env = { ...baseEnv, ...(channel?.environment ?? {}) } as Record<string, string>;
  if (!channel || channel.agentId !== "codex") return env;

  const authToken = authorizationToken(channel.httpHeaders?.Authorization);
  if (authToken) env.OPENAI_API_KEY = authToken;
  return env;
}

function authorizationToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("bearer ") ? trimmed.slice("bearer ".length).trim() : trimmed;
}
