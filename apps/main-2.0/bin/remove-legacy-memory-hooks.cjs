#!/usr/bin/env node
"use strict";

// Removes the Claude Code, Codex and OpenCode entries that the retired
// directory Memory feature wrote. Only entries whose command or wrapper content
// identifies that feature are removed; unrelated hooks, plugins and settings are
// kept verbatim, and missing files stay missing.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOOK_SCRIPT_BASENAME = "openviking-memory-hook.cjs";
const HOOK_BIN_NAME = "agent-recall-openviking-memory-hook";
const OPENCODE_WRAPPER_NAME = "agent-recall-openviking.js";
const OPENCODE_WRAPPER_MARKER = "createAgentRecallOpenVikingPlugin";

/**
 * @param {{ homeDir?: string }} [options]
 * @returns {{ status: "removed" | "unchanged" } | { status: "error", detail: string }}
 */
function removeLegacyMemoryHooks(options = {}) {
  const homeDir = options.homeDir || process.env.AGENT_RECALL_TEST_HOME || os.homedir();
  const settingsFiles = [
    path.join(homeDir, ".claude", "settings.json"),
    path.join(homeDir, ".codex", "hooks.json"),
  ];
  const settings = [];
  for (const filePath of settingsFiles) {
    const result = readSettings(filePath);
    if (result.error) return { status: "error", detail: result.error };
    if (result.value) settings.push({ filePath, value: result.value });
  }

  let removed = false;
  try {
    for (const { filePath, value } of settings) {
      if (!removeHookEntries(value)) continue;
      writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
      removed = true;
    }
    const wrapperPath = path.join(homeDir, ".config", "opencode", "plugins", OPENCODE_WRAPPER_NAME);
    if (readTextIfPresent(wrapperPath)?.includes(OPENCODE_WRAPPER_MARKER)) {
      fs.rmSync(wrapperPath, { force: true });
      removed = true;
    }
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
  return { status: removed ? "removed" : "unchanged" };
}

function isLegacyHookCommand(command) {
  return typeof command === "string" && (command.includes(HOOK_SCRIPT_BASENAME) || command.includes(HOOK_BIN_NAME));
}

function removeHookEntries(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return false;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const kept = [];
    for (const entry of settings.hooks[event]) {
      const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
      const remaining = hooks.filter((hook) => !(hook && isLegacyHookCommand(hook.command)));
      if (remaining.length === hooks.length) {
        kept.push(entry);
        continue;
      }
      changed = true;
      if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
    }
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // A missing file means there is nothing of ours to remove.
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function readSettings(filePath) {
  let raw;
  try {
    raw = readTextIfPresent(filePath);
  } catch (error) {
    return { error: `${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (raw === null || !raw.trim()) return { value: null };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${filePath} is not a JSON object.` };
    return { value };
  } catch (error) {
    return { error: `${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function writeFileAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

module.exports = { removeLegacyMemoryHooks };

if (require.main === module) {
  const result = removeLegacyMemoryHooks();
  if (result.status === "error") {
    process.stderr.write(`Could not remove the retired memory hooks: ${result.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(result.status === "removed" ? "Removed the retired memory hooks.\n" : "No retired memory hooks were found.\n");
  }
}
