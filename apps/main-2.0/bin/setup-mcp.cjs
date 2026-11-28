#!/usr/bin/env node
"use strict";

// Registers (or removes) the AgentRecall Gateway / Streamable HTTP MCP Hub in
// coding-agent client configs. Run with `uninstall` to remove.

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "agent-recall";
const LEGACY_SERVER_NAME = "agent-recall-v2";
const CODEX_SECTION = "mcp_servers.agent_recall";
const LEGACY_CODEX_SECTION = "mcp_servers.agent_recall_v2";
const CLAUDE_PERMISSION = "mcp__agent-recall__*";
const LEGACY_CLAUDE_PERMISSION = "mcp__agent-recall-v2__*";

const CLIENT_CATALOG = [
  { clientId: "codex", label: "Codex", executable: "codex", supportsStdio: true, defaultEnabled: true },
  { clientId: "claude", label: "Claude Code", executable: "claude", supportsStdio: true, defaultEnabled: true },
  { clientId: "cursor", label: "Cursor", executable: "cursor", supportsStdio: false, defaultEnabled: false },
  { clientId: "gemini", label: "Gemini CLI", executable: "gemini", supportsStdio: false, defaultEnabled: false },
  { clientId: "opencode", label: "OpenCode", executable: "opencode", supportsStdio: false, defaultEnabled: false },
  { clientId: "qwen", label: "Qwen Code", executable: "qwen", supportsStdio: false, defaultEnabled: false },
  { clientId: "zcode", label: "ZCode", executable: "zcode", supportsStdio: false, defaultEnabled: false },
];

const CLIENT_BY_ID = new Map(CLIENT_CATALOG.map((item) => [item.clientId, item]));

function homeDir() {
  return process.env.AGENT_RECALL_TEST_HOME || os.homedir();
}

function serverScriptPath() {
  return path.join(__dirname, "..", "out", "mcp", "gateway-entry.js");
}

function sessionSearchScriptPath() {
  return path.join(__dirname, "agent-recall-mcp.mjs");
}

function gatewayDiscoveryPath(home = homeDir()) {
  const explicitBridge = process.env.AGENT_RECALL_MCP_BRIDGE?.trim();
  if (explicitBridge) return explicitBridge;
  const explicitUserData = process.env.AGENT_RECALL_USER_DATA_DIR?.trim();
  if (explicitUserData) return path.join(explicitUserData, "automation-mcp-bridge.json");
  const appData = process.env.AGENT_RECALL_APP_DATA_DIR?.trim();
  if (appData) return path.join(appData, "agent-recall-v2", "automation-mcp-bridge.json");
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "agent-recall-v2", "automation-mcp-bridge.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "agent-recall-v2", "automation-mcp-bridge.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "agent-recall-v2", "automation-mcp-bridge.json");
}

function absoluteEnvDir(variable, fallback) {
  const value = process.env[variable]?.trim();
  return value && path.isAbsolute(value) ? value : fallback;
}

function claudeConfigPath(home = homeDir()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configDir ? path.join(configDir, ".claude.json") : path.join(home, ".claude.json");
}

function claudeSettingsPath(home = homeDir()) {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, ".claude");
  return path.join(configDir, "settings.json");
}

function codexConfigPath(home = homeDir()) {
  const configDir = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  return path.join(configDir, "config.toml");
}

function cursorConfigPath(home = homeDir()) {
  return path.join(home, ".cursor", "mcp.json");
}

function geminiConfigPath(home = homeDir()) {
  return path.join(home, ".gemini", "settings.json");
}

function qwenConfigPath(home = homeDir()) {
  const configDir = absoluteEnvDir("QWEN_HOME", path.join(home, ".qwen"));
  return path.join(configDir, "settings.json");
}

function opencodeConfigPath(home = homeDir()) {
  const xdg = absoluteEnvDir("XDG_CONFIG_HOME", path.join(home, ".config"));
  return path.join(xdg, "opencode", "opencode.json");
}

function zcodeConfigPath(home = homeDir()) {
  return path.join(home, ".zcode", "cli", "config.json");
}

function configPathForClient(clientId, home = homeDir()) {
  switch (clientId) {
    case "codex": return codexConfigPath(home);
    case "claude": return claudeConfigPath(home);
    case "cursor": return cursorConfigPath(home);
    case "gemini": return geminiConfigPath(home);
    case "opencode": return opencodeConfigPath(home);
    case "qwen": return qwenConfigPath(home);
    case "zcode": return zcodeConfigPath(home);
    default: throw new Error(`Unsupported MCP client: ${clientId}`);
  }
}

function clientHomeCandidates(home = homeDir()) {
  const candidates = [home];
  // Electron can report a sandbox-specific home even though the coding-agent
  // clients use the operating-system home. Keep isolated app/test homes fully
  // isolated, but otherwise fall back to Node's view of the real user home.
  if (!process.env.AGENT_RECALL_TEST_HOME && !process.env.AGENT_RECALL_HOME_DIR) {
    candidates.push(os.homedir());
  }
  return [...new Set(candidates.filter(Boolean).map((candidate) => path.resolve(candidate)))];
}

function homeExecutableCandidates(clientId, home) {
  const entry = CLIENT_BY_ID.get(clientId);
  if (!entry) return [];
  const executable = entry.executable;
  const directories = [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, "Library", "pnpm"),
    path.join(home, "AppData", "Roaming", "npm"),
  ];
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return [...new Set(directories.flatMap((directory) => (
    extensions.map((extension) => path.join(directory, `${executable}${extension}`))
  )))];
}

function hasHomeClientEvidence(clientId, home) {
  if (clientId === "claude") {
    if (fs.existsSync(claudeConfigPath(home)) || fs.existsSync(path.join(home, ".claude"))) return true;
  } else {
    const configPath = configPathForClient(clientId, home);
    if (fs.existsSync(configPath) || fs.existsSync(path.dirname(configPath))) return true;
  }
  return homeExecutableCandidates(clientId, home).some((candidate) => fs.existsSync(candidate));
}

function pathExecutableDetected(clientId) {
  const entry = CLIENT_BY_ID.get(clientId);
  if (!entry) return false;
  const executable = entry.executable;
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean).some((directory) => (
    extensions.some((extension) => fs.existsSync(path.join(directory, `${executable}${extension}`)))
  ));
}

function hasClientEvidence(clientId, home) {
  return hasHomeClientEvidence(clientId, home) || pathExecutableDetected(clientId);
}

function resolveClientHome(clientId, home = homeDir()) {
  const candidates = clientHomeCandidates(home);
  return candidates.find((candidate) => hasHomeClientEvidence(clientId, candidate))
    || candidates.at(-1)
    || home;
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

// The packaged MCP server and SDK require Node 22 or newer. Prefer the current
// process, then fall back to an installed compatible runtime.
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

  // Prefer Node 22, falling back to the first >=22 runtime when 22 is unavailable.
  let fallback = null;
  for (const candidate of candidates) {
    const major = probeNodeMajor(candidate);
    if (major === 22) return candidate;
    if (major > 22 && fallback === null) fallback = candidate;
  }
  return fallback || "node";
}

function clientHubUrl(hub, clientId) {
  if (!hub?.url) return undefined;
  return `${String(hub.url).replace(/\/+$/, "")}/${clientId}`;
}

function hubAuthHeaders(hub) {
  return hub?.token ? { Authorization: `Bearer ${hub.token}` } : undefined;
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

function applyClaudeConfig(config, scriptPath, remove, command = "node", bridgePath, hub) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const servers = next.mcpServers && typeof next.mcpServers === "object" ? { ...next.mcpServers } : {};
  delete servers[LEGACY_SERVER_NAME];
  if (remove) delete servers[SERVER_NAME];
  else if (hub?.url) {
    const headers = hubAuthHeaders(hub);
    servers[SERVER_NAME] = {
      type: "http",
      url: clientHubUrl(hub, "claude"),
      ...(headers ? { headers } : {}),
    };
  } else {
    servers[SERVER_NAME] = {
      command,
      args: [scriptPath],
      ...(bridgePath ? { env: { AGENT_RECALL_MCP_BRIDGE: bridgePath } } : {}),
    };
  }
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
}

function applyClaudeSettings(settings, remove) {
  const next = settings && typeof settings === "object" && !Array.isArray(settings) ? { ...settings } : {};
  const permissions = next.permissions && typeof next.permissions === "object" && !Array.isArray(next.permissions)
    ? { ...next.permissions }
    : {};
  const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  const retained = allow.filter((rule) => rule !== CLAUDE_PERMISSION && rule !== LEGACY_CLAUDE_PERMISSION);
  if (!remove) retained.push(CLAUDE_PERMISSION);
  if (retained.length > 0) permissions.allow = retained;
  else delete permissions.allow;
  if (Object.keys(permissions).length > 0) next.permissions = permissions;
  else delete next.permissions;
  return next;
}

// --- Codex (~/.codex/config.toml, TOML) ------------------------------------

function applyCodexConfig(toml, scriptPath, remove, command = "node", bridgePath, hub) {
  let block;
  if (hub?.url) {
    const headersLine = hub.token
      ? `http_headers = { Authorization = ${JSON.stringify(`Bearer ${hub.token}`)} }\n`
      : "";
    block = `[${CODEX_SECTION}]\nurl = ${JSON.stringify(clientHubUrl(hub, "codex"))}\n${headersLine}default_tools_approval_mode = "approve"\n`;
  } else {
    // JSON.stringify both values: TOML basic-string escapes (\\, \") match JSON, so
    // Windows paths with backslashes stay valid.
    const environment = bridgePath
      ? `env = { AGENT_RECALL_MCP_BRIDGE = ${JSON.stringify(bridgePath)} }\n`
      : "";
    block = `[${CODEX_SECTION}]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(scriptPath)}]\n${environment}default_tools_approval_mode = "approve"\n`;
  }
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
    const tableHeader = line.trim().match(/^(?:\[([^\[\]]+)\]|\[\[([^\[\]]+)\]\])\s*(?:#.*)?$/);
    if (tableHeader) {
      const section = tableHeader[1] || tableHeader[2];
      skipping = section === CODEX_SECTION
        || section.startsWith(`${CODEX_SECTION}.`)
        || section === LEGACY_CODEX_SECTION
        || section.startsWith(`${LEGACY_CODEX_SECTION}.`);
      if (skipping) continue;
    }
    if (skipping) continue;
    out.push(line);
  }
  return out.join("\n");
}

// --- HTTP-native JSON clients (Cursor, Gemini CLI, Qwen Code, OpenCode, ZCode) ---

function applyHttpClientConfig(clientId, config, remove, hub) {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  const url = clientHubUrl(hub, clientId);
  const headers = hubAuthHeaders(hub);

  if (clientId === "opencode") {
    const mcp = next.mcp && typeof next.mcp === "object" && !Array.isArray(next.mcp) ? { ...next.mcp } : {};
    delete mcp[LEGACY_SERVER_NAME];
    if (remove) delete mcp[SERVER_NAME];
    else {
      if (!url) throw new Error("AgentRecall MCP HTTP Hub URL is required to configure OpenCode.");
      mcp[SERVER_NAME] = {
        type: "remote",
        url,
        ...(headers ? { headers } : {}),
        enabled: true,
      };
    }
    if (Object.keys(mcp).length > 0) next.mcp = mcp;
    else delete next.mcp;
    return next;
  }

  if (clientId === "zcode") {
    const mcp = next.mcp && typeof next.mcp === "object" && !Array.isArray(next.mcp) ? { ...next.mcp } : {};
    const servers = mcp.servers && typeof mcp.servers === "object" && !Array.isArray(mcp.servers)
      ? { ...mcp.servers }
      : {};
    delete servers[LEGACY_SERVER_NAME];
    if (remove) delete servers[SERVER_NAME];
    else {
      if (!url) throw new Error("AgentRecall MCP HTTP Hub URL is required to configure ZCode.");
      servers[SERVER_NAME] = {
        url,
        ...(headers ? { headers } : {}),
      };
    }
    if (Object.keys(servers).length > 0) mcp.servers = servers;
    else delete mcp.servers;
    if (Object.keys(mcp).length > 0) next.mcp = mcp;
    else delete next.mcp;
    return next;
  }

  // Cursor, Gemini CLI, Qwen Code all use top-level `mcpServers`.
  const servers = next.mcpServers && typeof next.mcpServers === "object" && !Array.isArray(next.mcpServers)
    ? { ...next.mcpServers }
    : {};
  delete servers[LEGACY_SERVER_NAME];
  if (remove) delete servers[SERVER_NAME];
  else {
    if (!url) throw new Error(`AgentRecall MCP HTTP Hub URL is required to configure ${clientId}.`);
    if (clientId === "gemini" || clientId === "qwen") {
      servers[SERVER_NAME] = {
        httpUrl: url,
        ...(headers ? { headers } : {}),
      };
    } else {
      servers[SERVER_NAME] = {
        url,
        ...(headers ? { headers } : {}),
      };
    }
  }
  if (Object.keys(servers).length > 0) next.mcpServers = servers;
  else delete next.mcpServers;
  return next;
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
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.agentrecall-backup`);
  fs.writeFileSync(tmp, contents, "utf8");
  fs.renameSync(tmp, filePath);
}

function clientDetected(clientId, home = homeDir()) {
  return hasClientEvidence(clientId, resolveClientHome(clientId, home));
}

function detectWrittenTransport(clientId, home = homeDir()) {
  home = resolveClientHome(clientId, home);
  try {
    if (clientId === "claude") {
      const entry = readJson(claudeConfigPath(home))?.mcpServers?.[SERVER_NAME];
      if (!entry || typeof entry !== "object") return undefined;
      if (entry.type === "http" || typeof entry.url === "string") return "http";
      if (typeof entry.command === "string") return "stdio";
      return undefined;
    }
    if (clientId === "codex") {
      const configPath = codexConfigPath(home);
      if (!fs.existsSync(configPath)) return undefined;
      const lines = fs.readFileSync(configPath, "utf8").split("\n");
      const sectionStart = lines.findIndex((line) => line.trim() === `[${CODEX_SECTION}]`);
      if (sectionStart < 0) return undefined;
      let hasUrl = false;
      let hasCommand = false;
      for (const line of lines.slice(sectionStart + 1)) {
        if (/^\s*\[/.test(line)) break;
        if (/^\s*url\s*=/.test(line)) hasUrl = true;
        if (/^\s*command\s*=/.test(line)) hasCommand = true;
      }
      if (hasUrl) return "http";
      if (hasCommand) return "stdio";
      return undefined;
    }
    return "http";
  } catch {
    return undefined;
  }
}

function clientConfigured(clientId, home = homeDir(), expectedTransport) {
  home = resolveClientHome(clientId, home);
  try {
    if (clientId === "claude") {
      const config = readJson(claudeConfigPath(home));
      const settings = readJson(claudeSettingsPath(home));
      const entry = config?.mcpServers?.[SERVER_NAME];
      if (!entry || !Array.isArray(settings?.permissions?.allow) || !settings.permissions.allow.includes(CLAUDE_PERMISSION)) {
        return false;
      }
      if (expectedTransport === "http") return entry.type === "http" && typeof entry.url === "string";
      if (expectedTransport === "stdio") return typeof entry.command === "string";
      return true;
    }
    if (clientId === "codex") {
      const configPath = codexConfigPath(home);
      if (!fs.existsSync(configPath)) return false;
      const lines = fs.readFileSync(configPath, "utf8").split("\n");
      const sectionStart = lines.findIndex((line) => line.trim() === `[${CODEX_SECTION}]`);
      if (sectionStart < 0) return false;
      let hasApproval = false;
      let hasUrl = false;
      let hasCommand = false;
      for (const line of lines.slice(sectionStart + 1)) {
        if (/^\s*\[/.test(line)) break;
        const trimmed = line.trim();
        if (trimmed === 'default_tools_approval_mode = "approve"') hasApproval = true;
        if (/^url\s*=/.test(trimmed)) hasUrl = true;
        if (/^command\s*=/.test(trimmed)) hasCommand = true;
      }
      if (!hasApproval) return false;
      if (expectedTransport === "http") return hasUrl;
      if (expectedTransport === "stdio") return hasCommand;
      return true;
    }
    const configPath = configPathForClient(clientId, home);
    if (!fs.existsSync(configPath)) return false;
    const doc = readJson(configPath);
    if (clientId === "opencode") return Boolean(doc?.mcp?.[SERVER_NAME]);
    if (clientId === "zcode") return Boolean(doc?.mcp?.servers?.[SERVER_NAME]);
    return Boolean(doc?.mcpServers?.[SERVER_NAME]);
  } catch {
    return false;
  }
}

function setClientEnabled(clientId, enabled, options = {}) {
  if (!CLIENT_BY_ID.has(clientId)) throw new Error(`Unsupported MCP client: ${clientId}`);
  const home = resolveClientHome(clientId, options.homeDir || homeDir());
  const scriptPath = serverScriptPath();
  const bridgePath = gatewayDiscoveryPath(home);
  const useHttp = options.transport === "http" || (!CLIENT_BY_ID.get(clientId).supportsStdio);
  const hub = useHttp ? options.hub : undefined;
  const command = enabled && !useHttp ? nodeCommand() : "node";

  if (clientId === "claude") {
    const configPath = claudeConfigPath(home);
    const settingsPath = claudeSettingsPath(home);
    if (!enabled && !fs.existsSync(configPath) && !fs.existsSync(settingsPath)) return;
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const currentSettings = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
    const config = fs.existsSync(configPath) || enabled
      ? applyClaudeConfig(readJson(configPath), scriptPath, !enabled, command, bridgePath, hub)
      : undefined;
    const settings = fs.existsSync(settingsPath) || enabled
      ? applyClaudeSettings(readJson(settingsPath), !enabled)
      : undefined;
    if (config) {
      const next = `${JSON.stringify(config, null, 2)}\n`;
      if (current !== next) writeFileAtomic(configPath, next);
    }
    if (settings) {
      const nextSettings = `${JSON.stringify(settings, null, 2)}\n`;
      if (currentSettings !== nextSettings) writeFileAtomic(settingsPath, nextSettings);
    }
    return;
  }

  if (clientId === "codex") {
    const configPath = codexConfigPath(home);
    if (!enabled && !fs.existsSync(configPath)) return;
    const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const next = applyCodexConfig(current, scriptPath, !enabled, command, bridgePath, hub);
    const contents = next.endsWith("\n") ? next : `${next}\n`;
    if (current !== contents) writeFileAtomic(configPath, contents);
    return;
  }

  const configPath = configPathForClient(clientId, home);
  if (!enabled && !fs.existsSync(configPath)) return;
  const current = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const updated = applyHttpClientConfig(clientId, readJson(configPath), !enabled, hub);
  const next = `${JSON.stringify(updated, null, 2)}\n`;
  if (current !== next) writeFileAtomic(configPath, next);
}

function clientConnections(preferences = { codex: true, claude: true }, home = homeDir(), options = {}) {
  const transports = options.transports || {};
  const allowedByClient = options.allowedServerIds || {};
  const hub = options.hub;
  return {
    clients: CLIENT_CATALOG.map((client) => {
      const clientHome = resolveClientHome(client.clientId, home);
      const enabledPref = preferences[client.clientId];
      const enabled = enabledPref === undefined ? client.defaultEnabled : enabledPref !== false;
      const explicitTransport = transports[client.clientId];
      const transport = client.supportsStdio
        ? (explicitTransport === "http" || explicitTransport === "stdio"
            ? explicitTransport
            : (detectWrittenTransport(client.clientId, clientHome) ?? "stdio"))
        : "http";
      const scopedAllowed = allowedByClient[client.clientId];
      return {
        clientId: client.clientId,
        label: client.label,
        configPath: configPathForClient(client.clientId, clientHome),
        detected: hasClientEvidence(client.clientId, clientHome),
        enabled,
        configured: clientConfigured(client.clientId, clientHome, transport),
        transport,
        supportsStdio: client.supportsStdio,
        ...(hub?.url ? { hubUrl: clientHubUrl(hub, client.clientId) } : {}),
        ...(Array.isArray(scopedAllowed) ? { allowedServerIds: [...scopedAllowed] } : {}),
      };
    }),
  };
}

function run(remove, options = {}) {
  const home = options.homeDir || homeDir();
  const messages = [];
  for (const clientId of ["claude", "codex"]) {
    if (!remove && !clientDetected(clientId, home)) {
      messages.push(`Skipped ${clientId} (not detected).`);
      continue;
    }
    setClientEnabled(clientId, !remove, { homeDir: home });
    messages.push(`${remove ? "Removed" : "Configured"} AgentRecall Gateway for ${clientId}.`);
  }
  return messages;
}

function status(home = homeDir()) {
  return clientConfigured("claude", home) || clientConfigured("codex", home);
}

// The launch command used when running the packaged MCP server, resolved from
// the same node selection as `run`. Used by the app to synthesize the built-in
// session-search server entry in the MCP registry.
function serverDefinition() {
  return {
    id: "agent-recall-session-search",
    name: "agent-recall",
    transport: "stdio",
    command: nodeCommand(),
    args: [sessionSearchScriptPath()],
    env: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

module.exports = {
  applyClaudeConfig,
  applyClaudeSettings,
  applyCodexConfig,
  applyDshConfig,
  applyHttpClientConfig,
  clientConnections,
  clientConfigured,
  gatewayDiscoveryPath,
  removeCodexBlock,
  removeDshBlock,
  run,
  serverDefinition,
  setClientEnabled,
  status,
};

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
