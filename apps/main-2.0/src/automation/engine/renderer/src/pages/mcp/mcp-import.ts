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

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  );
}

/** Serialize the editable connection subset of a server for the JSON editor. */
export function serverConfigToJson(server: McpServerDefinition): string {
  const entry = server.transport === "http"
    ? {
        type: "http" as const,
        url: server.url ?? "",
        headers: server.headers ?? {},
        disabledTools: server.disabledTools ?? [],
      }
    : {
        type: "stdio" as const,
        command: server.command ?? "",
        args: server.args,
        env: server.env,
        disabledTools: server.disabledTools ?? [],
      };
  return JSON.stringify(entry, null, 2);
}

/**
 * Apply edited JSON back onto an existing server definition. Unlike import,
 * env and header values are kept verbatim: the editor round-trips the stored
 * host environment variable references instead of deriving them from key names.
 */
export function applyServerConfigJson(
  server: McpServerDefinition,
  text: string,
  language: "zh" | "en" = "en",
): McpServerDefinition {
  const zh = language === "zh";
  const trimmed = text.trim();
  if (!trimmed) throw new Error(zh ? "请填写要应用的 MCP Server JSON。" : "Enter the MCP server JSON to apply.");
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(zh ? "MCP Server JSON 必须是单个配置对象。" : "The MCP server JSON must be a single configuration object.");
  }
  if ("mcpServers" in (parsed as Record<string, unknown>)) {
    throw new Error(
      zh
        ? "此处编辑单个 Server；批量的 mcpServers 配置请使用「从 JSON 导入」。"
        : 'This editor changes one server. Use "Import from JSON" for an mcpServers block.',
    );
  }
  const entry = parsed as RawMcpEntry;
  const transport = resolveTransport(entry);
  const command = typeof entry.command === "string" ? entry.command.trim() : "";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (transport === "stdio" && !command) {
    throw new Error(zh ? 'stdio Server 需要 "command"。' : 'A stdio server requires "command".');
  }
  if (transport === "http" && !url) {
    throw new Error(zh ? 'http Server 需要 "url"。' : 'An http server requires "url".');
  }
  // The registry only persists disabled names that exist in the discovered
  // tool catalog, so entries that would be silently pruned on save are
  // rejected here with an actionable message instead.
  const disabledTools =
    entry.disabledTools === undefined
      ? (server.disabledTools ?? [])
      : asStringArray(entry.disabledTools);
  if (entry.disabledTools !== undefined && disabledTools.length > 0) {
    if (server.tools.length === 0) {
      throw new Error(
        zh
          ? "该 Server 还没有已发现的工具，disabledTools 保存时会被清空。请先测试连接，再配置 disabledTools。"
          : "This server has no discovered tools yet, so disabledTools would be cleared on save. Run a connection test first.",
      );
    }
    const known = new Set(server.tools.map((tool) => tool.name));
    const unknown = disabledTools.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        zh
          ? `disabledTools 包含未发现的工具，保存时会被忽略：${unknown.join("、")}。`
          : `disabledTools lists tools that were not discovered and would be dropped on save: ${unknown.join(", ")}.`,
      );
    }
  }
  const next: McpServerDefinition = {
    ...server,
    transport,
    args: transport === "stdio" ? asStringArray(entry.args) : [],
    env: transport === "stdio" ? toStringRecord(entry.env) : {},
    disabledTools,
  };
  if (transport === "stdio") {
    next.command = command;
    delete next.url;
    delete next.headers;
  } else {
    next.url = url;
    next.headers = toStringRecord(entry.headers);
    delete next.command;
  }
  return next;
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
