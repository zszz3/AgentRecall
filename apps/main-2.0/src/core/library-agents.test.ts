import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLibraryAgents } from "./library-agents";

let home = "";
afterEach(async () => { if (home) await fs.rm(home, { recursive: true, force: true }); });

async function put(relative: string, text = "") {
  const file = path.join(home, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

describe("library agents", () => {
  it("finds each agent's user-level instructions file where that agent reads it", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "library-agents-"));
    await put(".claude/settings.json", "{}");
    await put(".codex/AGENTS.override.md", "x");
    await put(".pi/agent/CLAUDE.md", "mine");
    await put(".stepcode/agent/CLAUDE.md", "mine");
    await put(".qwen/settings.json", JSON.stringify({ context: { fileName: ["AGENTS.md", "QWEN.md"] } }));
    await fs.mkdir(path.join(home, ".cursor"));
    const agents = await resolveLibraryAgents(home, { DSH_HOME: path.join(home, "dsh-home") });
    const byId = Object.fromEntries(agents.map((agent) => [agent.id, agent]));

    expect(agents.map((agent) => agent.id)).toEqual(["claude-code", "codex", "gemini", "opencode", "pi", "stepcode", "qwen", "cursor", "dsh", "zcode"]);
    expect(byId["claude-code"]).toMatchObject({ installed: true, instructions: path.join(home, ".claude", "CLAUDE.md"), override: null });
    expect(byId.codex).toMatchObject({ installed: true, instructions: path.join(home, ".codex", "AGENTS.md"), override: path.join(home, ".codex", "AGENTS.override.md") });
    expect(byId.gemini).toMatchObject({ installed: false, instructions: path.join(home, ".gemini", "GEMINI.md") });
    expect(byId.opencode.instructions).toBe(path.join(home, ".config", "opencode", "AGENTS.md"));
    expect(byId.pi).toMatchObject({ installed: true, instructions: path.join(home, ".pi", "agent", "CLAUDE.md") });
    expect(byId.stepcode).toMatchObject({ installed: true, instructions: path.join(home, ".stepcode", "agent", "CLAUDE.md") });
    expect(byId.qwen).toMatchObject({ installed: true, instructions: path.join(home, ".qwen", "AGENTS.md") });
    expect(byId.cursor).toMatchObject({ installed: true, instructions: null });
    expect(byId.dsh).toMatchObject({ installed: false, instructions: path.join(home, "dsh-home", "AGENTS.md") });
    expect(byId.zcode.instructions).toBe(path.join(home, ".zcode", "AGENTS.md"));
  });

  it("follows the folders the agents' environment variables choose", async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "library-agents-"));
    const custom = (name: string) => path.join(home, "custom", name);
    const agents = await resolveLibraryAgents(home, {
      CLAUDE_CONFIG_DIR: custom("claude"), CODEX_HOME: custom("codex"), XDG_CONFIG_HOME: custom("xdg"),
      PI_CODING_AGENT_DIR: custom("pi"), STEP_CODING_AGENT_DIR: custom("step"), QWEN_HOME: custom("qwen"),
    });
    const files = Object.fromEntries(agents.map((agent) => [agent.id, agent.instructions]));
    expect(files).toMatchObject({
      "claude-code": path.join(custom("claude"), "CLAUDE.md"),
      codex: path.join(custom("codex"), "AGENTS.md"),
      opencode: path.join(custom("xdg"), "opencode", "AGENTS.md"),
      pi: path.join(custom("pi"), "AGENTS.md"),
      stepcode: path.join(custom("step"), "AGENTS.md"),
      qwen: path.join(custom("qwen"), "QWEN.md"),
    });
  });
});
