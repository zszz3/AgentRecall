import fs from "node:fs/promises";
import path from "node:path";

type Env = Record<string, string | undefined>;

/** Files larger than this are listed but not shown; the user opens them in an editor instead. */
const MAX_SHOWN_BYTES = 1024 * 1024;

/** Instruction files an agent may read at a project's root, in the order they are listed. */
const PROJECT_FILES = [
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  "QWEN.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];
/** Cursor keeps one rule per file in this folder. */
const CURSOR_RULES = ".cursor/rules";

export interface AgentInstructionFiles {
  name: string;
  /** The user-level files the agent reads, whether or not they exist yet. */
  files: string[];
}

export interface InstructionFile {
  /** The path where the file was found. */
  path: string;
  /** The file name, relative to the project for project files. */
  name: string;
  scope: "user" | "project";
  /** Agents that read this file as their user-level instructions; empty for project files. */
  agents: string[];
  /** The project folder for project files. */
  project: string | null;
  /** Other paths found that point to this same file through symbolic links. */
  aliases: string[];
  size: number;
  modifiedAt: string;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Pi and StepCode read the first of these that exists. */
async function firstThere(directory: string): Promise<string> {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const file = path.join(directory, name);
    if (await exists(file)) return file;
  }
  return path.join(directory, "AGENTS.md");
}

/** Qwen Code's `context.fileName` renames its instructions file; it reads the first name. */
async function qwenFileName(directory: string): Promise<string> {
  let settings: unknown;
  try {
    settings = JSON.parse(await fs.readFile(path.join(directory, "settings.json"), "utf8"));
  } catch {
    // A missing or unreadable settings file leaves Qwen Code on its default name, as it does for Qwen Code itself.
    return "QWEN.md";
  }
  const name = (settings as { context?: { fileName?: unknown } } | null)?.context?.fileName;
  const first = Array.isArray(name) ? name[0] : name;
  return typeof first === "string" && first.trim() && !/[\\/]/.test(first) ? first.trim() : "QWEN.md";
}

function directory(env: Env, variable: string, fallback: string): string {
  const value = env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

/**
 * Where each agent reads its user-level instructions. Codex, Pi and StepCode also read
 * `AGENTS.override.md` instead of their file while it exists.
 */
export async function resolveAgentInstructionFiles(home: string, env: Env): Promise<AgentInstructionFiles[]> {
  const claude = directory(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
  const codex = directory(env, "CODEX_HOME", path.join(home, ".codex"));
  const opencode = path.join(directory(env, "XDG_CONFIG_HOME", path.join(home, ".config")), "opencode");
  const pi = directory(env, "PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  const stepcode = directory(env, "STEP_CODING_AGENT_DIR", path.join(home, ".stepcode", "agent"));
  const qwen = directory(env, "QWEN_HOME", path.join(home, ".qwen"));
  const dsh = directory(env, "DSH_HOME", path.join(home, ".dsh"));
  return [
    { name: "Claude Code", files: [path.join(claude, "CLAUDE.md")] },
    { name: "Codex", files: [path.join(codex, "AGENTS.md"), path.join(codex, "AGENTS.override.md")] },
    { name: "Gemini CLI", files: [path.join(home, ".gemini", "GEMINI.md")] },
    { name: "OpenCode", files: [path.join(opencode, "AGENTS.md")] },
    { name: "Pi", files: [await firstThere(pi), path.join(pi, "AGENTS.override.md")] },
    { name: "StepCode", files: [await firstThere(stepcode), path.join(stepcode, "AGENTS.override.md")] },
    { name: "Qwen Code", files: [path.join(qwen, await qwenFileName(qwen))] },
    { name: "DeepSeek Harness", files: [path.join(dsh, "AGENTS.md")] },
    { name: "ZCode", files: [path.join(home, ".zcode", "AGENTS.md")] },
  ].map((agent) => ({ name: agent.name, files: agent.files.filter((file, index, all) => all.indexOf(file) === index) }));
}

interface Candidate {
  file: string;
  name: string;
  scope: "user" | "project";
  agent: string | null;
  project: string | null;
}

async function cursorRules(project: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(project, CURSOR_RULES), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.mdc?$/i.test(entry.name))
      .map((entry) => `${CURSOR_RULES}/${entry.name}`)
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    // Most projects have no Cursor rules; any other failure is reported for the whole listing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Finds the instruction files agents read on this machine: every agent's user-level file that
 * exists, and the instruction files at the root of the given project folders. A file reached
 * through several paths (symbolic links) is listed once, with the other paths as aliases.
 */
export async function findInstructionFiles(input: { home: string; env: Env; projects: readonly string[] }): Promise<InstructionFile[]> {
  const candidates: Candidate[] = [];
  for (const agent of await resolveAgentInstructionFiles(input.home, input.env)) {
    for (const file of agent.files) candidates.push({ file, name: path.basename(file), scope: "user", agent: agent.name, project: null });
  }
  for (const project of new Set(input.projects)) {
    if (!path.isAbsolute(project)) continue;
    for (const name of [...PROJECT_FILES, ...await cursorRules(project)]) {
      candidates.push({ file: path.join(project, ...name.split("/")), name, scope: "project", agent: null, project });
    }
  }

  const found = new Map<string, InstructionFile>();
  const located = await Promise.all(candidates.map(async (candidate) => {
    try {
      const stat = await fs.stat(candidate.file);
      if (!stat.isFile()) return null;
      return { candidate, stat, real: await fs.realpath(candidate.file) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }));
  for (const entry of located) {
    if (!entry) continue;
    const { candidate, stat, real } = entry;
    const known = found.get(real);
    if (known) {
      if (candidate.agent && !known.agents.includes(candidate.agent)) known.agents.push(candidate.agent);
      if (candidate.file !== known.path && !known.aliases.includes(candidate.file)) known.aliases.push(candidate.file);
      continue;
    }
    found.set(real, {
      path: candidate.file,
      name: candidate.name,
      scope: candidate.scope,
      agents: candidate.agent ? [candidate.agent] : [],
      project: candidate.project,
      aliases: [],
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return [...found.values()];
}

export async function readInstructionFile(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_SHOWN_BYTES) throw new Error(`${path.basename(file)} is larger than 1 MB. Open it in an editor instead.`);
  return fs.readFile(file, "utf8");
}
