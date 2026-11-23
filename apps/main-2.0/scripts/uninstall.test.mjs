import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const { uninstall } = require("../bin/uninstall.cjs");
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

test("uninstall removes current and legacy V2 integrations while preserving unrelated config", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-session-uninstall-"));
  temporaryDirectories.add(homeDir);
  const claudeSettings = path.join(homeDir, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(claudeSettings, JSON.stringify({
    theme: "dark",
    statusLine: { type: "command", command: 'node "/global/bin/claude-statusline-snapshot.cjs"' },
    hooks: {
      PostToolUse: [
        { matcher: "Skill", hooks: [{ type: "command", command: 'node "/global/bin/skill-usage-record.cjs"' }] },
        { matcher: "Other", hooks: [{ type: "command", command: "keep-me" }] },
      ],
      Stop: [
        { hooks: [{ type: "command", command: 'node "/global/bin/session-sync-record.cjs" --agent claude' }] },
        { hooks: [{ type: "command", command: 'node "/global/bin/openviking-memory-hook.cjs" --agent claude --event Stop' }] },
        { hooks: [{ type: "command", command: "keep-claude-stop" }] },
      ],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: 'node "/global/bin/openviking-memory-hook.cjs" --agent claude --event UserPromptSubmit' }] },
      ],
    },
  }));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({
    custom: true,
    mcpServers: {
      "agent-recall": { command: "node", args: ["gateway"] },
      "agent-recall-v2": { command: "node", args: ["legacy"] },
      keep: { command: "keep" },
    },
  }));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, ".codex", "config.toml"),
    '[model]\nname="keep"\n\n[mcp_servers.agent_recall]\ncommand="node"\nargs=["gateway"]\n\n[mcp_servers.agent_recall_v2]\ncommand="node"\nargs=["legacy"]\n',
  );
  fs.writeFileSync(path.join(homeDir, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: "command", command: 'node "/global/bin/session-sync-record.cjs" --agent codex' }] },
    { hooks: [{ type: "command", command: 'node "/global/bin/openviking-memory-hook.cjs" --agent codex --event Stop' }] },
    { hooks: [{ type: "command", command: "keep-codex-stop" }] },
  ], UserPromptSubmit: [
    { hooks: [{ type: "command", command: 'node "/global/bin/openviking-memory-hook.cjs" --agent codex --event UserPromptSubmit' }] },
  ] } }));
  const openCodeWrapper = path.join(homeDir, ".config", "opencode", "plugins", "agent-recall-openviking.js");
  fs.mkdirSync(path.dirname(openCodeWrapper), { recursive: true });
  fs.writeFileSync(openCodeWrapper, 'import { createAgentRecallOpenVikingPlugin } from "file:///global/bin/openviking-opencode-plugin.mjs";\n');
  fs.mkdirSync(path.join(homeDir, ".agent-recall-v2"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".agent-recall-v2", "update-check.json"), "{}");
  fs.writeFileSync(path.join(homeDir, ".agent-recall-v2", "update-preferences.json"), '{"enabled":false}');
  fs.writeFileSync(path.join(homeDir, ".agent-recall-v2", "db-path"), "/kept/database.sqlite");
  fs.mkdirSync(path.join(homeDir, ".agent-recall-v2", "session-sync-queue"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".agent-recall-v2", "session-sync-queue", "pending.json"), "{}");

  const result = await uninstall({ homeDir });

  assert.deepEqual(result.errors, []);
  const nextSettings = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(nextSettings.theme, "dark");
  assert.equal(nextSettings.statusLine, undefined);
  assert.equal(nextSettings.hooks.PostToolUse.length, 1);
  assert.equal(nextSettings.hooks.Stop.length, 1);
  assert.equal(nextSettings.hooks.Stop[0].hooks[0].command, "keep-claude-stop");
  assert.equal(nextSettings.hooks.UserPromptSubmit, undefined);
  const claudeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"));
  assert.equal(claudeConfig.custom, true);
  assert.equal(claudeConfig.mcpServers["agent-recall-v2"], undefined);
  assert.equal(claudeConfig.mcpServers["agent-recall"], undefined);
  assert.deepEqual(claudeConfig.mcpServers.keep, { command: "keep" });
  const codexConfig = fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8");
  assert.doesNotMatch(codexConfig, /agent_recall_v2/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.agent_recall/);
  assert.match(codexConfig, /name="keep"/);
  const codexHooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));
  assert.equal(codexHooks.hooks.Stop.length, 1);
  assert.equal(codexHooks.hooks.Stop[0].hooks[0].command, "keep-codex-stop");
  assert.equal(codexHooks.hooks.UserPromptSubmit, undefined);
  assert.equal(fs.existsSync(openCodeWrapper), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall-v2", "update-check.json")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall-v2", "session-sync-queue")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall-v2", "update-preferences.json")), true);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall-v2", "db-path")), true);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall-v2", "update-install.lock")), false);
});

test("uninstall removes the generated macOS app launcher", { skip: process.platform !== "darwin" }, async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "agent-session-uninstall-app-"));
  temporaryDirectories.add(homeDir);
  const appContents = path.join(homeDir, "Applications", "agent-recall-v2.app", "Contents");
  fs.mkdirSync(appContents, { recursive: true });
  fs.writeFileSync(path.join(appContents, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.agent-recall-v2.launcher</string>");

  const result = await uninstall({ homeDir });

  assert.deepEqual(result.errors, []);
  assert.ok(result.messages.includes("Removed the agent-recall-v2.app launcher."));
  assert.equal(fs.existsSync(path.join(homeDir, "Applications", "agent-recall-v2.app")), false);
});
