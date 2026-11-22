import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import type { LibraryAgentId } from "./library-agent-ids";
import type { LibraryFileItem, LibraryFileKind } from "./library-file-item";

type Env = Record<string, string | undefined>;

/** How one agent stores one slash command or subagent per file. */
type FileFormat = "markdown" | "toml-command" | "codex-agent";

export interface LibraryFileTarget {
  id: LibraryAgentId;
  directory: string;
  extension: ".md" | ".toml";
  format: FileFormat;
  /** Front matter fields written before `description` in Markdown files. */
  named: boolean;
  /** Extra front matter written after `description`. */
  extra: Record<string, string>;
  /** The agent writes the command's arguments as `{{args}}` instead of `$ARGUMENTS`. */
  braces: boolean;
}

function directory(env: Env, variable: string, fallback: string): string {
  const value = env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

const markdown = (id: LibraryAgentId, folder: string, options: Partial<LibraryFileTarget> = {}): LibraryFileTarget =>
  ({ id, directory: folder, extension: ".md", format: "markdown", named: false, extra: {}, braces: false, ...options });

/**
 * The user-level folders holding one file per slash command or subagent. Codex
 * has no user slash commands; DeepSeek Harness and ZCode have neither.
 */
export function libraryFileTargets(kind: LibraryFileKind, home: string, env: Env): LibraryFileTarget[] {
  const claude = directory(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
  const codex = directory(env, "CODEX_HOME", path.join(home, ".codex"));
  const gemini = path.join(home, ".gemini");
  const opencode = path.join(directory(env, "XDG_CONFIG_HOME", path.join(home, ".config")), "opencode");
  const pi = directory(env, "PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  const stepcode = directory(env, "STEP_CODING_AGENT_DIR", path.join(home, ".stepcode", "agent"));
  const qwen = directory(env, "QWEN_HOME", path.join(home, ".qwen"));
  if (kind === "commands") {
    return [
      markdown("claude-code", path.join(claude, "commands")),
      { id: "gemini", directory: path.join(gemini, "commands"), extension: ".toml", format: "toml-command", named: false, extra: {}, braces: true },
      markdown("opencode", path.join(opencode, "commands")),
      markdown("pi", path.join(pi, "prompts")),
      markdown("stepcode", path.join(stepcode, "prompts")),
      markdown("qwen", path.join(qwen, "commands"), { braces: true }),
    ];
  }
  return [
    markdown("claude-code", path.join(claude, "agents"), { named: true }),
    { id: "codex", directory: path.join(codex, "agents"), extension: ".toml", format: "codex-agent", named: true, extra: {}, braces: false },
    markdown("gemini", path.join(gemini, "agents"), { named: true }),
    markdown("opencode", path.join(opencode, "agents"), { extra: { mode: "subagent" } }),
    markdown("qwen", path.join(qwen, "agents"), { named: true }),
    markdown("cursor", path.join(home, ".cursor", "agents"), { named: true }),
  ];
}

const toBraces = (text: string) => text.replaceAll("$ARGUMENTS", "{{args}}");
const fromBraces = (text: string) => text.replaceAll("{{args}}", "$ARGUMENTS");

/** The file AgentRecall writes for one Library item. */
export function renderLibraryFile(target: LibraryFileTarget, name: string, item: LibraryFileItem): string {
  const body = target.braces ? toBraces(item.body.trim()) : item.body.trim();
  switch (target.format) {
    case "toml-command":
      return `${stringifyToml({ description: item.description, prompt: body }).trim()}\n`;
    case "codex-agent":
      return `${stringifyToml({ name, description: item.description, developer_instructions: body }).trim()}\n`;
    case "markdown": {
      const fields = { ...(target.named ? { name } : {}), description: item.description, ...target.extra };
      const header = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
      return `---\n${header}\n---\n\n${body}\n`;
    }
  }
}

const text = (value: unknown) => typeof value === "string" ? value : "";

/** Reads one agent file back into the Library's shape, or null when it cannot be parsed. */
export function parseLibraryFile(target: LibraryFileTarget, content: string): LibraryFileItem | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (target.format !== "markdown") {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(normalized) as Record<string, unknown>;
    } catch {
      // Another tool's broken file is not offered for import.
      return null;
    }
    const body = text(target.format === "toml-command" ? parsed.prompt : parsed.developer_instructions).trim();
    if (!body) return null;
    return { description: text(parsed.description), body: target.braces ? fromBraces(body) : body };
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  let fields: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed: unknown = parseYaml(match[1]!, { logLevel: "error" });
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const body = (match ? match[2]! : normalized).trim();
  if (!body) return null;
  return { description: text(fields.description), body: target.braces ? fromBraces(body) : body };
}
