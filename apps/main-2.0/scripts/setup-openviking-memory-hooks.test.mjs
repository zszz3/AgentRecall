import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const {
  buildHookCommand,
  reconcileOpenVikingMemoryHooks,
  openVikingMemoryHookStatus,
} = require("../bin/setup-openviking-memory-hooks.cjs");

test("generated hook commands avoid shell-specific control operators", (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-command-failure-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const common = {
    nodePath: path.join(testHome, "missing-agent-recall-node"),
    hookScriptPath: path.join(testHome, "missing-openviking-hook.cjs"),
    manifestPath: path.join(testHome, "missing-openviking-manifest.json"),
  };
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const agent of ["claude", "codex"]) {
      const command = buildHookCommand({ ...common, platform }, agent, "Stop");
      assert.match(command, /--diagnostic-log .*hook-errors\.log/u);
      assert.doesNotMatch(command, /2>>|\|\||\btrue\b|\bexit\b/u);
      if (platform === "win32" && agent === "codex") assert.match(command, /^& "/u);
      else assert.doesNotMatch(command, /^& /u);
    }
  }
});

test("Windows hook commands execute successfully through PowerShell", (context) => {
  if (process.platform !== "win32") return;
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-powershell-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const manifestPath = path.join(testHome, "hook-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    version: 2,
    baseUrl: "http://127.0.0.1:21933",
    integrations: { claude: true, codex: true, opencode: false },
    workspaces: [],
  }));
  const command = buildHookCommand({
    nodePath: process.execPath,
    hookScriptPath: path.join(import.meta.dirname, "..", "bin", "openviking-memory-hook.cjs"),
    manifestPath,
    platform: "win32",
  }, "codex", "UserPromptSubmit");

  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("reconciles Claude, Codex and OpenCode without replacing unrelated config", (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-setup-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const claudePath = path.join(testHome, ".claude", "settings.json");
  const codexPath = path.join(testHome, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(claudePath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "keep-claude" }] }] } }));
  fs.writeFileSync(codexPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "keep-codex" }] }] } }));
  const options = {
    homeDir: testHome,
    hookScriptPath: "/app/bin/openviking-memory-hook.cjs",
    openCodePluginPath: "/app/bin/openviking-opencode-plugin.mjs",
    manifestPath: path.join(testHome, ".agent-recall-v2", "openviking", "hook-manifest.json"),
    nodePath: "/runtime/node",
    integrations: { claude: true, codex: true, opencode: true },
  };

  assert.equal(reconcileOpenVikingMemoryHooks(options).status, "configured");
  const claude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  const codex = JSON.parse(fs.readFileSync(codexPath, "utf8"));
  assert.equal(claude.hooks.Stop[0].hooks[0].command, "keep-claude");
  assert.ok(claude.hooks.UserPromptSubmit.some(hasAgentRecallHook));
  assert.ok(claude.hooks.SessionEnd.some(hasAgentRecallHook));
  assert.equal(codex.hooks.Stop[0].hooks[0].command, "keep-codex");
  assert.ok(codex.hooks.UserPromptSubmit.some(hasAgentRecallHook));
  assert.ok(codex.hooks.PreCompact.some(hasAgentRecallHook));
  assert.ok(codex.hooks.SessionEnd.some(hasAgentRecallHook));
  assert.equal(codex.hooks.SessionEnd.find(hasAgentRecallHook).hooks[0].timeout, 3);
  const openCodeWrapper = path.join(testHome, ".config", "opencode", "plugins", "agent-recall-openviking.js");
  assert.match(fs.readFileSync(openCodeWrapper, "utf8"), /openviking-opencode-plugin/);
  assert.deepEqual(openVikingMemoryHookStatus(options), {
    claude: true,
    codex: true,
    opencode: true,
    error: null,
  });

  assert.equal(reconcileOpenVikingMemoryHooks({
    ...options,
    integrations: { claude: false, codex: false, opencode: false },
  }).status, "configured");
  const nextClaude = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  const nextCodex = JSON.parse(fs.readFileSync(codexPath, "utf8"));
  assert.equal(nextClaude.hooks.Stop[0].hooks[0].command, "keep-claude");
  assert.equal(nextCodex.hooks.Stop[0].hooks[0].command, "keep-codex");
  assert.equal(fs.existsSync(openCodeWrapper), false);
});

test("startup reconciliation replaces stale installed hook commands", (context) => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-openviking-upgrade-"));
  context.after(() => fs.rmSync(testHome, { recursive: true, force: true }));
  const claudePath = path.join(testHome, ".claude", "settings.json");
  const codexPath = path.join(testHome, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  const staleCommand = '"C:\\old-runtime\\node.exe" "C:\\old-app\\openviking-memory-hook.cjs" --agent claude --event UserPromptSubmit --manifest "C:\\old-home\\hook-manifest.json"';
  fs.writeFileSync(claudePath, JSON.stringify({
    hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: staleCommand, timeout: 8 }] }] },
  }));
  fs.writeFileSync(codexPath, JSON.stringify({
    hooks: { UserPromptSubmit: [{ matcher: "*", hooks: [{ type: "command", command: staleCommand.replace("claude", "codex"), timeout: 8 }] }] },
  }));
  const options = {
    homeDir: testHome,
    hookScriptPath: "C:\\current-app\\openviking-memory-hook.cjs",
    openCodePluginPath: "C:\\current-app\\openviking-opencode-plugin.mjs",
    manifestPath: path.join(testHome, ".agent-recall-v2", "openviking", "hook-manifest.json"),
    nodePath: "C:\\current-runtime\\node.exe",
    integrations: { claude: true, codex: true, opencode: false },
  };

  assert.equal(reconcileOpenVikingMemoryHooks(options).status, "configured");

  for (const configPath of [claudePath, codexPath]) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const serialized = JSON.stringify(config);
    assert.doesNotMatch(serialized, /old-runtime|old-app|old-home/u);
    assert.match(serialized, /current-runtime/u);
    assert.match(serialized, /current-app/u);
    assert.match(serialized, /hook-manifest\.json/u);
  }
});

function hasAgentRecallHook(entry) {
  return entry?.hooks?.some((hook) => hook.command?.includes("openviking-memory-hook.cjs"));
}
