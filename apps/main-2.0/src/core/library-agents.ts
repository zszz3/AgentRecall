import fs from "node:fs/promises";
import path from "node:path";

import type { LibraryAgentId } from "./library-agent-ids";

export interface LibraryAgent {
  id: LibraryAgentId;
  name: string;
  /** The agent's folder exists on this machine. */
  installed: boolean;
  /** The user-level instructions file the agent reads, or null when it has none. */
  instructions: string | null;
  /** A file the agent reads instead of `instructions` while it exists (Codex, Pi and StepCode's AGENTS.override.md). */
  override: string | null;
}

type Env = Record<string, string | undefined>;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Pi and StepCode read the first of these that exists; the user's own CLAUDE.md is then the file to write. */
async function firstThere(directory: string): Promise<string> {
  for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const file = path.join(directory, name);
    if (await exists(file)) return file;
  }
  return path.join(directory, "AGENTS.md");
}

/** Qwen Code's `context.fileName` renames its instructions file; the first name is the one it writes itself. */
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

async function overrideOf(directory: string): Promise<string | null> {
  const file = path.join(directory, "AGENTS.override.md");
  return await exists(file) ? file : null;
}

function directory(env: Env, variable: string, fallback: string): string {
  const value = env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

/** Where each supported agent keeps its user-level files on this machine. */
export async function resolveLibraryAgents(home: string, env: Env): Promise<LibraryAgent[]> {
  const claude = directory(env, "CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
  const codex = directory(env, "CODEX_HOME", path.join(home, ".codex"));
  const gemini = path.join(home, ".gemini");
  const opencode = path.join(directory(env, "XDG_CONFIG_HOME", path.join(home, ".config")), "opencode");
  const pi = directory(env, "PI_CODING_AGENT_DIR", path.join(home, ".pi", "agent"));
  const stepcode = directory(env, "STEP_CODING_AGENT_DIR", path.join(home, ".stepcode", "agent"));
  const qwen = directory(env, "QWEN_HOME", path.join(home, ".qwen"));
  const cursor = path.join(home, ".cursor");
  const dsh = directory(env, "DSH_HOME", path.join(home, ".dsh"));
  const zcode = path.join(home, ".zcode");
  const agent = async (id: LibraryAgentId, name: string, folder: string, instructions: string | null, override: string | null = null): Promise<LibraryAgent> =>
    ({ id, name, installed: await exists(folder), instructions, override });
  return Promise.all([
    agent("claude-code", "Claude Code", claude, path.join(claude, "CLAUDE.md")),
    agent("codex", "Codex", codex, path.join(codex, "AGENTS.md"), await overrideOf(codex)),
    agent("gemini", "Gemini CLI", gemini, path.join(gemini, "GEMINI.md")),
    agent("opencode", "OpenCode", opencode, path.join(opencode, "AGENTS.md")),
    agent("pi", "Pi", pi, await firstThere(pi), await overrideOf(pi)),
    agent("stepcode", "StepCode", path.dirname(stepcode), await firstThere(stepcode), await overrideOf(stepcode)),
    agent("qwen", "Qwen Code", qwen, path.join(qwen, await qwenFileName(qwen))),
    agent("cursor", "Cursor", cursor, null),
    agent("dsh", "DeepSeek Harness", dsh, path.join(dsh, "AGENTS.md")),
    agent("zcode", "ZCode", zcode, path.join(zcode, "AGENTS.md")),
  ]);
}
