import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  reconcileOpenVikingMemoryHooks,
  openVikingMemoryHookStatus,
} = require("../bin/setup-openviking-memory-hooks.cjs");

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
    manifestPath: path.join(testHome, ".agent-recall", "openviking", "hook-manifest.json"),
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

function hasAgentRecallHook(entry) {
  return entry?.hooks?.some((hook) => hook.command?.includes("openviking-memory-hook.cjs"));
}
