import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import type { LibraryAgentId } from "./library-agent-ids";
import type { LibraryMcpServer } from "./library-mcp-server";

type Env = Record<string, string | undefined>;

/** How an agent stores its user-level MCP servers. */
type McpFormat = "claude" | "gemini" | "plain" | "opencode" | "codex";

export interface LibraryMcpTarget {
  id: LibraryAgentId;
  file: string;
  format: McpFormat;
  /** Keys leading to the object of servers in a JSON file. */
  keys: readonly string[];
}

function directory(env: Env, variable: string, fallback: string): string {
  const value = env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

/**
 * The user-level MCP file of each agent that has one. Pi, StepCode and
 * DeepSeek Harness are absent: Pi has no MCP client and DeepSeek Harness keeps
 * servers as plugin rows in every profile.
 */
export function libraryMcpTargets(home: string, env: Env): LibraryMcpTarget[] {
  const claude = directory(env, "CLAUDE_CONFIG_DIR", "");
  const codex = directory(env, "CODEX_HOME", path.join(home, ".codex"));
  const config = directory(env, "XDG_CONFIG_HOME", path.join(home, ".config"));
  return [
    { id: "claude-code", file: claude ? path.join(claude, ".claude.json") : path.join(home, ".claude.json"), format: "claude", keys: ["mcpServers"] },
    { id: "codex", file: path.join(codex, "config.toml"), format: "codex", keys: [] },
    { id: "gemini", file: path.join(home, ".gemini", "settings.json"), format: "gemini", keys: ["mcpServers"] },
    { id: "opencode", file: path.join(config, "opencode", "opencode.json"), format: "opencode", keys: ["mcp"] },
    { id: "qwen", file: path.join(directory(env, "QWEN_HOME", path.join(home, ".qwen")), "settings.json"), format: "gemini", keys: ["mcpServers"] },
    { id: "cursor", file: path.join(home, ".cursor", "mcp.json"), format: "plain", keys: ["mcpServers"] },
    { id: "zcode", file: path.join(home, ".zcode", "cli", "config.json"), format: "claude", keys: ["mcp", "servers"] },
  ];
}

const nonEmpty = <T extends object>(value: T | undefined): T | undefined => value && Object.keys(value).length > 0 ? value : undefined;

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/**
 * The entry written for `server` in the agent's file. Codex entries are the
 * TOML text of the server's tables, because AgentRecall edits config.toml as
 * text to keep the user's comments.
 */
export function encodeServer(target: LibraryMcpTarget, name: string, server: LibraryMcpServer): unknown {
  const stdio = "command" in server;
  const args = stdio && server.args?.length ? server.args : undefined;
  switch (target.format) {
    case "claude":
      return stdio
        ? compact({ type: "stdio", command: server.command, args, env: nonEmpty(server.env) })
        : compact({ type: "http", url: server.url, headers: nonEmpty(server.headers) });
    case "gemini":
      return stdio
        ? compact({ command: server.command, args, env: nonEmpty(server.env) })
        : compact({ httpUrl: server.url, headers: nonEmpty(server.headers) });
    case "plain":
      return stdio
        ? compact({ command: server.command, args, env: nonEmpty(server.env) })
        : compact({ url: server.url, headers: nonEmpty(server.headers) });
    case "opencode":
      return stdio
        ? compact({ type: "local", command: [server.command, ...(args ?? [])], environment: nonEmpty(server.env), enabled: true })
        : compact({ type: "remote", url: server.url, headers: nonEmpty(server.headers), enabled: true });
    case "codex": {
      const table = stdio
        ? compact({ command: server.command, args, env: nonEmpty(server.env) })
        : compact({ url: server.url, http_headers: nonEmpty(server.headers) });
      return stringifyToml({ mcp_servers: { [name]: table } }).trim();
    }
  }
}

function strings(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

function stringMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.values(value).every((item) => typeof item === "string") ? value as Record<string, string> : null;
}

function server(command: unknown, args: unknown, env: unknown, url: unknown, headers: unknown): LibraryMcpServer | null {
  if (typeof command === "string" && command.trim()) {
    const list = strings(args);
    const map = stringMap(env);
    if (list === null || map === null) return null;
    return compact({ command, args: list?.length ? list : undefined, env: nonEmpty(map) });
  }
  if (typeof url === "string" && /^https?:\/\//.test(url)) {
    const map = stringMap(headers);
    if (map === null) return null;
    return compact({ url, headers: nonEmpty(map) });
  }
  return null;
}

/**
 * Reads one entry of the agent's file into the Library's shape, or null when
 * it uses something the Library cannot express (such as a token read from an
 * environment variable or OAuth settings).
 */
export function decodeServer(target: LibraryMcpTarget, value: unknown): LibraryMcpServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const known = (keys: readonly string[]) => Object.keys(entry).every((key) => keys.includes(key));
  switch (target.format) {
    case "claude":
      return known(["type", "command", "args", "env", "url", "headers"]) ? server(entry.command, entry.args, entry.env, entry.url, entry.headers) : null;
    case "gemini":
      return known(["command", "args", "env", "httpUrl", "url", "headers"]) ? server(entry.command, entry.args, entry.env, entry.httpUrl ?? entry.url, entry.headers) : null;
    case "plain":
      return known(["type", "command", "args", "env", "url", "headers"]) ? server(entry.command, entry.args, entry.env, entry.url, entry.headers) : null;
    case "opencode": {
      if (!known(["type", "command", "environment", "url", "headers", "enabled"])) return null;
      const command = strings(entry.command);
      if (entry.type === "local" && command && command.length > 0) return server(command[0], command.slice(1), entry.environment, undefined, undefined);
      return entry.type === "remote" ? server(undefined, undefined, undefined, entry.url, entry.headers) : null;
    }
    case "codex":
      return known(["command", "args", "env", "url", "http_headers"]) ? server(entry.command, entry.args, entry.env, entry.url, entry.http_headers) : null;
  }
}

function fileName(target: LibraryMcpTarget): string {
  return path.basename(target.file);
}

function parseJson(target: LibraryMcpTarget, text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${target.file} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${target.file} does not hold a JSON object.`);
  return parsed as Record<string, unknown>;
}

function serversIn(target: LibraryMcpTarget, root: Record<string, unknown>, create: boolean): Record<string, unknown> | null {
  let node: Record<string, unknown> = root;
  for (const key of target.keys) {
    const next = node[key];
    if (next === undefined) {
      if (!create) return null;
      node[key] = {};
    } else if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`"${target.keys.join(".")}" in ${target.file} is not an object.`);
    }
    node = node[key] as Record<string, unknown>;
  }
  return node;
}

function parseCodex(target: LibraryMcpTarget, text: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${target.file} is not valid TOML: ${(error as Error).message}`);
  }
  const servers = parsed.mcp_servers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, unknown> : {};
}

const HEADER = /^\s*\[([^\][]+)\]\s*(?:#.*)?$/;

/** Line ranges of `[mcp_servers.<name>]` and its sub-tables when they sit together. */
function codexBlock(lines: readonly string[], name: string): { start: number; end: number } | null {
  const own = (line: string) => {
    const header = HEADER.exec(line)?.[1]?.trim();
    return header === `mcp_servers.${name}` || header?.startsWith(`mcp_servers.${name}.`) === true;
  };
  const start = lines.findIndex(own);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && (!/^\s*\[/.test(lines[end]!) || own(lines[end]!))) end += 1;
  return { start, end };
}

/** The agent's current MCP servers by name; Codex servers are the text of their tables. */
export function readMcpEntries(target: LibraryMcpTarget, text: string): Record<string, unknown> {
  if (target.format !== "codex") return { ...serversIn(target, parseJson(target, text), false) };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return Object.fromEntries(Object.keys(parseCodex(target, text)).map((name) => {
    const block = codexBlock(lines, name);
    return [name, block ? lines.slice(block.start, block.end).join("\n").trim() : parseCodex(target, text)[name]];
  }));
}

/** Writes and removes the named entries, leaving everything else in the file as it was. */
export function withMcpEntries(target: LibraryMcpTarget, text: string, change: { set: Record<string, unknown>; remove: readonly string[] }): string {
  if (target.format !== "codex") {
    const root = parseJson(target, text);
    const servers = serversIn(target, root, Object.keys(change.set).length > 0);
    if (servers) {
      for (const name of change.remove) delete servers[name];
      Object.assign(servers, change.set);
    }
    return `${JSON.stringify(root, null, 2)}\n`;
  }
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  for (const name of [...change.remove, ...Object.keys(change.set)]) {
    const block = codexBlock(lines, name);
    if (!block) continue;
    lines = [...lines.slice(0, block.start), ...lines.slice(block.end)];
  }
  let next = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
  const blocks = Object.values(change.set).map(String);
  if (blocks.length > 0) next = [next, ...blocks].filter(Boolean).join("\n\n");
  next = next ? `${next}\n` : "";
  // A server defined some other way (an inline table, a dotted key) would now be defined twice.
  try {
    parseToml(next);
  } catch (error) {
    throw new Error(`AgentRecall could not update the MCP servers in ${fileName(target)} without breaking it: ${(error as Error).message}. Edit ${target.file} by hand or remove the server from the Library.`);
  }
  return next;
}
