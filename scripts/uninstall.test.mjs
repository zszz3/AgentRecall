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

test("uninstall removes only AgentRecall integrations and caches", async () => {
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
        { hooks: [{ type: "command", command: "keep-claude-stop" }] },
      ],
    },
  }));
  fs.writeFileSync(path.join(homeDir, ".claude.json"), JSON.stringify({ custom: true, mcpServers: { "agent-recall": { command: "node", args: ["old"] }, keep: { command: "keep" } } }));
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), '[model]\nname="keep"\n\n[mcp_servers.agent_recall]\ncommand="node"\nargs=["old"]\n');
  fs.writeFileSync(path.join(homeDir, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [
    { hooks: [{ type: "command", command: 'node "/global/bin/session-sync-record.cjs" --agent codex' }] },
    { hooks: [{ type: "command", command: "keep-codex-stop" }] },
  ] } }));
  fs.mkdirSync(path.join(homeDir, ".agent-recall"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".agent-recall", "update-check.json"), "{}");
  fs.writeFileSync(path.join(homeDir, ".agent-recall", "update-preferences.json"), '{"enabled":false}');
  fs.writeFileSync(path.join(homeDir, ".agent-recall", "db-path"), "/kept/database.sqlite");
  fs.mkdirSync(path.join(homeDir, ".agent-recall", "session-sync-queue"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, ".agent-recall", "session-sync-queue", "pending.json"), "{}");

  const result = await uninstall({ homeDir });

  assert.deepEqual(result.errors, []);
  const nextSettings = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(nextSettings.theme, "dark");
  assert.equal(nextSettings.statusLine, undefined);
  assert.equal(nextSettings.hooks.PostToolUse.length, 1);
  assert.equal(nextSettings.hooks.Stop.length, 1);
  assert.equal(nextSettings.hooks.Stop[0].hooks[0].command, "keep-claude-stop");
  const claudeConfig = JSON.parse(fs.readFileSync(path.join(homeDir, ".claude.json"), "utf8"));
  assert.equal(claudeConfig.custom, true);
  assert.equal(claudeConfig.mcpServers["agent-recall"], undefined);
  assert.deepEqual(claudeConfig.mcpServers.keep, { command: "keep" });
  assert.doesNotMatch(fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8"), /agent_recall/);
  assert.match(fs.readFileSync(path.join(homeDir, ".codex", "config.toml"), "utf8"), /name="keep"/);
  const codexHooks = JSON.parse(fs.readFileSync(path.join(homeDir, ".codex", "hooks.json"), "utf8"));
  assert.equal(codexHooks.hooks.Stop.length, 1);
  assert.equal(codexHooks.hooks.Stop[0].hooks[0].command, "keep-codex-stop");
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall", "update-check.json")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall", "session-sync-queue")), false);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall", "update-preferences.json")), true);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall", "db-path")), true);
  assert.equal(fs.existsSync(path.join(homeDir, ".agent-recall", "update-install.lock")), false);
});
