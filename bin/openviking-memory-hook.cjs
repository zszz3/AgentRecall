#!/usr/bin/env node
"use strict";

// Shared Claude Code/Codex hook. It deliberately stays dependency-free so the
// packaged file can run before the desktop renderer has been opened.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_PROMPT_CHARS = 2_000;
const MAX_TURN_CHARS = 12_000;
const MAX_CONTEXT_CHARS = 6_000;
const REQUEST_TIMEOUT_MS = 5_000;

function findWorkspaceForCwd(manifest, cwd, platform = process.platform) {
  if (!manifest || !Array.isArray(manifest.workspaces) || typeof cwd !== "string" || !cwd.trim()) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value) => {
    let normalized = pathApi.resolve(value);
    if (platform === "win32") normalized = normalized.toLowerCase();
    const parsed = pathApi.parse(normalized);
    while (normalized.length > parsed.root.length && normalized.endsWith(pathApi.sep)) normalized = normalized.slice(0, -1);
    return normalized;
  };
  const target = normalize(cwd);
  let match = null;
  let matchLength = -1;
  for (const workspace of manifest.workspaces) {
    if (!workspace || typeof workspace.rootPath !== "string") continue;
    const root = normalize(workspace.rootPath);
    if (target !== root && !target.startsWith(`${root}${pathApi.sep}`)) continue;
    if (root.length > matchLength) {
      match = workspace;
      matchLength = root.length;
    }
  }
  return match;
}

async function handleHook(input, options) {
  try {
    const opts = options || {};
    const manifest = opts.manifest || readManifest(opts.manifestPath);
    if (!manifest || manifest.version !== 1 || typeof manifest.baseUrl !== "string" || !manifest.baseUrl) return {};
    const agent = opts.agent;
    if (!agent || !manifest.integrations || manifest.integrations[agent] !== true) return {};

    const cwd = typeof input?.cwd === "string" ? input.cwd : process.cwd();
    const realpathSync = opts.realpathSync || fs.realpathSync.native;
    let canonicalCwd;
    try {
      canonicalCwd = realpathSync(cwd);
    } catch {
      return {};
    }
    const workspace = findWorkspaceForCwd(manifest, canonicalCwd, opts.platform || process.platform);
    if (!workspace) return {};

    if (opts.event === "UserPromptSubmit") {
      const prompt = cleanText(input.prompt, MAX_PROMPT_CHARS);
      if (!prompt) return {};
      const context = await recallForWorkspace(workspace, prompt, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
      return context ? {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      } : {};
    }

    const sessionId = hookSessionId(workspace.id, agent, input);
    if (!sessionId) return {};
    if (opts.event === "Stop") {
      const turn = latestTurn(input);
      if (!turn) return {};
      await captureTurn(workspace, sessionId, turn, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        stateDir: opts.stateDir || manifest.stateDir,
      });
      return {};
    }

    if (opts.event === "PreCompact" || opts.event === "SessionEnd") {
      await commitSession(workspace, sessionId, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
    }
  } catch {
    // Agent hooks must never prevent a prompt, compaction, or shutdown.
  }
  return {};
}

async function recallForWorkspace(workspace, query, options) {
  const prompt = cleanText(query, MAX_PROMPT_CHARS);
  if (!prompt) return "";
  const response = await requestJson("/api/v1/search/find", workspace, options, {
    method: "POST",
    body: JSON.stringify({ query: prompt, target_uri: "viking://user/memories", limit: 5 }),
  });
  if (!response.accepted) return "";
  const result = response.payload?.result || response.payload || {};
  const memories = Array.isArray(result.memories)
    ? result.memories
    : Array.isArray(result.resources)
      ? result.resources
      : Array.isArray(result.items)
        ? result.items
        : [];
  const snippets = memories.slice(0, 5).map((memory) => {
    if (!memory || typeof memory !== "object") return "";
    const content = cleanText(memory.abstract || memory.overview || memory.content || memory.title, 1_000);
    if (!content) return "";
    const uri = cleanText(memory.uri, 300);
    return uri ? `- ${content} (${uri})` : `- ${content}`;
  }).filter(Boolean);
  if (snippets.length === 0) return "";
  return `<openviking-context source="auto-recall">\nRelevant memory from this managed directory:\n${snippets.join("\n")}\n</openviking-context>`
    .slice(0, MAX_CONTEXT_CHARS);
}

async function captureTurn(workspace, sessionId, turn, options) {
  const user = cleanText(turn?.user, MAX_TURN_CHARS);
  const assistant = cleanText(turn?.assistant, MAX_TURN_CHARS);
  if (!user || !assistant) return false;
  const fingerprint = sha256(JSON.stringify([user, assistant]));
  const statePath = options.stateDir ? path.join(options.stateDir, `${sha256(sessionId)}.json`) : null;
  if (statePath) {
    try {
      const previous = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (previous.fingerprint === fingerprint) return false;
    } catch {
      // A missing or corrupt deduplication record is safe to rebuild.
    }
  }

  const encodedSessionId = encodeURIComponent(sessionId);
  const created = await requestJson(`/api/v1/sessions/${encodedSessionId}?auto_create=true`, workspace, options, { method: "GET" });
  if (!created.accepted) return false;
  const appended = await requestJson(`/api/v1/sessions/${encodedSessionId}/messages/batch`, workspace, options, {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: user }, { role: "assistant", content: assistant }] }),
  });
  if (!appended.accepted) return false;
  const committed = await commitSession(workspace, sessionId, options);
  if (!committed) return false;

  if (statePath) writeStateAtomic(statePath, { fingerprint, updatedAt: new Date().toISOString() });
  return true;
}

async function commitSession(workspace, sessionId, options) {
  const response = await requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, workspace, options, {
    method: "POST",
    body: JSON.stringify({ keep_recent_count: 0 }),
  });
  return response.accepted;
}

async function requestJson(route, workspace, options, init) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function" || !options.baseUrl) return { accepted: false, payload: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${options.baseUrl.replace(/\/$/, "")}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": workspace.apiKey,
        "X-OpenViking-Account": workspace.accountId,
        "X-OpenViking-User": workspace.userId,
        ...(init.headers || {}),
      },
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Successful endpoints may return no body.
    }
    const envelopeFailed = payload && (payload.status === "error" || payload.success === false || payload.code >= 400);
    return { accepted: response.ok !== false && !envelopeFailed, payload };
  } catch {
    return { accepted: false, payload: null };
  } finally {
    clearTimeout(timer);
  }
}

function latestTurn(input) {
  let entries = [];
  if (typeof input.transcript_path === "string" && input.transcript_path) {
    try {
      const raw = fs.readFileSync(input.transcript_path, "utf8");
      const parsed = raw.trim().startsWith("[")
        ? JSON.parse(raw)
        : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
  }

  let assistant = cleanText(input.last_assistant_message, MAX_TURN_CHARS);
  let user = cleanText(input.prompt, MAX_TURN_CHARS);
  for (let index = entries.length - 1; index >= 0 && (!user || !assistant); index -= 1) {
    const entry = entries[index] || {};
    const message = entry.message && typeof entry.message === "object" ? entry.message : entry;
    const role = message.role || entry.type;
    const content = cleanText(message.content ?? message.text, MAX_TURN_CHARS);
    if (!content) continue;
    if (!assistant && role === "assistant") assistant = content;
    if (!user && (role === "user" || role === "human")) user = content;
  }
  return user && assistant ? { user, assistant } : null;
}

function cleanText(value, maxLength) {
  let text = "";
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    text = value.map((part) => typeof part === "string" ? part : part && part.type === "text" ? part.text : "").filter(Boolean).join("\n");
  } else if (value && typeof value === "object" && typeof value.text === "string") text = value.text;
  return text
    .replace(/<openviking-context\b[^>]*>[\s\S]*?<\/openviking-context>/gi, "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function hookSessionId(workspaceId, agent, input) {
  const externalId = input.session_id || input.sessionId || input.conversation_id || input.conversationId;
  return externalId ? `agent-recall-${sha256(`${workspaceId}:${agent}:${externalId}`).slice(0, 32)}` : null;
}

function readManifest(manifestPath) {
  if (!manifestPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStateAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArguments(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    agent: valueAfter("--agent"),
    event: valueAfter("--event"),
    manifestPath: valueAfter("--manifest") || process.env.AGENT_RECALL_OPENVIKING_MANIFEST,
  };
}

function runCli() {
  const chunks = [];
  let size = 0;
  process.stdin.on("data", (chunk) => {
    size += chunk.length;
    if (size <= MAX_STDIN_BYTES) chunks.push(chunk);
  });
  process.stdin.on("end", async () => {
    let input = {};
    if (size <= MAX_STDIN_BYTES) {
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        input = {};
      }
    }
    const result = await handleHook(input, parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  });
  process.stdin.resume();
}

module.exports = {
  captureTurn,
  commitSession,
  findWorkspaceForCwd,
  handleHook,
  recallForWorkspace,
};

if (require.main === module) runCli();
