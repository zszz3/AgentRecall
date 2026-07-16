#!/usr/bin/env node
"use strict";

// Installs/removes user-level Claude Code and Codex Stop hooks without
// replacing unrelated settings. The target script only queues an event; the
// desktop app owns indexing, revision comparison and Supabase upload.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RECORD_SCRIPT_BASENAME = "session-sync-record.cjs";
const RECORD_BIN_NAME = "agent-recall-session-sync";

function defaultHomeDir() {
  return process.env.AGENT_RECALL_TEST_HOME || os.homedir();
}

function recordScriptPath() {
  return path.join(__dirname, RECORD_SCRIPT_BASENAME);
}

function settingsPathsFor(homeDir) {
  return {
    claude: path.join(homeDir, ".claude", "settings.json"),
    codex: path.join(homeDir, ".codex", "hooks.json"),
  };
}

function buildHookCommand(scriptPath, agent, nodePath) {
  const node = nodePath ? `"${nodePath}"` : "node";
  return `${node} "${scriptPath}" --agent ${agent}`;
}

function isOurHookCommand(command) {
  return typeof command === "string" && (command.includes(RECORD_SCRIPT_BASENAME) || command.includes(RECORD_BIN_NAME));
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return { value: {} };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return { value: {} };
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: `${filePath} is not a JSON object.` };
    return { value };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function stopEntries(settings) {
  return settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks) && Array.isArray(settings.hooks.Stop)
    ? settings.hooks.Stop
    : [];
}

function hasOurHook(settings) {
  return stopEntries(settings).some((entry) => {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.some((hook) => hook && isOurHookCommand(hook.command));
  });
}

function addHook(settings, hook) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = [];
  settings.hooks.Stop.push({ hooks: [hook] });
}

function removeHook(settings) {
  const kept = [];
  for (const entry of stopEntries(settings)) {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    const remaining = hooks.filter((hook) => !(hook && isOurHookCommand(hook.command)));
    if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
  }
  if (kept.length > 0) settings.hooks.Stop = kept;
  else if (settings.hooks) {
    delete settings.hooks.Stop;
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
}

function loadBoth(homeDir) {
  const paths = settingsPathsFor(homeDir);
  const claude = readJson(paths.claude);
  const codex = readJson(paths.codex);
  return { paths, claude, codex };
}

function sessionSyncHookStatus(options) {
  const homeDir = options?.homeDir || defaultHomeDir();
  const loaded = loadBoth(homeDir);
  const claude = Boolean(loaded.claude.value && hasOurHook(loaded.claude.value));
  const codex = Boolean(loaded.codex.value && hasOurHook(loaded.codex.value));
  return {
    installed: claude && codex,
    claude,
    codex,
    error: loaded.claude.error || loaded.codex.error,
    paths: loaded.paths,
  };
}

function installSessionSyncHooks(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || defaultHomeDir();
  const scriptPath = opts.scriptPath || recordScriptPath();
  const loaded = loadBoth(homeDir);
  if (loaded.claude.error || loaded.codex.error) {
    return { status: "error", detail: loaded.claude.error || loaded.codex.error, paths: loaded.paths };
  }
  const claudeInstalled = hasOurHook(loaded.claude.value);
  const codexInstalled = hasOurHook(loaded.codex.value);
  if (claudeInstalled && codexInstalled) return { status: "already", paths: loaded.paths };

  if (!claudeInstalled) {
    addHook(loaded.claude.value, {
      type: "command",
      command: buildHookCommand(scriptPath, "claude", opts.nodePath),
      async: true,
    });
  }
  if (!codexInstalled) {
    addHook(loaded.codex.value, {
      type: "command",
      command: buildHookCommand(scriptPath, "codex", opts.nodePath),
      timeout: 10,
      statusMessage: "Queueing session sync",
    });
  }

  try {
    writeJsonAtomic(loaded.paths.claude, loaded.claude.value);
    writeJsonAtomic(loaded.paths.codex, loaded.codex.value);
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error), paths: loaded.paths };
  }
  return { status: "installed", paths: loaded.paths };
}

function uninstallSessionSyncHooks(options) {
  const homeDir = options?.homeDir || defaultHomeDir();
  const loaded = loadBoth(homeDir);
  if (loaded.claude.error || loaded.codex.error) {
    return { status: "error", detail: loaded.claude.error || loaded.codex.error, paths: loaded.paths };
  }
  const claudeInstalled = hasOurHook(loaded.claude.value);
  const codexInstalled = hasOurHook(loaded.codex.value);
  if (!claudeInstalled && !codexInstalled) return { status: "absent", paths: loaded.paths };
  if (claudeInstalled) removeHook(loaded.claude.value);
  if (codexInstalled) removeHook(loaded.codex.value);
  try {
    if (claudeInstalled) writeJsonAtomic(loaded.paths.claude, loaded.claude.value);
    if (codexInstalled) writeJsonAtomic(loaded.paths.codex, loaded.codex.value);
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error), paths: loaded.paths };
  }
  return { status: "removed", paths: loaded.paths };
}

function runCli() {
  const mode = process.argv.includes("--uninstall") ? "uninstall" : process.argv.includes("--status") ? "status" : "install";
  if (mode === "status") {
    const result = sessionSyncHookStatus();
    process.stdout.write(`Session sync hooks: Claude ${result.claude ? "installed" : "not installed"}, Codex ${result.codex ? "installed" : "not installed"}.\n`);
    return;
  }
  const result = mode === "uninstall" ? uninstallSessionSyncHooks() : installSessionSyncHooks();
  if (result.status === "error") {
    process.stderr.write(`Could not ${mode === "uninstall" ? "remove" : "configure"} session sync hooks: ${result.detail || "unknown error"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(mode === "uninstall" ? "Session sync hooks removed.\n" : "Session sync hooks configured. Review the Codex hook with /hooks before first use.\n");
}

module.exports = {
  installSessionSyncHooks,
  uninstallSessionSyncHooks,
  sessionSyncHookStatus,
  buildHookCommand,
  isOurHookCommand,
  settingsPathsFor,
  recordScriptPath,
};

if (require.main === module) runCli();
