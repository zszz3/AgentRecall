#!/usr/bin/env node
"use strict";

// Registers (or removes) the agent-recall MCP server in Claude Code and
// Codex configs so they can search past sessions. Run with `uninstall` to remove.

const childProcess = require("node:child_process");
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

function probeNodeMajor(candidate) {
  if (candidate !== "node" && !fs.existsSync(candidate)) return 0;
  try {
    const version = childProcess.execFileSync(candidate, ["-v"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    return nodeMajor(version);
  } catch {
    return 0;
  }
}

// The MCP server needs node >= 22 (node:sqlite). Crucially, node 22's bundled
// SQLite includes the fts5 module that the SessionStore depends on, while some
// node 23 builds ship SQLite without fts5 — so we prefer node 22 specifically
// and only fall back to other >=22 versions when 22 is unavailable.
function nodeCommand() {
  const candidates = [];

  // The Node executable running this setup script.
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

  // Prefer node 22.x (fts5 is reliably available there), falling back to the
  // first >=22 runtime when 22 is unavailable.
  let fallback = null;
  for (const candidate of candidates) {
    const major = probeNodeMajor(candidate);
    if (major === 22) return candidate;
    if (major > 22 && fallback === null) fallback = candidate;
  }
  return fallback || "node";
}

// --- DeepSeek Harness (~/.dsh/cordis.patch.yml, YAML patch array) -----------

const DSH_MCP_ROW_ID = "mcp-agent-recall";
const DSH_PATCH_HEADER = "# Agent Recall MCP server — managed by Agent Recall (setup-mcp).";
const DSH_PATCH_ENTRY = `- insert:
    - id: ${DSH_MCP_ROW_ID}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: agent-recall
        transport: stdio
        command: __COMMAND__
        args: [__SCRIPT__]
        failOnStartupError: false`;

function yamlScalar(value) {
  // JSON string literal escaping is a valid YAML double-quoted scalar.
  return JSON.stringify(value);
}

function renderDshBlock(command, scriptPath) {
  return DSH_PATCH_ENTRY
    .replace("__COMMAND__", yamlScalar(command))
    .replace("__SCRIPT__", yamlScalar(scriptPath));
}

function removeDshBlock(contents) {
  // Drop the managed insert unit (header row + following indented lines), then trim trailing blanks.
  const lines = (contents || "").split("\n");
  const out = [];
  let skipping = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    // The managed entry is a two-line unit: the "- insert:" opener and the row.
    if (trimmed === "- insert:" && !skipping) {
      // Only treat as ours when the next line is the managed row id.
      const next = lines[index + 1];
      if (next && next.trim() === `- id: ${DSH_MCP_ROW_ID}`) {
        skipping = true;
        continue;
      }
    }
    if (skipping) {
      if (/^-\s/.test(line) || trimmed === "") {
        skipping = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  // Remove the header comment if it directly precedes the row.
  const joined = out.join("\n");
  return joined
    .replace(new RegExp(`${DSH_PATCH_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n?`), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function applyDshConfig(contents, scriptPath, remove, command = "node") {
  const stripped = removeDshBlock(contents);
  const meaningful = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const emptyPatch = meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === "[]");
  if (remove) {
    if (!emptyPatch) return `${stripped}\n`;
    const comments = stripped
      .split("\n")
      .filter((line) => line.trim().startsWith("#"))
      .join("\n");
    return comments ? `${comments}\n[]\n` : "[]\n";
  }
  const base = emptyPatch
    ? stripped.split("\n").filter((line) => line.trim() !== "[]").join("\n").trim()
    : stripped;
  const block = `${DSH_PATCH_HEADER}\n${renderDshBlock(command, scriptPath)}`;
  return base ? `${base}\n\n${block}\n` : `# dsh profile patch layer (user-editable).\n${block}\n`;
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

  // DeepSeek Harness reads its home-level patch layer ~/.dsh/cordis.patch.yml
  // (applied over every profile). Register there when the harness is present.
  // Wrapped separately so a dsh failure never blocks the other registrations.
  const dshHome = process.env.DSH_HOME?.trim() || path.join(home, ".dsh");
  if (fs.existsSync(dshHome) && (!remove || fs.existsSync(path.join(dshHome, "cordis.patch.yml")))) {
    try {
      const dshPatchPath = path.join(dshHome, "cordis.patch.yml");
      const current = fs.existsSync(dshPatchPath) ? fs.readFileSync(dshPatchPath, "utf8") : "";
      const next = applyDshConfig(current, scriptPath, remove, command);
      writeFileAtomic(dshPatchPath, next);
      messages.push(`${remove ? "Removed" : "Configured"} MCP server in ${dshPatchPath}`);
    } catch (error) {
      messages.push(`Failed to configure DeepSeek Harness MCP (${error instanceof Error ? error.message : String(error)}).`);
    }
  } else {
    messages.push("Skipped DeepSeek Harness (~/.dsh not found).");
  }

  if (!remove) messages.push(`Using node: ${command}`);
  return messages;
}

function serverDefinition() {
  return {
    id: "agent-recall-session-search",
    name: "agent-recall",
    transport: "stdio",
    command: nodeCommand(),
    args: [serverScriptPath()],
    env: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

function status(home = homeDir()) {
  try {
    const claude = readJson(path.join(home, ".claude.json"));
    return Boolean(claude && claude.mcpServers && claude.mcpServers[SERVER_NAME]);
  } catch {
    return false;
  }
}

module.exports = { applyClaudeConfig, applyCodexConfig, applyDshConfig, removeCodexBlock, removeDshBlock, run, serverDefinition, status };

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
