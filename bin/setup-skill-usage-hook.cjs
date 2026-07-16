#!/usr/bin/env node
"use strict";

// Installs (or removes) the Claude Code PostToolUse hook that records skill
// usage into ~/.claude/skill-usage.jsonl. Merges non-destructively into
// ~/.claude/settings.json so existing hooks and settings are preserved, and is
// idempotent: re-running never adds a duplicate entry.
//
// Self-contained CommonJS (no build output or dependencies) so it runs straight
// from a freshly unpacked global install. Exposes functions for the Electron
// main process and a small CLI (`--uninstall`, `--status`).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RECORD_SCRIPT_BASENAME = "skill-usage-record.cjs";
const RECORD_BIN_NAME = "agent-recall-skill-usage";
const SKILL_MATCHER = "Skill";

function defaultHomeDir() {
  return process.env.AGENT_RECALL_TEST_HOME || os.homedir();
}

function recordScriptPath() {
  return path.join(__dirname, RECORD_SCRIPT_BASENAME);
}

function settingsPathFor(homeDir) {
  return path.join(homeDir, ".claude", "settings.json");
}

function buildHookCommand(scriptPath, nodePath) {
  return `${nodePath || "node"} "${scriptPath}"`;
}

function isOurHookCommand(command) {
  if (typeof command !== "string") return false;
  return command.includes(RECORD_SCRIPT_BASENAME) || command.includes(RECORD_BIN_NAME);
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return { settings: {} };
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, "utf8");
  } catch {
    return { error: "Could not read settings.json." };
  }
  if (!raw.trim()) return { settings: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "settings.json is not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "settings.json is not a JSON object." };
  }
  return { settings: parsed };
}

function postToolUseEntries(settings) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const entries = hooks.PostToolUse;
  return Array.isArray(entries) ? entries : [];
}

function hasOurHook(settings) {
  for (const entry of postToolUseEntries(settings)) {
    const hookList = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    if (hookList.some((hook) => hook && isOurHookCommand(hook.command))) return true;
  }
  return false;
}

// Returns { installed: boolean, settingsPath, error? }.
function skillUsageHookStatus(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || defaultHomeDir();
  const settingsPath = opts.settingsPath || settingsPathFor(homeDir);
  const { settings, error } = readSettings(settingsPath);
  if (error) return { installed: false, settingsPath, error };
  return { installed: hasOurHook(settings), settingsPath };
}

// Installs the hook. Returns one of:
//   { status: "installed" } - hook added
//   { status: "already" }   - our hook was already present
//   { status: "error" }     - settings.json unreadable / not writable
function installSkillUsageHook(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || defaultHomeDir();
  const scriptPath = opts.scriptPath || recordScriptPath();
  const settingsPath = opts.settingsPath || settingsPathFor(homeDir);
  const command = buildHookCommand(scriptPath, opts.nodePath);

  const { settings, error } = readSettings(settingsPath);
  if (error) return { status: "error", settingsPath, detail: error };

  if (hasOurHook(settings)) return { status: "already", settingsPath, command };

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
  settings.hooks.PostToolUse.push({
    matcher: SKILL_MATCHER,
    hooks: [{ type: "command", command, async: true }],
  });

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
  } catch (writeError) {
    return { status: "error", settingsPath, detail: writeError instanceof Error ? writeError.message : String(writeError) };
  }
  return { status: "installed", settingsPath, command };
}

// Removes our hook entries. Returns one of:
//   { status: "removed" } - hook removed
//   { status: "absent" }  - our hook was not present
//   { status: "error" }   - settings.json unreadable / not writable
function uninstallSkillUsageHook(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || defaultHomeDir();
  const settingsPath = opts.settingsPath || settingsPathFor(homeDir);

  const { settings, error } = readSettings(settingsPath);
  if (error) return { status: "error", settingsPath, detail: error };
  if (!hasOurHook(settings)) return { status: "absent", settingsPath };

  const entries = postToolUseEntries(settings);
  const kept = [];
  for (const entry of entries) {
    const hookList = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    const remaining = hookList.filter((hook) => !(hook && isOurHookCommand(hook.command)));
    if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
  }

  if (kept.length > 0) {
    settings.hooks.PostToolUse = kept;
  } else {
    delete settings.hooks.PostToolUse;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  try {
    writeJsonAtomic(settingsPath, settings);
  } catch (writeError) {
    return { status: "error", settingsPath, detail: writeError instanceof Error ? writeError.message : String(writeError) };
  }
  return { status: "removed", settingsPath };
}

function runCli() {
  const mode = process.argv.includes("--uninstall") ? "uninstall" : process.argv.includes("--status") ? "status" : "install";

  if (mode === "status") {
    const result = skillUsageHookStatus();
    process.stdout.write(`Skill usage hook ${result.installed ? "installed" : "not installed"} (${result.settingsPath}).\n`);
    return;
  }

  if (mode === "uninstall") {
    const result = uninstallSkillUsageHook();
    if (result.status === "error") {
      process.stderr.write(`Could not remove skill usage hook: ${result.detail || "unknown error"}\n`);
      process.exit(1);
    }
    process.stdout.write(result.status === "removed" ? `Skill usage hook removed from ${result.settingsPath}.\n` : "Skill usage hook was not installed.\n");
    return;
  }

  const result = installSkillUsageHook();
  switch (result.status) {
    case "installed":
      process.stdout.write(`Skill usage hook configured in ${result.settingsPath}.\nRestart Claude Code so the hook takes effect.\n`);
      break;
    case "already":
      process.stdout.write("Skill usage hook already configured.\n");
      break;
    default:
      process.stderr.write(`Could not configure skill usage hook: ${result.detail || "unknown error"}\n`);
      process.exit(1);
  }
}

module.exports = {
  installSkillUsageHook,
  uninstallSkillUsageHook,
  skillUsageHookStatus,
  buildHookCommand,
  isOurHookCommand,
  hasOurHook,
  settingsPathFor,
  recordScriptPath,
};

if (require.main === module) {
  runCli();
}
