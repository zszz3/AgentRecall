import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { removeLegacyMemoryHooks } = require("../bin/remove-legacy-memory-hooks.cjs");

function temporaryHome(context) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-legacy-memory-hooks-"));
  context.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const memoryHook = (agent, event) => ({
  type: "command",
  command: `"node" "/global/bin/openviking-memory-hook.cjs" --agent ${agent} --event ${event} --manifest "/m.json"`,
  timeout: 8,
});

test("removes only the retired memory hooks and OpenCode wrapper", (context) => {
  const homeDir = temporaryHome(context);
  const claudePath = path.join(homeDir, ".claude", "settings.json");
  const codexPath = path.join(homeDir, ".codex", "hooks.json");
  const pluginsDir = path.join(homeDir, ".config", "opencode", "plugins");
  const unrelatedHook = { type: "command", command: "echo keep-me" };
  writeJson(claudePath, {
    theme: "dark",
    hooks: {
      UserPromptSubmit: [
        { matcher: "", hooks: [memoryHook("claude", "UserPromptSubmit"), unrelatedHook] },
      ],
      Stop: [{ matcher: "", hooks: [memoryHook("claude", "Stop")] }],
    },
  });
  writeJson(codexPath, { hooks: { Stop: [{ matcher: "*", hooks: [memoryHook("codex", "Stop")] }] } });
  fs.mkdirSync(pluginsDir, { recursive: true });
  const wrapperPath = path.join(pluginsDir, "agent-recall-openviking.js");
  fs.writeFileSync(wrapperPath, 'import { createAgentRecallOpenVikingPlugin } from "file:///x.mjs";\n');
  const userPluginPath = path.join(pluginsDir, "my-plugin.js");
  fs.writeFileSync(userPluginPath, "export const Mine = async () => ({});\n");

  assert.deepEqual(removeLegacyMemoryHooks({ homeDir }), { status: "removed" });

  assert.deepEqual(readJson(claudePath), {
    theme: "dark",
    hooks: { UserPromptSubmit: [{ matcher: "", hooks: [unrelatedHook] }] },
  });
  assert.deepEqual(readJson(codexPath), {});
  assert.equal(fs.existsSync(wrapperPath), false);
  assert.equal(fs.existsSync(userPluginPath), true);

  assert.deepEqual(removeLegacyMemoryHooks({ homeDir }), { status: "unchanged" });
});

test("leaves missing files absent and keeps a same-named file it did not write", (context) => {
  const homeDir = temporaryHome(context);
  const wrapperPath = path.join(homeDir, ".config", "opencode", "plugins", "agent-recall-openviking.js");
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, "export const Custom = async () => ({});\n");

  assert.deepEqual(removeLegacyMemoryHooks({ homeDir }), { status: "unchanged" });
  assert.equal(fs.existsSync(path.join(homeDir, ".claude", "settings.json")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".codex", "hooks.json")), false);
  assert.equal(fs.existsSync(wrapperPath), true);
});

test("reports unreadable settings without rewriting them", (context) => {
  const homeDir = temporaryHome(context);
  const claudePath = path.join(homeDir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  fs.writeFileSync(claudePath, "{ not json");

  const result = removeLegacyMemoryHooks({ homeDir });
  assert.equal(result.status, "error");
  assert.match(result.detail, /settings\.json/u);
  assert.equal(fs.readFileSync(claudePath, "utf8"), "{ not json");
});

test("retired hook entry points exit cleanly until the cleanup has run", async () => {
  const hook = spawnSync(process.execPath, [
    path.join(import.meta.dirname, "..", "bin", "openviking-memory-hook.cjs"),
    "--agent", "claude", "--event", "UserPromptSubmit", "--manifest", "/missing.json",
  ], { input: '{"prompt":"hi"}', encoding: "utf8" });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "");
  assert.equal(hook.stderr, "");

  const pluginUrl = pathToFileURL(path.join(import.meta.dirname, "..", "bin", "openviking-opencode-plugin.mjs")).href;
  const { createAgentRecallOpenVikingPlugin } = await import(pluginUrl);
  const plugin = createAgentRecallOpenVikingPlugin("/missing.json");
  assert.deepEqual(await plugin({ directory: "/tmp" }), {});
});
