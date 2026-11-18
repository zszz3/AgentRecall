import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const {
  applyClaudeConfig,
  applyCodexConfig,
  applyDshConfig,
  removeCodexBlock,
  removeDshBlock,
  serverDefinition,
} = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/setup-mcp.cjs")) as {
  applyClaudeConfig: (config: unknown, scriptPath: string, remove: boolean) => Record<string, unknown>;
  applyCodexConfig: (toml: string, scriptPath: string, remove: boolean, command?: string) => string;
  applyDshConfig: (yaml: string, scriptPath: string, remove: boolean, command?: string) => string;
  removeCodexBlock: (toml: string) => string;
  removeDshBlock: (yaml: string) => string;
  serverDefinition: () => { command: string };
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

describe("setup-mcp DeepSeek Harness config", () => {
  it("appends the mcp-client insert and is idempotent", () => {
    const once = applyDshConfig("- id: llm-pi-ai\n  config: {}\n", "/abs/server.mjs", false, "/usr/bin/node");
    expect(once).toContain("- insert:");
    expect(once).toContain("- id: mcp-agent-recall");
    expect(once).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(once).toContain("serverName: agent-recall");
    expect(once).toContain('command: "/usr/bin/node"');
    expect(once).toContain('args: ["/abs/server.mjs"]');
    const twice = applyDshConfig(once, "/abs/server.mjs", false, "/usr/bin/node");
    expect(twice.match(/id: mcp-agent-recall/g)).toHaveLength(1);
    expect(twice).toContain("llm-pi-ai");
  });

  it("removes only our insert, preserving user rows", () => {
    const withBlock = applyDshConfig("- id: user-row\n  config: {}\n", "/abs/server.mjs", false);
    const removed = removeDshBlock(withBlock);
    expect(removed).not.toContain("mcp-agent-recall");
    expect(removed).toContain("user-row");
    expect(applyDshConfig(removed, "/abs/server.mjs", true)).toBe(`${removed}\n`);
  });

  it("keeps an empty patch valid after uninstall and allows reinstall", () => {
    const installed = applyDshConfig("", "/abs/server.mjs", false);
    const removed = applyDshConfig(installed, "/abs/server.mjs", true);
    expect(removed).toContain("[]");
    const reinstalled = applyDshConfig(removed, "/abs/server.mjs", false);
    expect(reinstalled.match(/id: mcp-agent-recall/g)).toHaveLength(1);
    expect(reinstalled).not.toMatch(/^\[\]\s*\n-/m);
  });

  it("escapes command and script into valid YAML scalars", () => {
    const yaml = applyDshConfig("", "/path/with space/server.mjs", false, "/opt/node 22/bin/node");
    expect(yaml).toContain('command: "/opt/node 22/bin/node"');
    expect(yaml).toContain('args: ["/path/with space/server.mjs"]');
  });
});

describe("setup-mcp node probe", () => {
  it("probes node versions with windowsHide enabled and without a shell", () => {
    const execFileSpy = vi.spyOn(childProcess, "execFileSync").mockReturnValue("v22.14.0\n");
    const execSpy = vi.spyOn(childProcess, "execSync");
    try {
      const def = serverDefinition();
      expect(def.command).toBeTruthy();
      expect(execSpy).not.toHaveBeenCalled();
      expect(execFileSpy).toHaveBeenCalledWith(
        expect.any(String),
        ["-v"],
        expect.objectContaining({ encoding: "utf8", windowsHide: true }),
      );
    } finally {
      execFileSpy.mockRestore();
      execSpy.mockRestore();
    }
  });
});
