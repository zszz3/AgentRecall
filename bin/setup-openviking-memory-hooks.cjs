#!/usr/bin/env node
"use strict";

// Non-destructively reconciles the opt-in OpenViking hooks. Unrelated hook
// entries and settings are retained verbatim.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOOK_SCRIPT_BASENAME = "openviking-memory-hook.cjs";
const HOOK_BIN_NAME = "agent-recall-openviking-memory-hook";
const OPENCODE_WRAPPER_NAME = "agent-recall-openviking.js";

function settingsPathsFor(homeDir) {
  return {
    claude: path.join(homeDir, ".claude", "settings.json"),
    codex: path.join(homeDir, ".codex", "hooks.json"),
    opencode: path.join(homeDir, ".config", "opencode", "plugins", OPENCODE_WRAPPER_NAME),
  };
}

function buildHookCommand(options, agent, event) {
  const nodePath = options.nodePath || "node";
  return `${quote(nodePath)} ${quote(options.hookScriptPath)} --agent ${agent} --event ${event} --manifest ${quote(options.manifestPath)}`;
}

function isOurHookCommand(command) {
  return typeof command === "string" && (command.includes(HOOK_SCRIPT_BASENAME) || command.includes(HOOK_BIN_NAME));
}

function reconcileOpenVikingMemoryHooks(options) {
  const opts = normalizeOptions(options);
  const paths = settingsPathsFor(opts.homeDir);
  const claude = readJson(paths.claude);
  const codex = readJson(paths.codex);
  if (claude.error || codex.error) return { status: "error", detail: claude.error || codex.error };

  try {
    const claudeChanged = removeOurHooks(claude.value);
    const codexChanged = removeOurHooks(codex.value);
    if (opts.integrations.claude) addClaudeHooks(claude.value, opts);
    if (opts.integrations.codex) addCodexHooks(codex.value, opts);
    if (claudeChanged || opts.integrations.claude || fs.existsSync(paths.claude)) writeJsonAtomic(paths.claude, claude.value);
    if (codexChanged || opts.integrations.codex || fs.existsSync(paths.codex)) writeJsonAtomic(paths.codex, codex.value);
    reconcileOpenCodeWrapper(paths.opencode, opts);
    return { status: "configured" };
  } catch (error) {
    return { status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

function openVikingMemoryHookStatus(options) {
  const opts = normalizeOptions(options);
  const paths = settingsPathsFor(opts.homeDir);
  const claude = readJson(paths.claude);
  const codex = readJson(paths.codex);
  return {
    claude: Boolean(claude.value && hasOurHook(claude.value)),
    codex: Boolean(codex.value && hasOurHook(codex.value)),
    opencode: hasOurOpenCodeWrapper(paths.opencode),
    error: claude.error || codex.error || null,
  };
}

function addClaudeHooks(settings, options) {
  addHook(settings, "UserPromptSubmit", buildHookCommand(options, "claude", "UserPromptSubmit"), { matcher: "", timeout: 8 });
  addHook(settings, "Stop", buildHookCommand(options, "claude", "Stop"), { matcher: "", timeout: 15, async: true });
  addHook(settings, "PreCompact", buildHookCommand(options, "claude", "PreCompact"), { matcher: "", timeout: 10 });
  addHook(settings, "SessionEnd", buildHookCommand(options, "claude", "SessionEnd"), { matcher: "", timeout: 10, async: true });
}

function addCodexHooks(settings, options) {
  addHook(settings, "UserPromptSubmit", buildHookCommand(options, "codex", "UserPromptSubmit"), { matcher: "*", timeout: 8 });
  addHook(settings, "Stop", buildHookCommand(options, "codex", "Stop"), { matcher: "*", timeout: 15 });
  addHook(settings, "PreCompact", buildHookCommand(options, "codex", "PreCompact"), { matcher: "*", timeout: 10 });
}

function addHook(settings, event, command, entryOptions) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const hook = { type: "command", command, timeout: entryOptions.timeout };
  if (entryOptions.async) hook.async = true;
  settings.hooks[event].push({ matcher: entryOptions.matcher, hooks: [hook] });
}

function removeOurHooks(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return false;
  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const kept = [];
    for (const entry of settings.hooks[event]) {
      const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
      const remaining = hooks.filter((hook) => !(hook && isOurHookCommand(hook.command)));
      if (remaining.length !== hooks.length) changed = true;
      if (remaining.length > 0) kept.push({ ...entry, hooks: remaining });
    }
    if (kept.length > 0) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return changed;
}

function hasOurHook(settings) {
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return false;
  return Object.values(settings.hooks).some((entries) => Array.isArray(entries) && entries.some((entry) => {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return hooks.some((hook) => hook && isOurHookCommand(hook.command));
  }));
}

function reconcileOpenCodeWrapper(wrapperPath, options) {
  if (!options.integrations.opencode) {
    if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
    return;
  }
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  const pluginUrl = pathToFileURL(path.resolve(options.openCodePluginPath)).href;
  const content = [
    `import { createAgentRecallOpenVikingPlugin } from ${JSON.stringify(pluginUrl)};`,
    `export const AgentRecallOpenVikingPlugin = createAgentRecallOpenVikingPlugin(${JSON.stringify(options.manifestPath)});`,
    "",
  ].join("\n");
  writeFileAtomic(wrapperPath, content);
}

function hasOurOpenCodeWrapper(wrapperPath) {
  try {
    return fs.readFileSync(wrapperPath, "utf8").includes("createAgentRecallOpenVikingPlugin");
  } catch {
    return false;
  }
}

function normalizeOptions(options) {
  const opts = options || {};
  return {
    homeDir: opts.homeDir || process.env.AGENT_RECALL_TEST_HOME || os.homedir(),
    hookScriptPath: opts.hookScriptPath || path.join(__dirname, HOOK_SCRIPT_BASENAME),
    openCodePluginPath: opts.openCodePluginPath || path.join(__dirname, "openviking-opencode-plugin.mjs"),
    manifestPath: opts.manifestPath || path.join(os.homedir(), ".agent-recall", "openviking", "hook-manifest.json"),
    nodePath: opts.nodePath || "node",
    integrations: {
      claude: opts.integrations?.claude === true,
      codex: opts.integrations?.codex === true,
      opencode: opts.integrations?.opencode === true,
    },
  };
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
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function runCli() {
  const enabled = !process.argv.includes("--uninstall");
  const result = reconcileOpenVikingMemoryHooks({
    integrations: { claude: enabled, codex: enabled, opencode: enabled },
  });
  if (result.status === "error") {
    process.stderr.write(`Could not configure OpenViking memory hooks: ${result.detail || "unknown error"}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(enabled ? "OpenViking memory hooks configured.\n" : "OpenViking memory hooks removed.\n");
}

module.exports = {
  buildHookCommand,
  isOurHookCommand,
  openVikingMemoryHookStatus,
  reconcileOpenVikingMemoryHooks,
  settingsPathsFor,
};

if (require.main === module) runCli();
