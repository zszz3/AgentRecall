import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process") as typeof import("node:child_process");
const {
  applyClaudeConfig,
  applyClaudeSettings,
  applyCodexConfig,
  applyDshConfig,
  clientConnections,
  removeCodexBlock,
  removeDshBlock,
  serverDefinition,
  setClientEnabled,
} = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/setup-mcp.cjs")) as {
  applyClaudeConfig: (config: unknown, scriptPath: string, remove: boolean, command?: string, bridgePath?: string) => Record<string, unknown>;
  applyClaudeSettings: (settings: unknown, remove: boolean) => Record<string, unknown>;
  applyCodexConfig: (toml: string, scriptPath: string, remove: boolean, command?: string, bridgePath?: string) => string;
  applyDshConfig: (yaml: string, scriptPath: string, remove: boolean, command?: string) => string;
  clientConnections: (
    preferences: { codex: boolean; claude: boolean },
    home: string,
  ) => { clients: Array<{ clientId: "codex" | "claude"; detected: boolean; configured: boolean; configPath: string }> };
  removeCodexBlock: (toml: string) => string;
  removeDshBlock: (yaml: string) => string;
  serverDefinition: () => { command: string };
  setClientEnabled: (
    clientId: "codex" | "claude",
    enabled: boolean,
    options: { homeDir: string },
  ) => void;
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

  it("pins the Gateway to the current AgentRecall bridge", () => {
    const next = applyClaudeConfig({}, "/abs/gateway.js", false, "node", "/data/automation-mcp-bridge.json");
    expect(next.mcpServers).toEqual({
      "agent-recall": {
        command: "node",
        args: ["/abs/gateway.js"],
        env: { AGENT_RECALL_MCP_BRIDGE: "/data/automation-mcp-bridge.json" },
      },
    });
  });

  it("trusts only the AgentRecall Gateway tools in Claude Code settings", () => {
    const next = applyClaudeSettings({ permissions: { allow: ["Bash(npm test)"] } }, false);
    expect(next).toEqual({
      permissions: { allow: ["Bash(npm test)", "mcp__agent-recall__*"] },
    });
    expect(applyClaudeSettings(next, true)).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
    });
  });
});

describe("setup-mcp Codex config", () => {
  it("appends the block and is idempotent", () => {
    const once = applyCodexConfig("[other]\nx = 1\n", "/abs/server.mjs", false);
    expect(once).toContain("[mcp_servers.agent_recall]");
    expect(once).toContain('args = ["/abs/server.mjs"]');
    expect(once).toContain('default_tools_approval_mode = "approve"');
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

  it("replaces the legacy v2 entry with the single Gateway entry", () => {
    const next = applyCodexConfig("[mcp_servers.agent_recall_v2]\ncommand = \"node\"\nargs = [\"old.mjs\"]\n", "/abs/gateway.js", false);
    expect(next).not.toContain("agent_recall_v2");
    expect(next).toContain("[mcp_servers.agent_recall]");
    expect(next).toContain('args = ["/abs/gateway.js"]');
  });

  it("replaces nested AgentRecall tables without touching similarly named servers", () => {
    const current = [
      "[mcp_servers.agent_recall.env]",
      'AGENT_RECALL_MCP_BRIDGE = "/old/bridge.json"',
      "",
      "[mcp_servers.agent_recall.tools.search_sessions]",
      'approval_mode = "approve"',
      "",
      "[mcp_servers.agent_recall_v2.env]",
      'AGENT_RECALL_MCP_BRIDGE = "/legacy/bridge.json"',
      "",
      "[mcp_servers.agent_recall_extra]",
      'command = "keep-me"',
    ].join("\n");

    const next = applyCodexConfig(current, "/abs/gateway.js", false, "node", "/new/bridge.json");

    expect(next).not.toContain("[mcp_servers.agent_recall.env]");
    expect(next).not.toContain("[mcp_servers.agent_recall.tools.search_sessions]");
    expect(next).not.toContain("[mcp_servers.agent_recall_v2.env]");
    expect(next).toContain("[mcp_servers.agent_recall_extra]");
    expect(next).toContain('command = "keep-me"');
    expect(next.match(/\[mcp_servers\.agent_recall\]/g)).toHaveLength(1);
    expect(next).toContain('env = { AGENT_RECALL_MCP_BRIDGE = "/new/bridge.json" }');
  });

  it("pins the Gateway to the current AgentRecall bridge", () => {
    const next = applyCodexConfig("", "/abs/gateway.js", false, "node", "/data/automation-mcp-bridge.json");
    expect(next).toContain('env = { AGENT_RECALL_MCP_BRIDGE = "/data/automation-mcp-bridge.json" }');
  });
});

describe("setup-mcp client connections", () => {
  it("detects common CLI install locations without requiring an existing config", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agent-recall-client-detection-"));
    const previous = {
      testHome: process.env.AGENT_RECALL_TEST_HOME,
      codexHome: process.env.CODEX_HOME,
      claudeConfig: process.env.CLAUDE_CONFIG_DIR,
      path: process.env.PATH,
    };
    try {
      process.env.AGENT_RECALL_TEST_HOME = home;
      delete process.env.CODEX_HOME;
      delete process.env.CLAUDE_CONFIG_DIR;
      process.env.PATH = "";
      mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
      writeFileSync(path.join(home, ".local", "bin", "codex"), "", "utf8");

      expect(clientConnections({ codex: true, claude: true }, home).clients)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ clientId: "codex", detected: true }),
          expect.objectContaining({ clientId: "claude", detected: false }),
        ]));
    } finally {
      restoreEnvironment("AGENT_RECALL_TEST_HOME", previous.testHome);
      restoreEnvironment("CODEX_HOME", previous.codexHome);
      restoreEnvironment("CLAUDE_CONFIG_DIR", previous.claudeConfig);
      restoreEnvironment("PATH", previous.path);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("connects and disconnects Codex and Claude Code inside an isolated home", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agent-recall-gateway-config-"));
    const previous = {
      testHome: process.env.AGENT_RECALL_TEST_HOME,
      codexHome: process.env.CODEX_HOME,
      claudeConfig: process.env.CLAUDE_CONFIG_DIR,
      bridge: process.env.AGENT_RECALL_MCP_BRIDGE,
      userData: process.env.AGENT_RECALL_USER_DATA_DIR,
    };
    try {
      const codexHome = path.join(home, ".codex");
      const claudeConfigDir = path.join(home, ".claude-config");
      process.env.AGENT_RECALL_TEST_HOME = home;
      process.env.CODEX_HOME = codexHome;
      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      process.env.AGENT_RECALL_USER_DATA_DIR = path.join(home, "user-data");
      delete process.env.AGENT_RECALL_MCP_BRIDGE;
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(claudeConfigDir, { recursive: true });

      setClientEnabled("codex", true, { homeDir: home });
      setClientEnabled("claude", true, { homeDir: home });

      expect(clientConnections({ codex: true, claude: true }, home).clients)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ clientId: "codex", configured: true }),
          expect.objectContaining({ clientId: "claude", configured: true }),
        ]));
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8"))
        .toContain("AGENT_RECALL_MCP_BRIDGE");
      expect(readFileSync(path.join(claudeConfigDir, ".claude.json"), "utf8"))
        .toContain('"agent-recall"');
      expect(readFileSync(path.join(claudeConfigDir, "settings.json"), "utf8"))
        .toContain('"mcp__agent-recall__*"');

      setClientEnabled("codex", false, { homeDir: home });
      setClientEnabled("claude", false, { homeDir: home });
      expect(clientConnections({ codex: false, claude: false }, home).clients.every((client) => !client.configured)).toBe(true);
      expect(readFileSync(path.join(claudeConfigDir, "settings.json"), "utf8"))
        .not.toContain("mcp__agent-recall__*");
    } finally {
      restoreEnvironment("AGENT_RECALL_TEST_HOME", previous.testHome);
      restoreEnvironment("CODEX_HOME", previous.codexHome);
      restoreEnvironment("CLAUDE_CONFIG_DIR", previous.claudeConfig);
      restoreEnvironment("AGENT_RECALL_MCP_BRIDGE", previous.bridge);
      restoreEnvironment("AGENT_RECALL_USER_DATA_DIR", previous.userData);
      rmSync(home, { recursive: true, force: true });
    }
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
