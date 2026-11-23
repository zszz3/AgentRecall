import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { redactSecrets } from "./experience-extraction";

type Env = Record<string, string | undefined>;
type Fields = Record<string, unknown>;

const REDACTED = "[redacted]";
/** Flags, query parameters and `NAME=value` arguments whose values are credentials. */
const SECRET_NAME = /key|token|secret|passw(?:or)?d|auth|credential/i;

export interface AgentMcpLocation {
  agent: string;
  scope: "user" | "project";
  /** The project folder for servers that only apply inside one project. */
  project: string | null;
  /** The configuration file that declares the server. */
  file: string;
}

export interface AgentMcpServer {
  name: string;
  transport: "stdio" | "http";
  command: string | null;
  /** Arguments with credential-shaped values replaced. */
  args: string[];
  /** The address with credential query values replaced. */
  url: string | null;
  /** Names of the environment variables the agent passes; values are never read out. */
  envNames: string[];
  /** Names of the request headers the agent sends; values are never read out. */
  headerNames: string[];
  /** The agent's configuration turns the server off. */
  disabled: boolean;
  locations: AgentMcpLocation[];
}

export interface AgentMcpProblem {
  file: string;
  message: string;
}

export interface AgentMcpCatalog {
  servers: AgentMcpServer[];
  problems: AgentMcpProblem[];
}

interface Found {
  server: Omit<AgentMcpServer, "locations">;
  location: AgentMcpLocation;
}

interface Source {
  agent: string;
  file: string;
  format: "json" | "toml";
  scope: "user" | "project";
  project: string | null;
  read(document: Fields): Array<[name: string, fields: Fields, project: string | null]>;
}

function record(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function names(value: unknown): string[] {
  return Object.keys(record(value) ?? {}).sort((left, right) => left.localeCompare(right));
}

function directory(env: Env, variable: string, fallback: string): string {
  const value = env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

function redactArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (previous?.startsWith("-") && !previous.includes("=") && SECRET_NAME.test(previous) && !arg.startsWith("-")) return REDACTED;
    const assigned = /^(-{0,2}[A-Za-z0-9_.-]+)=(.+)$/.exec(arg);
    if (assigned && SECRET_NAME.test(assigned[1]!)) return `${assigned[1]}=${REDACTED}`;
    return redactSecrets(arg);
  });
}

function redactUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not an absolute address; show it with only the generic credential shapes removed.
    return redactSecrets(value);
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  const query = [...url.searchParams.keys()].some((key) => SECRET_NAME.test(key))
    ? `?${url.search.slice(1).split("&").map((pair) => {
      const [key = "", ...rest] = pair.split("=");
      return rest.length && SECRET_NAME.test(decodeURIComponent(key)) ? `${key}=${REDACTED}` : pair;
    }).join("&")}`
    : url.search;
  return `${url.origin}${url.pathname}${query}${url.hash}`;
}

/**
 * Reads one server entry. The agents spell the same fields differently: OpenCode puts the whole
 * command line in `command` and the variables in `environment`, Gemini CLI and Qwen Code use
 * `httpUrl` for streamable HTTP, Codex names a bearer token variable and separate header tables.
 */
function serverFrom(fields: Fields): Omit<AgentMcpServer, "name" | "locations"> | null {
  const commandLine = Array.isArray(fields.command) ? texts(fields.command) : [];
  const command = commandLine[0] ?? text(fields.command);
  const url = text(fields.httpUrl) ?? text(fields.url) ?? text(fields.serverUrl);
  if (!command && !url) return null;
  const headerNames = new Set([...names(fields.headers), ...names(fields.http_headers), ...names(fields.env_http_headers)]);
  if (text(fields.bearer_token_env_var)) headerNames.add("Authorization");
  return {
    transport: command ? "stdio" : "http",
    command,
    args: command ? redactArgs([...commandLine.slice(1), ...texts(fields.args)]) : [],
    url: command || !url ? null : redactUrl(url),
    envNames: command ? [...new Set([...names(fields.env), ...names(fields.environment)])].sort((left, right) => left.localeCompare(right)) : [],
    headerNames: [...headerNames].sort((left, right) => left.localeCompare(right)),
    disabled: fields.enabled === false || fields.disabled === true,
  };
}

function entries(value: unknown, project: string | null = null): Array<[string, Fields, string | null]> {
  return Object.entries(record(value) ?? {}).flatMap(([name, fields]) => {
    const entry = record(fields);
    return entry ? [[name, entry, project] as [string, Fields, string | null]] : [];
  });
}

function userSources(home: string, env: Env): Source[] {
  const claude = env.CLAUDE_CONFIG_DIR?.trim() && path.isAbsolute(env.CLAUDE_CONFIG_DIR.trim())
    ? path.join(env.CLAUDE_CONFIG_DIR.trim(), ".claude.json")
    : path.join(home, ".claude.json");
  const codex = directory(env, "CODEX_HOME", path.join(home, ".codex"));
  const opencode = path.join(directory(env, "XDG_CONFIG_HOME", path.join(home, ".config")), "opencode");
  const qwen = directory(env, "QWEN_HOME", path.join(home, ".qwen"));
  const user = { scope: "user" as const, project: null };
  return [
    {
      ...user, agent: "Claude Code", file: claude, format: "json",
      // `projects` holds the servers Claude Code adds with local scope, keyed by project folder.
      read: (document) => [
        ...entries(document.mcpServers),
        ...Object.entries(record(document.projects) ?? {}).flatMap(([folder, settings]) => entries(record(settings)?.mcpServers, folder)),
      ],
    },
    { ...user, agent: "Codex", file: path.join(codex, "config.toml"), format: "toml", read: (document) => entries(document.mcp_servers) },
    { ...user, agent: "Gemini CLI", file: path.join(home, ".gemini", "settings.json"), format: "json", read: (document) => entries(document.mcpServers) },
    { ...user, agent: "Qwen Code", file: path.join(qwen, "settings.json"), format: "json", read: (document) => entries(document.mcpServers) },
    { ...user, agent: "OpenCode", file: path.join(opencode, "opencode.json"), format: "json", read: (document) => entries(document.mcp) },
    { ...user, agent: "Cursor", file: path.join(home, ".cursor", "mcp.json"), format: "json", read: (document) => entries(document.mcpServers) },
    { ...user, agent: "ZCode", file: path.join(home, ".zcode", "cli", "config.json"), format: "json", read: (document) => entries(record(document.mcp)?.servers) },
  ];
}

function projectSources(project: string): Source[] {
  const source = { scope: "project" as const, project };
  return [
    { ...source, agent: "Claude Code", file: path.join(project, ".mcp.json"), format: "json", read: (document) => entries(document.mcpServers, project) },
    { ...source, agent: "Codex", file: path.join(project, ".codex", "config.toml"), format: "toml", read: (document) => entries(document.mcp_servers, project) },
    { ...source, agent: "Gemini CLI", file: path.join(project, ".gemini", "settings.json"), format: "json", read: (document) => entries(document.mcpServers, project) },
    { ...source, agent: "Qwen Code", file: path.join(project, ".qwen", "settings.json"), format: "json", read: (document) => entries(document.mcpServers, project) },
    { ...source, agent: "OpenCode", file: path.join(project, "opencode.json"), format: "json", read: (document) => entries(document.mcp, project) },
    { ...source, agent: "Cursor", file: path.join(project, ".cursor", "mcp.json"), format: "json", read: (document) => entries(document.mcpServers, project) },
  ];
}

async function readSource(source: Source): Promise<{ found: Found[]; problem: AgentMcpProblem | null }> {
  let content: string;
  try {
    content = await fs.readFile(source.file, "utf8");
  } catch (error) {
    // Most agents and projects do not have every file; only an unreadable existing file is a problem.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { found: [], problem: null };
    return { found: [], problem: { file: source.file, message: `Could not read ${path.basename(source.file)}: ${(error as Error).message}` } };
  }
  let document: Fields | null;
  try {
    document = record(source.format === "toml" ? parseToml(content) : JSON.parse(content));
  } catch {
    // The agent reports its own broken file; here it only stops this file from being listed.
    return { found: [], problem: { file: source.file, message: `${path.basename(source.file)} is not valid ${source.format === "toml" ? "TOML" : "JSON"}.` } };
  }
  const found = source.read(document ?? {}).flatMap(([name, fields, project]) => {
    const server = serverFrom(fields);
    return server ? [{
      server: { name, ...server },
      location: { agent: source.agent, scope: project ? "project" as const : source.scope, project, file: source.file },
    }] : [];
  });
  return { found, problem: null };
}

function signature(server: Omit<AgentMcpServer, "locations">): string {
  return [server.name, server.transport, server.command ?? "", server.args.join("\u0000"), server.url ?? ""].join("\n");
}

/**
 * Finds the MCP servers configured in the agents on this machine and in the given project
 * folders. The same server declared in several places is listed once with every location.
 * Only names of variables and headers are returned: their values are often credentials.
 */
export async function findAgentMcpServers(input: { home: string; env: Env; projects: readonly string[] }): Promise<AgentMcpCatalog> {
  const user = userSources(input.home, input.env);
  // A project at the home folder would read `~/.codex/config.toml` a second time as a project file.
  const userFiles = new Set(user.map((source) => path.resolve(source.file)));
  const sources = [
    ...user,
    ...[...new Set(input.projects)].filter((project) => path.isAbsolute(project)).flatMap(projectSources)
      .filter((source) => !userFiles.has(path.resolve(source.file))),
  ];
  const results = await Promise.all(sources.map(readSource));
  const servers = new Map<string, AgentMcpServer>();
  for (const { server, location } of results.flatMap((result) => result.found)) {
    const key = signature(server);
    const existing = servers.get(key);
    if (!existing) {
      servers.set(key, { ...server, locations: [location] });
      continue;
    }
    existing.disabled &&= server.disabled;
    existing.envNames = [...new Set([...existing.envNames, ...server.envNames])].sort((left, right) => left.localeCompare(right));
    existing.headerNames = [...new Set([...existing.headerNames, ...server.headerNames])].sort((left, right) => left.localeCompare(right));
    existing.locations.push(location);
  }
  return {
    servers: [...servers.values()].sort((left, right) => left.name.localeCompare(right.name) || (left.url ?? left.command ?? "").localeCompare(right.url ?? right.command ?? "")),
    problems: results.flatMap((result) => result.problem ? [result.problem] : []),
  };
}
