#!/usr/bin/env node
"use strict";

// Registers (or removes) the agent-recall MCP server in Claude Code and
// Codex configs so they can search past sessions. Run with `uninstall` to remove.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "agent-recall";
const CODEX_SECTION = "mcp_servers.agent_recall";

function homeDir() {
  return process.env.AGENT_RECALL_TEST_HOME || os.homedir();
}

function serverScriptPath() {
  return path.join(__dirname, "agent-recall-mcp.mjs");
}

function nodeMajor(version) {
  return parseInt(String(version).replace(/^v/, "").split(".")[0], 10) || 0;
}

// The MCP server needs node >= 22 (node:sqlite). Crucially, node 22's bundled
// SQLite includes the fts5 module that the SessionStore depends on, while some
// node 23 builds ship SQLite without fts5 — so we prefer node 22 specifically
// and only fall back to other >=22 versions when 22 is unavailable.
function nodeCommand() {
  const candidates = [];

  // The node running this script (e.g. the one start.sh resolved via nvm).
  const base = path.basename(process.execPath).toLowerCase();
  if (base === "node" || base === "node.exe") {
    candidates.push(process.execPath);
  }

  // nvm installs, highest version first.
  const nvmRoot = path.join(homeDir(), ".nvm", "versions", "node");
  try {
    for (const dir of fs.readdirSync(nvmRoot)) {
      candidates.push(path.join(nvmRoot, dir, "bin", "node"));
    }
  } catch {
    // No nvm; ignore.
  }

  // Common install locations.
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "node");

  // First pass: prefer node 22.x (fts5 is reliably available there).
  for (const candidate of candidates) {
    try {
      let version;
      if (candidate === "node") {
        version = require("node:child_process").execSync("node -v", { encoding: "utf8" }).trim();
      } else {
        if (!fs.existsSync(candidate)) continue;
        version = require("node:child_process").execSync(`${JSON.stringify(candidate)} -v`, { encoding: "utf8" }).trim();
      }
      if (nodeMajor(version) === 22) return candidate;
    } catch {
      // Not runnable; try the next candidate.
    }
  }

  // Second pass: any node >= 22 (last resort — may lack fts5 on node 23+).
  for (const candidate of candidates) {
    try {
      let version;
      if (candidate === "node") {
        version = require("node:child_process").execSync("node -v", { encoding: "utf8" }).trim();
      } else {
        if (!fs.existsSync(candidate)) continue;
        version = require("node:child_process").execSync(`${JSON.stringify(candidate)} -v`, { encoding: "utf8" }).trim();
      }
      if (nodeMajor(version) >= 22) return candidate;
    } catch {
      // Not runnable; try the next candidate.
    }
  }
  return "node";
}

// --- Claude (~/.claude.json, JSON) -----------------------------------------

function applyClaudeConfig(config, scriptPath, remove, command = "node") {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const servers = next.mcpServers && typeof next.mcpServers === "object" ? { ...next.mcpServers } : {};
  if (remove) {
    delete servers[SERVER_NAME];
  } else {
    servers[SERVER_NAME] = { command, args: [scriptPath] };
  }
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}

// --- Codex (~/.codex/config.toml, TOML) ------------------------------------

function applyCodexConfig(toml, scriptPath, remove, command = "node") {
  // JSON.stringify both values: TOML basic-string escapes (\\, \") match JSON, so
  // Windows paths with backslashes stay valid.
  const block = `[${CODEX_SECTION}]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(scriptPath)}]\n`;
  const stripped = removeCodexBlock(toml);
  if (remove) return stripped;
  const base = stripped.trim();
  return base ? `${base}\n\n${block}` : block;
}

function removeCodexBlock(toml) {
  const lines = (toml || "").split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === `[${CODEX_SECTION}]`) {
      skipping = true;
      continue;
    }
    if (skipping) {
      // Stop skipping at the next table header.
      if (/^\s*\[/.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, filePath);
}

function run(remove, options = {}) {
  const home = options.homeDir || homeDir();
  const scriptPath = serverScriptPath();
  const command = remove ? "node" : nodeCommand();
  const messages = [];

  const claudePath = path.join(home, ".claude.json");
  if (!remove || fs.existsSync(claudePath)) {
    const claudeConfig = applyClaudeConfig(readJson(claudePath), scriptPath, remove, command);
    writeFileAtomic(claudePath, `${JSON.stringify(claudeConfig, null, 2)}\n`);
    messages.push(`${remove ? "Removed" : "Configured"} MCP server in ${claudePath}`);
  }

  const codexDir = path.join(home, ".codex");
  if (fs.existsSync(codexDir) && (!remove || fs.existsSync(path.join(codexDir, "config.toml")))) {
    const codexPath = path.join(codexDir, "config.toml");
    const current = fs.existsSync(codexPath) ? fs.readFileSync(codexPath, "utf8") : "";
    const nextToml = applyCodexConfig(current, scriptPath, remove, command);
    writeFileAtomic(codexPath, nextToml.endsWith("\n") ? nextToml : `${nextToml}\n`);
    messages.push(`${remove ? "Removed" : "Configured"} MCP server in ${codexPath}`);
  } else {
    messages.push("Skipped Codex (~/.codex not found).");
  }

  // CodeBuddy uses ~/.codebuddy/mcp.json with the same { mcpServers } shape as Claude.
  const codeBuddyDir = path.join(home, ".codebuddy");
  if (fs.existsSync(codeBuddyDir) && (!remove || fs.existsSync(path.join(codeBuddyDir, "mcp.json")))) {
    const codeBuddyPath = path.join(codeBuddyDir, "mcp.json");
    const codeBuddyConfig = applyClaudeConfig(readJson(codeBuddyPath), scriptPath, remove, command);
    writeFileAtomic(codeBuddyPath, `${JSON.stringify(codeBuddyConfig, null, 2)}\n`);
    messages.push(`${remove ? "Removed" : "Configured"} MCP server in ${codeBuddyPath}`);
  } else {
    messages.push("Skipped CodeBuddy (~/.codebuddy not found).");
  }

  if (!remove) messages.push(`Using node: ${command}`);
  return messages;
}

function status(home = homeDir()) {
  try {
    const claude = readJson(path.join(home, ".claude.json"));
    return Boolean(claude && claude.mcpServers && claude.mcpServers[SERVER_NAME]);
  } catch {
    return false;
  }
}

module.exports = { applyClaudeConfig, applyCodexConfig, removeCodexBlock, run, status };

if (require.main === module) {
  const remove = process.argv.includes("uninstall") || process.argv.includes("--remove");
  const checkStatus = process.argv.includes("--status");
  if (checkStatus) {
    process.stdout.write(status() ? "registered\n" : "not-registered\n");
    process.exit(status() ? 0 : 1);
  }
  try {
    for (const message of run(remove)) process.stdout.write(`${message}\n`);
    if (!remove) process.stdout.write("Restart Claude Code / Codex to pick up the new MCP server.\n");
  } catch (error) {
    process.stderr.write(`Could not update MCP config: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
