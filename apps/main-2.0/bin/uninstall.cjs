#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { uninstallClaudeStatuslineBridge } = require("./install-claude-statusline.cjs");
const { uninstallMacosApp } = require("./install-macos-app.cjs");
const { uninstallSkillUsageHook } = require("./setup-skill-usage-hook.cjs");
const { uninstallSessionSyncHooks } = require("./setup-session-sync-hook.cjs");
const { removeLegacyMemoryHooks } = require("./remove-legacy-memory-hooks.cjs");
const { removeLibraryBlocks } = require("./remove-library-blocks.cjs");
const { acquireUpdateLock, stopRunningApp, waitForUpdateCompletion } = require("./update-client.cjs");
const mcp = require("./setup-mcp.cjs");
const { acquireSessionBackendMaintenance } = require("./session-backend-client.cjs");

async function uninstall(options = {}) {
  const homeDir = options.homeDir || process.env.AGENT_RECALL_TEST_HOME || os.homedir();
  const messages = [];
  const errors = [];
  await waitForUpdateCompletion({ homeDir });
  const lock = await acquireUpdateLock({ homeDir });
  let releaseBackend;
  try {
    await stopRunningApp({ homeDir }).catch((error) => {
      errors.push(`Running app: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Do not remove integrations underneath a live desktop or search request.
    releaseBackend = await acquireSessionBackendMaintenance({ homeDir });

    const statusLine = uninstallClaudeStatuslineBridge({ homeDir });
    if (statusLine.status === "error") errors.push(`Claude statusLine: ${statusLine.detail}`);
    else messages.push(statusLine.status === "removed" ? "Removed the AgentRecall Claude statusLine." : "Claude statusLine did not need changes.");

    const usageHook = uninstallSkillUsageHook({ homeDir });
    if (usageHook.status === "error") errors.push(`Skill usage hook: ${usageHook.detail}`);
    else messages.push(usageHook.status === "removed" ? "Removed the AgentRecall skill usage hook." : "Skill usage hook did not need changes.");

    const sessionHooks = uninstallSessionSyncHooks({ homeDir });
    if (sessionHooks.status === "error") errors.push(`Session sync hooks: ${sessionHooks.detail}`);
    else messages.push(sessionHooks.status === "removed" ? "Removed the AgentRecall session sync hooks." : "Session sync hooks did not need changes.");

    const legacyMemoryHooks = removeLegacyMemoryHooks({ homeDir });
    if (legacyMemoryHooks.status === "error") errors.push(`Retired memory hooks: ${legacyMemoryHooks.detail}`);
    else messages.push(legacyMemoryHooks.status === "removed" ? "Removed the retired AgentRecall memory hooks." : "Retired memory hooks did not need changes.");

    const library = removeLibraryBlocks({ homeDir });
    if (library.status === "error") errors.push(`Library: ${library.detail}`);
    else {
      messages.push(library.status === "removed" ? "Removed the instructions and MCP servers the Library wrote into agent files." : "Library agent files did not need changes.");
      if (library.detail) messages.push(library.detail);
    }

    try {
      messages.push(...mcp.run(true, { homeDir }));
    } catch (error) {
      errors.push(`MCP references: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (process.platform === "darwin") {
      const macosApp = uninstallMacosApp({ homeDir, packagePath: path.resolve(__dirname, "..") });
      if (macosApp.status === "error") errors.push(`macOS app launcher: ${macosApp.detail}`);
      else if (macosApp.status === "kept") messages.push("Kept the agent-recall-v2.app launcher; it points at another AgentRecall install.");
      else messages.push(macosApp.status === "removed" ? "Removed the agent-recall-v2.app launcher." : "macOS app launcher did not need changes.");
    }

    const cacheFiles = [
      path.join(homeDir, ".agent-recall-v2", "update-check.json"),
      path.join(homeDir, ".agent-recall-v2", "update-install-status.json"),
      path.join(homeDir, ".agent-recall-v2", "app-process.json"),
      path.join(homeDir, ".claude", "skill-usage.jsonl"),
    ];
    for (const filePath of cacheFiles) {
      try { fs.rmSync(filePath, { force: true }); } catch (error) { errors.push(`Cache ${filePath}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      fs.rmSync(path.join(homeDir, ".agent-recall-v2", "session-sync-queue"), { recursive: true, force: true });
    } catch (error) {
      errors.push(`Session sync queue: ${error instanceof Error ? error.message : String(error)}`);
    }
    messages.push("Removed agent-recall-v2 integration caches.");
    messages.push("Session database, Supabase settings, update preference, and other user preferences were kept.");
    return { messages, errors };
  } finally {
    try { await releaseBackend?.(); }
    finally { await lock.release().catch(() => undefined); }
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
