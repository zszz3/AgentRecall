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
const MAX_RECENT_CONTEXT_CHARS = 3_000;
const MAX_CORE_MEMORY_CHARS = 2_000;
const REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_COMMIT_TOKEN_THRESHOLD = 7_000;

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

    const sessionId = hookSessionId(workspace.id, agent, input);
    if (opts.event === "UserPromptSubmit") {
      const prompt = cleanText(input.prompt, MAX_PROMPT_CHARS);
      if (!prompt) return {};
      const stateDir = opts.stateDir || manifest.stateDir;
      const state = sessionId ? readSessionState(stateDir, sessionId) : null;
      const recentTurns = state?.recentTurns?.length
        ? state.recentTurns
        : isVagueContinuation(prompt)
          ? latestWorkspaceHandoff(stateDir, workspace.id, sessionId)
          : undefined;
      const context = await recallForWorkspace(workspace, prompt, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        sessionId,
        recentTurns,
      });
      return context ? {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: context,
        },
      } : {};
    }

    if (!sessionId) return {};
    if (opts.event === "Stop") {
      const turn = latestTurn(input);
      if (!turn) return {};
      await captureTurn(workspace, sessionId, turn, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        stateDir: opts.stateDir || manifest.stateDir,
        commitTokenThreshold: opts.commitTokenThreshold,
        commitRequested: explicitlyRequestsMemory(turn.user),
      });
      return {};
    }

    if (opts.event === "PreCompact" || opts.event === "SessionEnd") {
      await commitSession(workspace, sessionId, {
        baseUrl: manifest.baseUrl,
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
        stateDir: opts.stateDir || manifest.stateDir,
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
  const contextualQuery = buildContextualQuery(prompt, options.recentTurns);
  const searchBody = {
    query: contextualQuery,
    target_uri: "viking://user/memories",
    limit: 12,
    ...(options.sessionId ? { session_id: options.sessionId } : {}),
  };
  const searchRoute = options.sessionId ? "/api/v1/search/search" : "/api/v1/search/find";
  const [coreMemories, initialResponse] = await Promise.all([
    readCoreMemories(workspace, options),
    requestJson(searchRoute, workspace, options, {
      method: "POST",
      body: JSON.stringify(searchBody),
    }),
  ]);
  const response = initialResponse.accepted || !options.sessionId || initialResponse.transportFailed
    ? initialResponse
    : await requestJson("/api/v1/search/find", workspace, options, {
    method: "POST",
      body: JSON.stringify({ ...searchBody, session_id: undefined }),
  });
  const result = response.payload?.result || response.payload || {};
  const memories = Array.isArray(result.memories)
    ? result.memories
    : Array.isArray(result.resources)
      ? result.resources
      : Array.isArray(result.items)
        ? result.items
        : [];
  const snippets = selectRecallMemories(memories).map((memory) => {
    if (!memory || typeof memory !== "object") return "";
    const content = cleanText(memory.abstract || memory.overview || memory.content || memory.title, 1_000);
    if (!content) return "";
    const uri = cleanText(memory.uri, 300);
    return uri ? `- ${content} (${uri})` : `- ${content}`;
  }).filter(Boolean);
  if (coreMemories.length === 0 && snippets.length === 0) return "";
  const sections = [];
  if (coreMemories.length > 0) {
    sections.push(`<openviking-core>\n${coreMemories.join("\n")}\n</openviking-core>`);
  }
  if (snippets.length > 0) {
    const opening = "<openviking-recall>\n";
    const closing = "\n</openviking-recall>";
    const outerSize = '<openviking-context source="auto-recall">\n\n</openviking-context>'.length;
    const fixedSize = sections.join("\n").length;
    const accepted = [];
    for (const snippet of snippets) {
      const candidate = [...accepted, snippet].join("\n");
      if (outerSize + fixedSize + opening.length + candidate.length + closing.length > MAX_CONTEXT_CHARS) break;
      accepted.push(snippet);
    }
    if (accepted.length > 0) sections.push(`${opening}${accepted.join("\n")}${closing}`);
  }
  return `<openviking-context source="auto-recall">\n${sections.join("\n")}\n</openviking-context>`;
}

function selectRecallMemories(memories) {
  const quotas = { personal: 2, project: 2, execution: 3, other: 1 };
  const selected = [];
  const counts = { personal: 0, project: 0, execution: 0, other: 0 };
  for (const memory of memories) {
    if (!memory || typeof memory !== "object") continue;
    const uri = String(memory.uri || "").toLowerCase();
    const bucket = /\/(?:profile|preferences|entities)\//u.test(`${uri}/`)
      ? "personal"
      : /\/(?:events|decisions|context)\//u.test(`${uri}/`)
        ? "project"
        : /\/(?:cases|patterns|experiences|trajectories|tools|skills)\//u.test(`${uri}/`)
          ? "execution"
          : "other";
    if (counts[bucket] >= quotas[bucket]) continue;
    counts[bucket] += 1;
    selected.push(memory);
  }
  return selected;
}

function buildContextualQuery(prompt, recentTurns) {
  const turns = Array.isArray(recentTurns) ? recentTurns.slice(-2) : [];
  const context = turns.map((turn) => {
    const user = cleanText(turn?.user, 750);
    const assistant = cleanText(turn?.assistant, 750);
    return [
      user ? `User: ${user}` : "",
      assistant ? `Assistant outcome: ${assistant}` : "",
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
  if (!context) return prompt;
  return `Current request:\n${prompt}\n\nRecent conversation:\n${context}`
    .slice(0, MAX_PROMPT_CHARS + MAX_RECENT_CONTEXT_CHARS);
}

async function readCoreMemories(workspace, options) {
  const uris = [
    "viking://user/memories/identity.md",
    "viking://user/memories/soul.md",
  ];
  const values = await Promise.all(uris.map(async (uri) => {
    const response = await requestJson(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}&offset=0&limit=${MAX_CORE_MEMORY_CHARS}`,
      workspace,
      options,
      { method: "GET" },
    );
    if (!response.accepted) return "";
    const result = response.payload?.result ?? response.payload;
    const content = typeof result === "string"
      ? result
      : result && typeof result === "object"
        ? result.content ?? result.text ?? result.data
        : "";
    const cleaned = cleanText(content, MAX_CORE_MEMORY_CHARS / uris.length);
    return cleaned ? `- ${cleaned} (${uri})` : "";
  }));
  return values.filter(Boolean);
}

async function captureTurn(workspace, sessionId, turn, options) {
  const user = cleanText(turn?.user, MAX_TURN_CHARS);
  const assistantResult = cleanText(turn?.assistant, MAX_TURN_CHARS);
  const executionSummary = cleanText(turn?.executionSummary, 1_000);
  const assistant = cleanText([
    assistantResult,
    executionSummary ? `Execution summary: ${executionSummary}` : "",
  ].filter(Boolean).join("\n\n"), MAX_TURN_CHARS);
  if (!user || !assistant) return false;
  const fingerprint = sha256(JSON.stringify([user, assistant]));
  const statePath = sessionStatePath(options.stateDir, sessionId);
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

  const previous = readSessionState(options.stateDir, sessionId) || {};
  const pendingTokenEstimate = Number(previous.pendingTokenEstimate || 0) + estimateTokens(user) + estimateTokens(assistant);
  if (statePath) {
    const recentTurns = Array.isArray(previous.recentTurns) ? previous.recentTurns : [];
    writeStateAtomic(statePath, {
      ...previous,
      sessionId,
      workspaceId: workspace.id,
      fingerprint,
      recentTurns: [...recentTurns, { user, assistant }].slice(-2),
      pendingTokenEstimate,
      pendingSince: previous.pendingSince || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  const threshold = Number.isFinite(options.commitTokenThreshold)
    ? Math.max(1, options.commitTokenThreshold)
    : DEFAULT_COMMIT_TOKEN_THRESHOLD;
  if (options.commitRequested === true || pendingTokenEstimate >= threshold) {
    await commitSession(workspace, sessionId, options);
  }
  return true;
}

async function commitSession(workspace, sessionId, options) {
  const response = await requestJson(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, workspace, options, {
    method: "POST",
    body: JSON.stringify({ keep_recent_count: 0 }),
  });
  if (response.accepted) {
    const statePath = sessionStatePath(options.stateDir, sessionId);
    if (statePath) {
      const previous = readSessionState(options.stateDir, sessionId);
      if (previous) {
        writeStateAtomic(statePath, {
          ...previous,
          pendingTokenEstimate: 0,
          pendingSince: null,
          lastCommittedAt: new Date().toISOString(),
        });
      }
    }
  }
  return response.accepted;
}

function estimateTokens(value) {
  const text = String(value || "");
  let cjk = 0;
  for (const character of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

function explicitlyRequestsMemory(value) {
  const text = cleanText(value, MAX_PROMPT_CHARS);
  return /(?:请|帮我)?(?:记住|记一下|保存为记忆)|(?:remember|save)\s+(?:this|that|it|as memory)\b/iu.test(text);
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
    return { accepted: response.ok !== false && !envelopeFailed, payload, transportFailed: false };
  } catch {
    return { accepted: false, payload: null, transportFailed: true };
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
  return user && assistant ? {
    user,
    assistant,
    executionSummary: summarizeExecution(entries),
  } : null;
}

function summarizeExecution(entries) {
  let turnStart = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] || {};
    const message = entry.message && typeof entry.message === "object" ? entry.message : entry;
    const role = message.role || entry.type;
    if ((role === "user" || role === "human") && cleanText(message.content ?? message.text, MAX_TURN_CHARS)) {
      turnStart = index;
      break;
    }
  }
  const tools = new Map();
  for (const entry of entries.slice(turnStart + 1)) {
    const message = entry?.message && typeof entry.message === "object" ? entry.message : entry;
    const parts = Array.isArray(message?.content) ? message.content : [];
    for (const part of parts) {
      if (part?.type === "tool_use") {
        const name = String(part.name || "tool").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80) || "tool";
        tools.set(String(part.id || name), { name, status: "invoked" });
      }
      if (part?.type === "tool_result") {
        const key = String(part.tool_use_id || "");
        const existing = tools.get(key);
        if (existing) existing.status = part.is_error === true ? "failed" : "succeeded";
      }
    }
  }
  return [...tools.values()]
    .slice(0, 20)
    .map((tool) => `${tool.name} (${tool.status})`)
    .join(", ");
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

function sessionStatePath(stateDir, sessionId) {
  return stateDir && sessionId ? path.join(stateDir, `${sha256(sessionId)}.json`) : null;
}

function readSessionState(stateDir, sessionId) {
  const filePath = sessionStatePath(stateDir, sessionId);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function latestWorkspaceHandoff(stateDir, workspaceId, excludedSessionId) {
  if (!stateDir || !workspaceId) return undefined;
  let filenames;
  try {
    filenames = fs.readdirSync(stateDir).filter((name) => name.endsWith(".json")).slice(0, 500);
  } catch {
    return undefined;
  }
  let latest = null;
  for (const filename of filenames) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(stateDir, filename), "utf8"));
      if (value?.workspaceId !== workspaceId || value?.sessionId === excludedSessionId) continue;
      if (!Array.isArray(value.recentTurns) || value.recentTurns.length === 0) continue;
      const updatedAt = Date.parse(value.updatedAt || "");
      if (!latest || updatedAt > latest.updatedAt) latest = { updatedAt, recentTurns: value.recentTurns };
    } catch {
      // Corrupt hook state is isolated to that session.
    }
  }
  return latest?.recentTurns?.slice(-2);
}

function isVagueContinuation(value) {
  const text = cleanText(value, 200);
  if (!text || text.length > 80) return false;
  return /(?:继续|接着|刚才|上次|那个|这个|按这个|照这个|然后呢|做吧)|\b(?:continue|resume|that|it|previous|pick up)\b/iu.test(text);
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
  explicitlyRequestsMemory,
  findWorkspaceForCwd,
  handleHook,
  recallForWorkspace,
};

if (require.main === module) runCli();
