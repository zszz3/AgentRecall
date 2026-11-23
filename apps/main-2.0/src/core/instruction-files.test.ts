import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findInstructionFiles, readInstructionFile, resolveAgentInstructionFiles } from "./instruction-files";

let root = "";
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

async function put(relative: string, text = "") {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return file;
}

describe("instruction files", () => {
  it("knows where each agent reads its user-level instructions", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-agents-"));
    await put("home/.codex/AGENTS.override.md", "x");
    await put("home/.pi/agent/CLAUDE.md", "mine");
    await put("home/.stepcode/agent/CLAUDE.md", "mine");
    await put("home/.qwen/settings.json", JSON.stringify({ context: { fileName: ["AGENTS.md", "QWEN.md"] } }));
    const home = path.join(root, "home");
    const agents = await resolveAgentInstructionFiles(home, { DSH_HOME: path.join(root, "dsh-home") });
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent.files]));

    expect(agents.map((agent) => agent.name)).toEqual(["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Pi", "StepCode", "Qwen Code", "DeepSeek Harness", "ZCode"]);
    expect(byName["Claude Code"]).toEqual([path.join(home, ".claude", "CLAUDE.md")]);
    expect(byName.Codex).toEqual([path.join(home, ".codex", "AGENTS.md"), path.join(home, ".codex", "AGENTS.override.md")]);
    expect(byName["OpenCode"]).toEqual([path.join(home, ".config", "opencode", "AGENTS.md")]);
    expect(byName.Pi).toEqual([path.join(home, ".pi", "agent", "CLAUDE.md"), path.join(home, ".pi", "agent", "AGENTS.override.md")]);
    expect(byName.StepCode).toEqual([path.join(home, ".stepcode", "agent", "CLAUDE.md"), path.join(home, ".stepcode", "agent", "AGENTS.override.md")]);
    expect(byName["Qwen Code"]).toEqual([path.join(home, ".qwen", "AGENTS.md")]);
    expect(byName["DeepSeek Harness"]).toEqual([path.join(root, "dsh-home", "AGENTS.md")]);
  });

  it("lists the agent files that exist and the instruction files of projects with sessions, once per file", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-files-"));
    const home = path.join(root, "home");
    await put("home/.claude/CLAUDE.md", "# Mine\nAnswer in Chinese.");
    await put("home/.codex/AGENTS.md", "");
    const repo = path.join(root, "repo");
    await put("repo/AGENTS.md", "# Repo rules");
    await fs.symlink("AGENTS.md", path.join(repo, "CLAUDE.md"));
    await put("repo/.cursor/rules/style.mdc", "style");
    await put("repo/.github/copilot-instructions.md", "copilot");
    const other = path.join(root, "other");
    await put("other/GEMINI.md", "gemini");

    const files = await findInstructionFiles({
      home,
      env: {},
      projects: [repo, path.join(root, "missing"), other, repo],
    });

    expect(files.map((file) => ({ scope: file.scope, name: file.name, agents: file.agents, project: file.project, aliases: file.aliases, size: file.size })))
      .toEqual([
        { scope: "user", name: "CLAUDE.md", agents: ["Claude Code"], project: null, aliases: [], size: 25 },
        { scope: "user", name: "AGENTS.md", agents: ["Codex"], project: null, aliases: [], size: 0 },
        { scope: "project", name: "AGENTS.md", agents: [], project: repo, aliases: [path.join(repo, "CLAUDE.md")], size: 12 },
        { scope: "project", name: ".github/copilot-instructions.md", agents: [], project: repo, aliases: [], size: 7 },
        { scope: "project", name: ".cursor/rules/style.mdc", agents: [], project: repo, aliases: [], size: 5 },
        { scope: "project", name: "GEMINI.md", agents: [], project: other, aliases: [], size: 6 },
      ]);
    expect(files[0]).toMatchObject({ path: path.join(home, ".claude", "CLAUDE.md") });
    expect(Number.isNaN(Date.parse(files[0].modifiedAt))).toBe(false);
  });

  it("reads a file and refuses one too large to show", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "instruction-read-"));
    const small = await put("small.md", "hello");
    const large = await put("large.md", "x".repeat(1024 * 1024 + 1));

    await expect(readInstructionFile(small)).resolves.toBe("hello");
    await expect(readInstructionFile(large)).rejects.toThrow("larger than 1 MB");
  });
});
