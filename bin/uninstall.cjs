#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { uninstallClaudeStatuslineBridge } = require("./install-claude-statusline.cjs");
const { uninstallSkillUsageHook } = require("./setup-skill-usage-hook.cjs");
const { uninstallSessionSyncHooks } = require("./setup-session-sync-hook.cjs");
const { acquireUpdateLock, stopRunningApp, waitForUpdateCompletion } = require("./update-client.cjs");
const mcp = require("./setup-mcp.cjs");

async function uninstall(options = {}) {
  const homeDir = options.homeDir || process.env.AGENT_RECALL_TEST_HOME || os.homedir();
  const messages = [];
  const errors = [];
  await waitForUpdateCompletion({ homeDir });
  const lock = await acquireUpdateLock({ homeDir });
  try {
    await stopRunningApp({ homeDir }).catch((error) => {
      errors.push(`Running app: ${error instanceof Error ? error.message : String(error)}`);
    });

    const statusLine = uninstallClaudeStatuslineBridge({ homeDir });
    if (statusLine.status === "error") errors.push(`Claude statusLine: ${statusLine.detail}`);
    else messages.push(statusLine.status === "removed" ? "Removed the AgentRecall Claude statusLine." : "Claude statusLine did not need changes.");

    const usageHook = uninstallSkillUsageHook({ homeDir });
    if (usageHook.status === "error") errors.push(`Skill usage hook: ${usageHook.detail}`);
    else messages.push(usageHook.status === "removed" ? "Removed the AgentRecall skill usage hook." : "Skill usage hook did not need changes.");

    const sessionHooks = uninstallSessionSyncHooks({ homeDir });
    if (sessionHooks.status === "error") errors.push(`Session sync hooks: ${sessionHooks.detail}`);
    else messages.push(sessionHooks.status === "removed" ? "Removed the AgentRecall session sync hooks." : "Session sync hooks did not need changes.");

    try {
      messages.push(...mcp.run(true, { homeDir }));
    } catch (error) {
      errors.push(`MCP references: ${error instanceof Error ? error.message : String(error)}`);
    }

    const cacheFiles = [
      path.join(homeDir, ".agent-recall", "update-check.json"),
      path.join(homeDir, ".agent-recall", "update-install-status.json"),
      path.join(homeDir, ".agent-recall", "app-process.json"),
      path.join(homeDir, ".claude", "skill-usage.jsonl"),
    ];
    for (const filePath of cacheFiles) {
      try { fs.rmSync(filePath, { force: true }); } catch (error) { errors.push(`Cache ${filePath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      fs.rmSync(path.join(homeDir, ".agent-recall", "session-sync-queue"), { recursive: true, force: true });
    } catch (error) {
      errors.push(`Session sync queue: ${error instanceof Error ? error.message : String(error)}`);
    }
    messages.push("Removed AgentRecall integration caches.");
    messages.push("Session database, Supabase settings, update preference, and other user preferences were kept.");
    return { messages, errors };
  } finally {
    await lock.release().catch(() => undefined);
  }
}

if (require.main === module) {
  uninstall().then((result) => {
    for (const message of result.messages) process.stdout.write(`${message}\n`);
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    if (result.errors.length > 0) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { uninstall };
