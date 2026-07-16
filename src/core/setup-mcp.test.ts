import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { applyClaudeConfig, applyCodexConfig, removeCodexBlock } = require(path.resolve("bin", "setup-mcp.cjs")) as {
  applyClaudeConfig: (config: unknown, scriptPath: string, remove: boolean) => Record<string, unknown>;
  applyCodexConfig: (toml: string, scriptPath: string, remove: boolean, command?: string) => string;
  removeCodexBlock: (toml: string) => string;
};

describe("setup-mcp Claude config", () => {
  it("adds the server while preserving existing config", () => {
    const next = applyClaudeConfig({ projects: { a: 1 } }, "/abs/server.mjs", false);
    expect(next).toMatchObject({ projects: { a: 1 } });
    expect(next.mcpServers).toEqual({ "agent-recall": { command: "node", args: ["/abs/server.mjs"] } });
  });

  it("removes only our server", () => {
    const start = applyClaudeConfig({ mcpServers: { other: { command: "x" } } }, "/abs/server.mjs", false);
    const removed = applyClaudeConfig(start, "/abs/server.mjs", true);
    expect(removed.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("drops the mcpServers key entirely when empty after removal", () => {
    const start = applyClaudeConfig({}, "/abs/server.mjs", false);
    expect(applyClaudeConfig(start, "/abs/server.mjs", true)).not.toHaveProperty("mcpServers");
  });
});

describe("setup-mcp Codex config", () => {
  it("appends the block and is idempotent", () => {
    const once = applyCodexConfig("[other]\nx = 1\n", "/abs/server.mjs", false);
    expect(once).toContain("[mcp_servers.agent_recall]");
    expect(once).toContain('args = ["/abs/server.mjs"]');
    const twice = applyCodexConfig(once, "/abs/server.mjs", false);
    expect(twice.match(/\[mcp_servers\.agent_recall\]/g)).toHaveLength(1);
    expect(twice).toContain("[other]");
  });

  it("removes the block without touching other tables", () => {
    const withBlock = applyCodexConfig("[other]\nx = 1\n", "/abs/server.mjs", false);
    const removed = applyCodexConfig(withBlock, "/abs/server.mjs", true);
    expect(removed).not.toContain("mcp_servers.agent_recall");
    expect(removed).toContain("[other]");
    expect(removeCodexBlock(removed)).toBe(removed);
  });

  it("escapes Windows backslash paths into valid TOML", () => {
    const toml = applyCodexConfig("", "C:\\Users\\me\\bin\\server.mjs", false, "C:\\Program Files\\nodejs\\node.exe");
    expect(toml).toContain('args = ["C:\\\\Users\\\\me\\\\bin\\\\server.mjs"]');
    expect(toml).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });
});
