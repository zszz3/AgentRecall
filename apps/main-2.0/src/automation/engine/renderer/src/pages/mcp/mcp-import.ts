import type { McpServerDefinition, McpTransport } from "../../../../shared/mcp/types";

/**
 * A single entry from a standard `claude_desktop_config.json` style MCP block.
 * Only the subset AgentRecall understands is typed; unknown keys are ignored.
 */
interface RawMcpEntry {
  type?: string;
  transport?: string;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  env?: unknown;
  headers?: unknown;
  disabledTools?: unknown;
}

export interface McpImportResult {
  servers: McpServerDefinition[];
  errors: string[];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

/**
 * AgentRecall references host environment variable names instead of storing
 * secret values, so every env key defaults to a same-named host reference.
 */
function toEnvReferences(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((key) => [key, key]));
}

/**
 * Pasted configs usually carry literal header values (often secrets), which
 * AgentRecall never persists. Import only the header names with an empty host
 * environment reference for the user to fill in afterwards.
 */
function toHeaderReferences(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).map((key) => [key, ""]));
}

function resolveTransport(entry: RawMcpEntry): McpTransport {
  const hint = String(entry.type ?? entry.transport ?? "").toLowerCase();
  if (hint === "stdio") return "stdio";
  if (hint === "http" || hint === "sse" || hint === "streamable-http" || hint === "streamablehttp") return "http";
  if (typeof entry.url === "string" && entry.url.trim()) return "http";
  return "stdio";
}

function extractEntries(parsed: unknown): [string, RawMcpEntry][] {
  const container =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) && "mcpServers" in parsed
      ? (parsed as { mcpServers: unknown }).mcpServers
      : parsed;
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    throw new Error('JSON must contain an object of servers, e.g. { "mcpServers": { "name": { ... } } }.');
  }
  return Object.entries(container as Record<string, unknown>).map(([name, value]) => [name, (value ?? {}) as RawMcpEntry]);
}

/**
 * Parse a pasted MCP config (single or multiple servers) into registry
 * definitions. Throws on malformed JSON or an unusable top-level shape;
 * per-server problems are collected in `errors` so the valid servers still import.
 */
export function parseMcpServersJson(text: string): McpImportResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste MCP server JSON to import.");
  const parsed = JSON.parse(trimmed) as unknown;
  const entries = extractEntries(parsed);
  if (entries.length === 0) throw new Error("No MCP servers found in the provided JSON.");

  const now = Date.now();
  const servers: McpServerDefinition[] = [];
  const errors: string[] = [];
  entries.forEach(([name, entry], index) => {
    const transport = resolveTransport(entry);
    const command = typeof entry.command === "string" ? entry.command.trim() : "";
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (transport === "stdio" && !command) {
      errors.push(`${name}: missing "command" for a stdio server.`);
      return;
    }
    if (transport === "http" && !url) {
      errors.push(`${name}: missing "url" for an http server.`);
      return;
    }
    servers.push({
      id: `mcp-${now}-${index}`,
      name: name.trim() || `Imported ${index + 1}`,
      transport,
      ...(transport === "stdio" ? { command } : {}),
      args: transport === "stdio" ? asStringArray(entry.args) : [],
      ...(transport === "http" ? { url } : {}),
      env: transport === "stdio" ? toEnvReferences(entry.env) : {},
      ...(transport === "http" ? { headers: toHeaderReferences(entry.headers) } : {}),
      enabled: true,
      tools: [],
      disabledTools: asStringArray(entry.disabledTools),
      status: "untested",
      createdAt: now,
      updatedAt: now,
    });
  });
  return { servers, errors };
}
