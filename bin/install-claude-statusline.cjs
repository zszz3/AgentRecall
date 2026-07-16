#!/usr/bin/env node
"use strict";

// Auto-installs the Claude Code usage statusline bridge into ~/.claude/settings.json.
// Runs from package.json "postinstall" so `npm install -g .` wires it up with zero
// manual steps. Self-contained CommonJS: no build output or dependencies required,
// so it works from a freshly unpacked global install.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BRIDGE_SCRIPT_BASENAME = "claude-statusline-snapshot.cjs";
const BRIDGE_BIN_NAME = "agent-recall-claude-statusline";

function bridgeScriptPath() {
  return path.join(__dirname, BRIDGE_SCRIPT_BASENAME);
}

function settingsPathFor(homeDir) {
  return path.join(homeDir, ".claude", "settings.json");
}

function buildBridgeCommand(scriptPath, nodePath) {
  return `${nodePath || "node"} "${scriptPath}"`;
}

function isOurBridgeCommand(command) {
  if (typeof command !== "string") return false;
  return command.includes(BRIDGE_SCRIPT_BASENAME) || command.includes(BRIDGE_BIN_NAME);
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

// Installs the bridge non-destructively. Returns one of:
//   { status: "installed" }  - statusLine written
//   { status: "already" }    - our bridge was already configured
//   { status: "conflict" }   - user already has a different statusLine (left untouched)
//   { status: "error" }      - settings.json unreadable / not writable
function installClaudeStatuslineBridge(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || os.homedir();
  const scriptPath = opts.scriptPath || bridgeScriptPath();
  const settingsPath = opts.settingsPath || settingsPathFor(homeDir);
  const command = buildBridgeCommand(scriptPath, opts.nodePath);

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, "utf8");
    } catch {
      return { status: "error", settingsPath, detail: "Could not read settings.json." };
    }
    if (raw.trim()) {
      try {
        settings = JSON.parse(raw);
      } catch {
        return { status: "error", settingsPath, detail: "settings.json is not valid JSON." };
      }
      if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
        return { status: "error", settingsPath, detail: "settings.json is not a JSON object." };
      }
    }
  }

  const existing = settings.statusLine;
  if (existing !== undefined && existing !== null) {
    const existingCommand = existing && typeof existing === "object" && typeof existing.command === "string" ? existing.command : undefined;
    if (isOurBridgeCommand(existingCommand)) {
      return { status: "already", settingsPath, command: existingCommand };
    }
    return { status: "conflict", settingsPath, existingCommand };
  }

  settings.statusLine = { type: "command", command };
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeJsonAtomic(settingsPath, settings);
  } catch (error) {
    return { status: "error", settingsPath, detail: error instanceof Error ? error.message : String(error) };
  }
  return { status: "installed", settingsPath, command };
}

function uninstallClaudeStatuslineBridge(options) {
  const opts = options || {};
  const homeDir = opts.homeDir || os.homedir();
  const settingsPath = opts.settingsPath || settingsPathFor(homeDir);
  if (!fs.existsSync(settingsPath)) return { status: "absent", settingsPath };
  let settings;
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    settings = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    return { status: "error", settingsPath, detail: error instanceof Error ? error.message : String(error) };
  }
  const command = settings?.statusLine?.command;
  if (!isOurBridgeCommand(command)) return { status: "absent", settingsPath };
  delete settings.statusLine;
  try {
    writeJsonAtomic(settingsPath, settings);
  } catch (error) {
    return { status: "error", settingsPath, detail: error instanceof Error ? error.message : String(error) };
  }
  return { status: "removed", settingsPath };
}

function runCli() {
  // Never fail the install: postinstall must always exit 0.
  if (process.env.AGENT_RECALL_SKIP_STATUSLINE_INSTALL) return;
  if (process.env.CI) return;

  let result;
  try {
    result = installClaudeStatuslineBridge();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`AgentRecall: skipped Claude usage statusline setup (${message}).\n`);
    return;
  }

  switch (result.status) {
    case "installed":
      process.stdout.write(`AgentRecall: enabled Claude Code usage display in ${result.settingsPath}.\n`);
      break;
    case "already":
      // Quiet on repeat installs.
      break;
    case "conflict":
      process.stdout.write(
        "AgentRecall: kept your existing Claude statusLine. To show Claude Code usage, " +
          "point ~/.claude/settings.json statusLine.command at `agent-recall-claude-statusline` (see README).\n",
      );
      break;
    default:
      process.stdout.write(`AgentRecall: could not set up Claude usage display (${result.detail || "unknown error"}).\n`);
      break;
  }
}

module.exports = {
  installClaudeStatuslineBridge,
  uninstallClaudeStatuslineBridge,
  buildBridgeCommand,
  isOurBridgeCommand,
  settingsPathFor,
  bridgeScriptPath,
};

if (require.main === module) {
  runCli();
}
