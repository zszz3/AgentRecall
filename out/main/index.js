import { app, globalShortcut, ipcMain, clipboard, Menu, BrowserWindow, nativeImage, Tray, screen } from "electron";
import Store from "electron-store";
import * as path from "node:path";
import path__default from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import https from "node:https";
import { createRequire } from "node:module";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function extractTextBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block.type === "tool_use" || block.type === "tool_result" || block.type === "input_image") return "";
    return block.text || "";
  }).filter(Boolean).join("\n");
}
const claudeAdapter = {
  format: "claude",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw;
    if (line.type !== "user" && line.type !== "assistant") return null;
    if (!line.message?.content) return null;
    const content = extractTextBlocks(line.message.content);
    if (!content) return null;
    return {
      role: line.type,
      content,
      timestamp: line.timestamp || ""
    };
  }
};
const codexAdapter = {
  format: "codex",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw;
    if (line.type === "response_item" && line.payload?.type === "message" && line.payload.role) {
      if (line.payload.role !== "user" && line.payload.role !== "assistant") return null;
      const content = extractTextBlocks(line.payload.content);
      if (!content) return null;
      return {
        role: line.payload.role,
        content,
        timestamp: line.timestamp || ""
      };
    }
    if (line.type === "message" && line.role && line.content) {
      if (line.role !== "user" && line.role !== "assistant") return null;
      const content = extractTextBlocks(line.content);
      if (!content) return null;
      return {
        role: line.role,
        content,
        timestamp: line.timestamp || ""
      };
    }
    return null;
  }
};
function getFormatForSource(source) {
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}
function getAdapter(sourceOrFormat) {
  if (sourceOrFormat === "claude" || sourceOrFormat === "codex") {
    return sourceOrFormat === "claude" ? claudeAdapter : codexAdapter;
  }
  return getFormatForSource(sourceOrFormat) === "claude" ? claudeAdapter : codexAdapter;
}
function isMeaningfulUserMessage(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^#\s*(AGENTS|CLAUDE)\.md/i.test(trimmed)) return false;
  if (/^<(system-reminder|environment_context|command-message|command-name|command-args|task-notification|local-command-stdout|local-command-stderr|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]/.test(
    trimmed
  )) {
    return false;
  }
  if (trimmed.startsWith("Caveat:")) return false;
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(trimmed)) return false;
  if (/^\[Image:[^\]]*\]$/.test(trimmed)) return false;
  return true;
}
function cleanTitle(text) {
  const stripped = text.trim().replace(/^<[^>]+>\s*/, "");
  const firstLine = stripped.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (firstLine || stripped).slice(0, 120);
}
const CODEX_APP_ORIGINATOR = "Codex Desktop";
const CLAUDE_INTERNAL_DIR = ".claude-internal";
const CODEX_INTERNAL_DIR = ".codex-internal";
function emptyTokenUsage$1() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}
function parseCodexSessionMetaLine(parsed) {
  if (parsed.type === "session_meta" && parsed.payload?.id) {
    return {
      id: parsed.payload.id,
      projectPath: parsed.payload.cwd || "",
      ts: parsed.timestamp ? new Date(parsed.timestamp).getTime() : 0,
      gitBranch: parsed.payload.git?.branch,
      originator: parsed.payload.originator
    };
  }
  if (parsed.id && parsed.timestamp && !parsed.type) {
    return {
      id: parsed.id,
      projectPath: parsed.git?.cwd || "",
      ts: new Date(parsed.timestamp).getTime()
    };
  }
  return null;
}
function safeStat(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}
function readJsonl(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  return rows;
}
function extractMessages(rows, format) {
  const adapter = getAdapter(format);
  const messages = [];
  for (const raw of rows) {
    const parsed = adapter.parseLine(raw);
    if (!parsed) continue;
    if (parsed.role === "user" && !isMeaningfulUserMessage(parsed.content)) continue;
    messages.push({ ...parsed, index: messages.length });
  }
  return messages;
}
function firstQuestion(messages) {
  return messages.find((message) => message.role === "user" && isMeaningfulUserMessage(message.content))?.content || "";
}
function isRecord(value) {
  return Boolean(value) && typeof value === "object";
}
function objectField(value, key) {
  if (!isRecord(value)) return null;
  const field = value[key];
  return isRecord(field) ? field : null;
}
function stringField(value, key) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}
function numberField(value, key) {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}
function addTokenUsage(total, next) {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
  total.reasoningOutputTokens += next.reasoningOutputTokens;
  total.totalTokens += next.totalTokens;
}
function createTokenUsage(inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens) {
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens
  };
}
function parseTimestampMs(value) {
  if (typeof value !== "string") return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function tokenEvent(timestamp, dedupeKey, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens) {
  return {
    timestamp,
    dedupeKey,
    ...createTokenUsage(inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens)
  };
}
function putTokenEvent(entries, entry) {
  const existing = entries.get(entry.dedupeKey);
  if (!existing || entry.totalTokens > existing.totalTokens) entries.set(entry.dedupeKey, entry);
}
function tokenUsageFromEvents$1(events) {
  const total = emptyTokenUsage$1();
  for (const entry of events) addTokenUsage(total, entry);
  return total;
}
function extractCodexTokenEvents(rows) {
  const entries = /* @__PURE__ */ new Map();
  let currentModel = "";
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const payload = objectField(row, "payload");
    if (row.type === "turn_context") {
      currentModel = stringField(payload, "model") || currentModel;
      continue;
    }
    if (row.type !== "event_msg" || stringField(payload, "type") !== "token_count") continue;
    const info = objectField(payload, "info");
    const usage = objectField(info, "last_token_usage") || objectField(info, "total_token_usage");
    if (!usage) continue;
    const totalUsage = objectField(info, "total_token_usage");
    const rawInput = numberField(usage, "input_tokens");
    const rawOutput = numberField(usage, "output_tokens");
    const cached = numberField(usage, "cached_input_tokens") + numberField(usage, "cache_read_input_tokens");
    const reasoning = numberField(usage, "reasoning_output_tokens");
    const normalizedInput = Math.max(0, rawInput - cached);
    const normalizedOutput = Math.max(0, rawOutput - reasoning);
    const model = stringField(info, "model") || currentModel;
    const totalInput = numberField(totalUsage, "input_tokens");
    const totalOutput = numberField(totalUsage, "output_tokens");
    const key = ["codex", model, normalizedInput, normalizedOutput, cached, reasoning, totalInput, totalOutput].join(":");
    putTokenEvent(entries, tokenEvent(parseTimestampMs(row.timestamp), key, normalizedInput, normalizedOutput, cached, reasoning));
  }
  return [...entries.values()];
}
function extractClaudeTokenEvents(rows) {
  const entries = /* @__PURE__ */ new Map();
  rows.forEach((row, index) => {
    if (!isRecord(row) || row.type !== "assistant") return;
    const message = objectField(row, "message");
    const usage = objectField(message, "usage");
    if (!usage) return;
    const cached = numberField(usage, "cache_read_input_tokens") + numberField(usage, "cached_input_tokens");
    const entry = createTokenUsage(
      numberField(usage, "input_tokens"),
      numberField(usage, "output_tokens"),
      cached,
      numberField(usage, "reasoning_output_tokens")
    );
    const key = stringField(message, "id") || stringField(row, "uuid") || `${index}:${JSON.stringify(usage)}`;
    putTokenEvent(
      entries,
      {
        ...entry,
        timestamp: parseTimestampMs(row.timestamp),
        dedupeKey: key.startsWith("claude-code:") ? key : `claude-code:${key}`
      }
    );
  });
  return [...entries.values()];
}
function firstClaudeGitBranch(rows) {
  for (const row of rows) {
    if (!row || typeof row !== "object" || !("gitBranch" in row)) continue;
    const branch = row.gitBranch?.trim();
    if (branch) return branch;
  }
  return null;
}
function createIndexedSession(input) {
  const stat = safeStat(input.filePath);
  return {
    sessionKey: `${input.keyPrefix}:${input.rawId}`,
    rawId: input.rawId,
    source: input.source,
    projectPath: input.projectPath,
    filePath: input.filePath,
    originalTitle: input.originalTitle || input.firstQuestion || "Untitled Session",
    firstQuestion: input.firstQuestion,
    timestamp: input.timestamp || stat.mtimeMs,
    fileMtimeMs: stat.mtimeMs,
    fileSize: stat.size,
    prUrl: input.prUrl ?? null,
    prNumber: input.prNumber ?? null,
    gitBranch: input.gitBranch ?? null,
    tokenUsage: input.tokenUsage ?? emptyTokenUsage$1()
  };
}
function walkJsonlFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJsonlFiles(fullPath));
    else if (entry.name.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}
function* loadCodexSessionsIterator(codexDir = path.join(os.homedir(), ".codex"), sourceOverride) {
  const sessionsDir = path.join(codexDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;
  const titleMap = /* @__PURE__ */ new Map();
  const indexPath = path.join(codexDir, "session_index.jsonl");
  if (fs.existsSync(indexPath)) {
    for (const row of readJsonl(indexPath)) {
      if (row.id && row.thread_name) titleMap.set(row.id, { title: row.thread_name, updatedAt: row.updated_at || "" });
    }
  }
  for (const filePath of walkJsonlFiles(sessionsDir)) {
    const rows = readJsonl(filePath);
    const meta = rows.length > 0 ? parseCodexSessionMetaLine(rows[0]) : null;
    if (!meta) continue;
    const indexedTitle = titleMap.get(meta.id);
    const messages = extractMessages(rows, "codex");
    const tokenEvents = extractCodexTokenEvents(rows);
    const tokenUsage = tokenUsageFromEvents$1(tokenEvents);
    const question = firstQuestion(messages);
    const source = sourceOverride || (meta.originator === CODEX_APP_ORIGINATOR ? "codex-app" : "codex-cli");
    yield {
      session: createIndexedSession({
        keyPrefix: source === "codex-internal" ? "codex-internal" : "codex",
        rawId: meta.id,
        source,
        projectPath: meta.projectPath,
        filePath,
        originalTitle: indexedTitle?.title || cleanTitle(question) || "Untitled Session",
        firstQuestion: question ? cleanTitle(question) : "",
        timestamp: indexedTitle?.updatedAt ? new Date(indexedTitle.updatedAt).getTime() : meta.ts,
        gitBranch: meta.gitBranch,
        tokenUsage
      }),
      messages,
      tokenEvents
    };
  }
}
function encodeClaudeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}
function* loadClaudeCliSessionsIterator(claudeDir = path.join(os.homedir(), ".claude"), source = "claude-cli") {
  const sessionsDir = path.join(claudeDir, "sessions");
  const projectsDir = path.join(claudeDir, "projects");
  if (!fs.existsSync(projectsDir)) return;
  const index = /* @__PURE__ */ new Map();
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, file), "utf-8"));
        if (parsed.sessionId) index.set(parsed.sessionId, parsed);
      } catch {
      }
    }
  }
  for (const projectDir of fs.readdirSync(projectsDir)) {
    const projectPath = path.join(projectsDir, projectDir);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) continue;
    for (const file of fs.readdirSync(projectPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const rawId = file.replace(/\.jsonl$/, "");
      const filePath = path.join(projectPath, file);
      const rows = readJsonl(filePath);
      const messages = extractMessages(rows, "claude");
      const tokenEvents = extractClaudeTokenEvents(rows);
      const tokenUsage = tokenUsageFromEvents$1(tokenEvents);
      const question = firstQuestion(messages);
      const embeddedCwd = rows.find((row) => row && typeof row === "object" && "cwd" in row)?.cwd;
      const gitBranch = firstClaudeGitBranch(rows);
      yield {
        session: createIndexedSession({
          keyPrefix: source === "claude-internal" ? "claude-internal" : "claude",
          rawId,
          source,
          projectPath: index.get(rawId)?.cwd || embeddedCwd || "",
          filePath,
          originalTitle: cleanTitle(question) || "Untitled Session",
          firstQuestion: cleanTitle(question),
          timestamp: index.get(rawId)?.startedAt || 0,
          gitBranch,
          tokenUsage
        }),
        messages,
        tokenEvents
      };
    }
  }
}
function* loadClaudeAppSessionsIterator(appSessionsDir = path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"), claudeDir = path.join(os.homedir(), ".claude")) {
  if (!fs.existsSync(appSessionsDir)) return;
  const projectsDir = path.join(claudeDir, "projects");
  const metaFiles = [];
  for (const userDir of fs.readdirSync(appSessionsDir)) {
    const userPath = path.join(appSessionsDir, userDir);
    if (!fs.existsSync(userPath) || !fs.statSync(userPath).isDirectory()) continue;
    for (const workspaceDir of fs.readdirSync(userPath)) {
      const workspacePath = path.join(userPath, workspaceDir);
      if (!fs.existsSync(workspacePath) || !fs.statSync(workspacePath).isDirectory()) continue;
      for (const entry of fs.readdirSync(workspacePath)) {
        if (entry.startsWith("local_") && entry.endsWith(".json")) metaFiles.push(path.join(workspacePath, entry));
      }
    }
  }
  for (const metaPath of metaFiles) {
    let appMeta;
    try {
      appMeta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    } catch {
      continue;
    }
    const rawId = appMeta.cliSessionId || appMeta.sessionId;
    const cwd = appMeta.cwd || appMeta.originCwd || "";
    const convoPath = rawId && cwd ? path.join(projectsDir, encodeClaudeProjectDir(cwd), `${rawId}.jsonl`) : metaPath;
    const rows = fs.existsSync(convoPath) ? readJsonl(convoPath) : [];
    const messages = extractMessages(rows, "claude");
    const tokenEvents = extractClaudeTokenEvents(rows);
    const tokenUsage = tokenUsageFromEvents$1(tokenEvents);
    const question = firstQuestion(messages);
    const title = appMeta.title && !/^Session\s+\d+$/i.test(appMeta.title) ? appMeta.title : cleanTitle(question);
    const gitBranch = firstClaudeGitBranch(rows);
    yield {
      session: createIndexedSession({
        keyPrefix: "claude",
        rawId,
        source: "claude-app",
        projectPath: cwd,
        filePath: convoPath,
        originalTitle: title || "Untitled Session",
        firstQuestion: cleanTitle(question),
        timestamp: appMeta.lastActivityAt || appMeta.createdAt || 0,
        prUrl: appMeta.prUrl || null,
        prNumber: appMeta.prNumber || null,
        gitBranch,
        tokenUsage
      }),
      messages,
      tokenEvents
    };
  }
}
function* loadDefaultSessionsIterator(options = {}) {
  yield* loadClaudeCliSessionsIterator();
  yield* loadClaudeAppSessionsIterator();
  yield* loadCodexSessionsIterator();
  if (options.includeClaudeInternal) yield* loadClaudeCliSessionsIterator(path.join(os.homedir(), CLAUDE_INTERNAL_DIR), "claude-internal");
  if (options.includeCodexInternal) yield* loadCodexSessionsIterator(path.join(os.homedir(), CODEX_INTERNAL_DIR), "codex-internal");
}
async function syncLoadedSessionsInBatches(store2, loaded, options = {}) {
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const yieldToEventLoop = options.yieldToEventLoop ?? (() => new Promise((resolve) => setTimeout(resolve, 0)));
  let indexed = 0;
  let total = 0;
  let pendingInBatch = 0;
  for (const item of loaded) {
    store2.upsertIndexedSession(item.session, item.messages, item.tokenEvents);
    indexed++;
    total++;
    pendingInBatch++;
    if (pendingInBatch >= batchSize) {
      pendingInBatch = 0;
      options.onProgress?.({ running: true, indexed, total, lastIndexedAt: null, error: null });
      await yieldToEventLoop();
    }
  }
  if (pendingInBatch > 0 || indexed === 0) {
    options.onProgress?.({ running: true, indexed, total, lastIndexedAt: null, error: null });
    await yieldToEventLoop();
  }
  return {
    running: false,
    indexed,
    total,
    lastIndexedAt: Date.now(),
    error: null
  };
}
function syncDefaultSessionsInBatches(store2, options = {}) {
  return syncLoadedSessionsInBatches(store2, loadDefaultSessionsIterator(options.loadOptions), options);
}
const SOURCE_LABEL = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "claude-internal": "Claude Internal",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
  "codex-internal": "Codex Internal"
};
function formatMessageTime(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(void 0, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function formatSessionMarkdown(session, messages) {
  const title = "displayTitle" in session ? session.displayTitle : session.firstQuestion || session.originalTitle;
  const source = SOURCE_LABEL[session.source] || session.source;
  const header = [
    `# ${title}`,
    "",
    `${source} · \`${session.projectPath}\` · ${new Date(session.timestamp).toLocaleString()} · ${messages.length} messages`,
    "",
    "---",
    ""
  ];
  const body = messages.flatMap((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    const time = formatMessageTime(message.timestamp);
    return [`## ${time ? `${role} (${time})` : role}`, "", message.content, "", "---", ""];
  });
  return [...header, ...body].join("\n");
}
function formatSessionPlainText(session, messages) {
  return formatSessionMarkdown(session, messages).replace(/^#+\s/gm, "");
}
const defaultSettings = {
  defaultTerminal: "Terminal",
  claudeBinary: "claude",
  codexBinary: "codex",
  includeClaudeInternal: false,
  includeCodexInternal: false
};
const ITERM_APPLICATION_NAMES = ["iTerm", "iTerm2"];
function sourceFamily(source) {
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}
function getResumeCommand(session, settings = defaultSettings, opts = {}) {
  const { withCwd = true, skipPermissions = false } = opts;
  let cmd;
  if (sourceFamily(session.source) === "claude") {
    cmd = `${settings.claudeBinary} --resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-skip-permissions";
  } else {
    cmd = `${settings.codexBinary} resume ${session.rawId}`;
    if (skipPermissions) cmd += " --dangerously-bypass-approvals-and-sandbox";
  }
  if (withCwd && session.projectPath) cmd = `cd ${shellQuote(session.projectPath)} && ${cmd}`;
  return cmd;
}
async function openResumeInTerminal(session, settings) {
  const command = getResumeCommand(session, settings, { withCwd: true });
  if (process.platform !== "darwin") {
    await runProcess(settings.defaultTerminal === "WezTerm" ? "wezterm" : "sh", ["-lc", command]);
    return;
  }
  if (settings.defaultTerminal === "iTerm") {
    const appName = await resolveMacApplicationName(ITERM_APPLICATION_NAMES);
    if (!appName) {
      throw new Error("iTerm is not installed or is not registered with macOS. Install iTerm2 or use Resume in Terminal.");
    }
    await runAppleScript(`set wasRunning to application "${escapeAppleScript(appName)}" is running
tell application "${escapeAppleScript(appName)}"
  activate
  if wasRunning then
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window
        create tab with default profile
      end tell
    end if
  else
    delay 0.3
  end if
  tell current session of current window
    write text "${escapeAppleScript(command)}"
  end tell
end tell`);
    return;
  }
  if (settings.defaultTerminal === "Ghostty") {
    await runProcess("/usr/bin/open", ["-na", "Ghostty.app", "--args", `--initial-command=${command}`]);
    return;
  }
  if (settings.defaultTerminal === "WezTerm") {
    const args = ["-na", "WezTerm.app", "--args", "start"];
    if (session.projectPath) args.push("--cwd", session.projectPath);
    args.push("--", process.env.SHELL || "/bin/zsh", "-ic", getResumeCommand(session, settings, { withCwd: false }));
    await runProcess("/usr/bin/open", args);
    return;
  }
  if (settings.defaultTerminal === "Warp") {
    await runProcess("/usr/bin/open", session.projectPath ? ["-a", "Warp", session.projectPath] : ["-a", "Warp"]);
    return;
  }
  await runAppleScript(`tell application "Terminal"
  activate
  do script "${escapeAppleScript(command)}"
end tell`);
}
async function openResumeInSpecificTerminal(session, settings, terminal) {
  await openResumeInTerminal(session, { ...settings, defaultTerminal: terminal });
}
async function resolveMacApplicationName(names, runner = runProcess) {
  for (const name of names) {
    try {
      await runner("/usr/bin/osascript", ["-e", `id of application "${escapeAppleScript(name)}"`]);
      return name;
    } catch {
    }
  }
  return null;
}
async function openNativeApp(source) {
  const appName = sourceFamily(source) === "claude" ? "Claude" : "Codex";
  if (process.platform === "darwin") {
    await runProcess("/usr/bin/open", ["-a", appName]);
  }
}
async function revealInFileManager(targetPath) {
  if (!targetPath) return;
  if (process.platform === "darwin") await runProcess("/usr/bin/open", ["-R", targetPath]);
  else if (process.platform === "win32") await runProcess("explorer.exe", [targetPath]);
  else await runProcess("xdg-open", [targetPath]);
}
function shellQuote(s) {
  if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
function escapeAppleScript(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function runAppleScript(script) {
  return runProcess("/usr/bin/osascript", ["-e", script]);
}
function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
    });
  });
}
const CODEX_USAGE_PRIMARY_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_FALLBACK_URL = "https://chatgpt.com/api/codex/usage";
const HTTP_BODY_LIMIT = 64 * 1024;
const QUOTA_FIVE_HOUR = "five_hour";
const QUOTA_SEVEN_DAY = "seven_day";
const QUOTA_CODE_REVIEW = "code_review";
async function loadUsageQuotaSnapshot(options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const [codex, claudeCode] = await Promise.all([loadCodexQuotaCard({ ...options, now }), Promise.resolve(loadClaudeQuotaCard({ ...options, now }))]);
  return {
    generatedAt: now.toISOString(),
    providers: [codex, claudeCode]
  };
}
async function loadCodexQuotaCard(options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const card = baseQuotaCard("codex", "Codex", "Run `codex login` to show subscription quota.");
  const authPath = firstExistingFile(codexAuthCandidates(options));
  if (!authPath) return card;
  let auth;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8"));
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "auth.json",
      detail: error instanceof SyntaxError ? "auth.json is not valid JSON." : "Could not read auth.json."
    };
  }
  const accessToken = auth.tokens?.access_token?.trim() ?? "";
  const accountId = auth.tokens?.account_id?.trim() ?? "";
  const apiKey = auth.OPENAI_API_KEY?.trim() ?? "";
  if (!accessToken && apiKey) {
    return {
      ...card,
      status: "unsupported_api_key",
      source: "auth.json",
      detail: "Codex is using an API key, so subscription quota is not available."
    };
  }
  if (!accessToken) {
    return {
      ...card,
      status: "not_configured",
      source: "auth.json",
      detail: "auth.json exists but has no OAuth access token. Run `codex login` again."
    };
  }
  const fetcher = options.codexFetcher ?? fetchCodexUsageHTTP;
  try {
    const usage = await fetcher(accessToken, accountId);
    const quotas = codexQuotasFromResponse(usage, now);
    return {
      provider: "codex",
      displayName: "Codex",
      status: "supported",
      source: "chatgpt.com",
      plan: displayPlanName(usage.plan_type),
      quotas,
      detail: quotas.length === 0 ? "Subscription detected, but the quota response did not include limits." : void 0
    };
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "auth.json",
      detail: sanitizeCodexError(error)
    };
  }
}
function loadClaudeQuotaCard(options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const card = baseQuotaCard("claude-code", "Claude Code", "Install a Claude Code statusline bridge that writes ~/.claude/statusline-snapshot.json.");
  const statuslinePath = firstExistingFile(claudeStatuslineCandidates(options));
  if (!statuslinePath) return card;
  let raw;
  try {
    raw = JSON.parse(readFileSync(statuslinePath, "utf8"));
  } catch (error) {
    return {
      ...card,
      status: "error",
      source: "statusline",
      detail: error instanceof SyntaxError ? "Statusline file is not valid JSON." : "Could not read statusline file."
    };
  }
  const quotas = claudeQuotasFromStatusline(raw, now);
  const next = {
    provider: "claude-code",
    displayName: "Claude Code",
    status: quotas.length > 0 ? "supported" : "not_configured",
    source: raw.source?.trim() || "statusline",
    plan: displayPlanName(raw.plan),
    quotas
  };
  if (quotas.length === 0) {
    next.status = looksLikeClaudeApiUsage(raw) ? "unsupported_api_key" : "not_configured";
    next.detail = looksLikeClaudeApiUsage(raw) ? "Claude statusline has API usage data, but no subscription quota." : "Claude statusline file has no quota data.";
  }
  return next;
}
function baseQuotaCard(provider, displayName, detail) {
  return {
    provider,
    displayName,
    status: "not_configured",
    quotas: [],
    detail
  };
}
function codexAuthCandidates(options) {
  const env = options.env ?? process.env;
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return [path__default.join(codexHome, "auth.json")];
  const home = getHomeDir(options);
  return home ? [path__default.join(home, ".codex", "auth.json")] : [];
}
function claudeStatuslineCandidates(options) {
  const env = options.env ?? process.env;
  const home = getHomeDir(options);
  const candidates = [];
  const explicitPath = env.KABOO_CLAUDE_STATUSLINE?.trim();
  if (explicitPath) candidates.push(expandHome(explicitPath, home));
  if (home) {
    candidates.push(
      path__default.join(home, ".claude", "statusline-snapshot.json"),
      path__default.join(home, ".claude", "kaboo-statusline.json"),
      path__default.join(home, ".claude", "anthropic-statusline.json"),
      path__default.join(home, ".local", "share", "kaboo", "claude_statusline.json"),
      path__default.join(home, ".onwatch", "data", "anthropic-statusline.json"),
      path__default.join(home, ".local", "share", "onwatch", "claude_statusline.json")
    );
  }
  return candidates;
}
function firstExistingFile(paths) {
  for (const candidate of paths) {
    if (!candidate) continue;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return null;
}
function getHomeDir(options) {
  return options.homeDir ?? homedir();
}
function expandHome(value, homeDir) {
  if (!value.startsWith("~/")) return value;
  return homeDir ? path__default.join(homeDir, value.slice(2)) : value;
}
function codexQuotasFromResponse(response, now) {
  const quotas = [];
  const primary = response.rate_limit?.primary_window ?? null;
  const secondary = response.rate_limit?.secondary_window ?? null;
  const codeReview = response.code_review_rate_limit?.primary_window ?? null;
  if (primary) quotas.push(quotaFromUsedPercent(QUOTA_FIVE_HOUR, "5h", primary.used_percent, primary.reset_at, now));
  if (secondary) quotas.push(quotaFromUsedPercent(QUOTA_SEVEN_DAY, "7d", secondary.used_percent, secondary.reset_at, now));
  if (codeReview) quotas.push(quotaFromUsedPercent(QUOTA_CODE_REVIEW, "Review", codeReview.used_percent, codeReview.reset_at, now));
  return quotas.filter(Boolean);
}
function claudeQuotasFromStatusline(raw, now) {
  const quotas = [];
  const add = (key, label, used, remaining, resetsAt, stale) => {
    const quota = quotaFromPair(key, label, used, remaining, resetsAt, now, stale);
    if (quota) quotas.push(quota);
  };
  if (raw.quotas && Object.keys(raw.quotas).length > 0) {
    for (const [key, value] of Object.entries(raw.quotas)) {
      if (!value) continue;
      add(key, value.label || quotaLabel(key), value.used_percent, value.remaining_percent, value.resets_at, value.stale);
    }
    return quotas;
  }
  if (raw.rate_limits) {
    const fiveHour = raw.rate_limits.five_hour;
    const sevenDay = raw.rate_limits.seven_day;
    if (fiveHour) {
      add(QUOTA_FIVE_HOUR, "5h", fiveHour.used_percentage, fiveHour.remaining_percentage, unixSecondsToIso(fiveHour.resets_at));
    }
    if (sevenDay) {
      add(QUOTA_SEVEN_DAY, "7d", sevenDay.used_percentage, sevenDay.remaining_percentage, unixSecondsToIso(sevenDay.resets_at));
    }
    return quotas;
  }
  add(QUOTA_FIVE_HOUR, "5h", raw.five_hour_used_percent, raw.five_hour_remaining_percent, raw.five_hour_resets_at);
  add(QUOTA_SEVEN_DAY, "7d", raw.seven_day_used_percent, raw.seven_day_remaining_percent, raw.seven_day_resets_at);
  return quotas;
}
function quotaFromUsedPercent(key, label, usedPercent, resetAtUnix, now) {
  const used = normalizePercent(usedPercent);
  return normalizeQuota({
    key,
    label,
    usedPercent: used,
    remainingPercent: 100 - used,
    resetsAt: unixSecondsToIso(resetAtUnix)
  }, now);
}
function quotaFromPair(key, label, usedPercent, remainingPercent, resetsAt, now, stale) {
  if (!isFiniteNumber(usedPercent) && !isFiniteNumber(remainingPercent)) return null;
  const used = isFiniteNumber(usedPercent) ? normalizePercent(usedPercent) : normalizePercent(100 - Number(remainingPercent));
  const remaining = isFiniteNumber(remainingPercent) ? normalizePercent(remainingPercent) : normalizePercent(100 - used);
  return normalizeQuota({ key, label, usedPercent: used, remainingPercent: remaining, resetsAt, stale }, now);
}
function normalizeQuota(quota, now) {
  const usedPercent = normalizePercent(quota.usedPercent);
  const remainingPercent = normalizePercent(quota.remainingPercent);
  const resetsAt = quota.resetsAt?.trim() || void 0;
  return {
    ...quota,
    usedPercent,
    remainingPercent,
    usedDisplay: `${Math.round(usedPercent)}%`,
    remainingDisplay: `${Math.round(remainingPercent)}%`,
    resetsAt,
    stale: quota.stale ?? isResetStale(resetsAt, now)
  };
}
function normalizePercent(value) {
  if (!isFiniteNumber(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function unixSecondsToIso(value) {
  if (!isFiniteNumber(value) || value <= 0) return void 0;
  return new Date(value * 1e3).toISOString();
}
function isResetStale(resetsAt, now) {
  if (!resetsAt) return false;
  const resetTime = Date.parse(resetsAt);
  return Number.isFinite(resetTime) ? now.getTime() > resetTime + 6e4 : false;
}
function quotaLabel(key) {
  if (key === QUOTA_FIVE_HOUR) return "5h";
  if (key === QUOTA_SEVEN_DAY) return "7d";
  if (key === QUOTA_CODE_REVIEW) return "Review";
  return key;
}
async function fetchCodexUsageHTTP(accessToken, accountId) {
  try {
    return await doCodexUsageRequest(CODEX_USAGE_PRIMARY_URL, accessToken, accountId);
  } catch (error) {
    if (error instanceof CodexHttpError && error.statusCode === 404) {
      return doCodexUsageRequest(CODEX_USAGE_FALLBACK_URL, accessToken, accountId);
    }
    throw error;
  }
}
class CodexHttpError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.name = "CodexHttpError";
  }
}
function doCodexUsageRequest(endpoint, accessToken, accountId) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "agent-session-search"
    };
    if (accountId) {
      headers["X-Account-Id"] = accountId;
      headers["ChatClaude-Account-Id"] = accountId;
      headers["ChatGPT-Account-Id"] = accountId;
    }
    const request = https.request(endpoint, { method: "GET", headers, timeout: 8e3 }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > HTTP_BODY_LIMIT) {
          request.destroy(new Error("Codex usage response is too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (statusCode !== 200) {
          reject(new CodexHttpError(codexHttpStatusMessage(statusCode), statusCode));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error instanceof Error ? new Error(`Invalid Codex usage response: ${error.message}`) : error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Codex quota refresh timed out.")));
    request.on("error", reject);
    request.end();
  });
}
function codexHttpStatusMessage(statusCode) {
  if (statusCode === 401) return "Unauthorized. Run `codex login` again.";
  if (statusCode === 403) return "Codex quota endpoint returned forbidden.";
  if (statusCode === 404) return "Codex quota endpoint returned 404.";
  if (statusCode === 429) return "Codex quota refresh was rate limited.";
  return `Codex quota endpoint returned HTTP ${statusCode}.`;
}
function sanitizeCodexError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer [redacted]").replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]");
}
function looksLikeClaudeApiUsage(raw) {
  return Boolean(raw.model || raw.cost || raw.context_window || raw.session_id?.trim());
}
function displayPlanName(value) {
  const key = value?.trim().toLowerCase().replace(/[\s_-]/g, "");
  if (!key) return void 0;
  switch (key) {
    case "plus":
      return "Plus";
    case "pro":
    case "prolite":
      return "Pro";
    case "max":
      return "Max";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    case "free":
      return "Free";
    default:
      return void 0;
  }
}
const require$1 = createRequire(import.meta.url);
const { DatabaseSync } = require$1("node:sqlite");
class SessionStore {
  db;
  constructor(dbPathOrInstance) {
    this.db = typeof dbPathOrInstance === "string" ? new DatabaseSync(dbPathOrInstance) : dbPathOrInstance;
    this.migrate();
  }
  close() {
    this.db.close();
  }
  transaction(run) {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  upsertIndexedSession(session, messages, tokenEvents = []) {
    const normalizedTokenEvents = tokenEvents.map(normalizeTokenEvent).filter((event) => event.totalTokens > 0 && event.dedupeKey);
    const tokenUsage = normalizedTokenEvents.length > 0 ? tokenUsageFromEvents(normalizedTokenEvents) : normalizeTokenUsage(session.tokenUsage);
    this.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO sessions (
            session_key, raw_id, source, project_path, file_path, original_title, first_question,
            timestamp, file_mtime_ms, file_size, pr_url, pr_number, message_count,
            input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens, total_tokens
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET
            raw_id = excluded.raw_id,
            source = excluded.source,
            project_path = excluded.project_path,
            file_path = excluded.file_path,
            original_title = excluded.original_title,
            first_question = excluded.first_question,
            timestamp = excluded.timestamp,
            file_mtime_ms = excluded.file_mtime_ms,
            file_size = excluded.file_size,
            pr_url = excluded.pr_url,
            pr_number = excluded.pr_number,
            message_count = excluded.message_count,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            cached_input_tokens = excluded.cached_input_tokens,
            reasoning_output_tokens = excluded.reasoning_output_tokens,
            total_tokens = excluded.total_tokens
        `
      ).run(
        session.sessionKey,
        session.rawId,
        session.source,
        session.projectPath,
        session.filePath,
        session.originalTitle,
        session.firstQuestion,
        session.timestamp,
        session.fileMtimeMs,
        session.fileSize,
        session.prUrl,
        session.prNumber,
        messages.length,
        tokenUsage.inputTokens,
        tokenUsage.outputTokens,
        tokenUsage.cachedInputTokens,
        tokenUsage.reasoningOutputTokens,
        tokenUsage.totalTokens
      );
      this.db.prepare("DELETE FROM messages WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM token_events WHERE session_key = ?").run(session.sessionKey);
      this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(session.sessionKey);
      const insertMessage = this.db.prepare(
        "INSERT INTO messages (session_key, message_index, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
      );
      for (const message of messages) {
        insertMessage.run(session.sessionKey, message.index, message.role, message.content, message.timestamp);
      }
      const insertTokenEvent = this.db.prepare(
        `
        INSERT INTO token_events (
          session_key, dedupe_key, timestamp, input_tokens, output_tokens,
          cached_input_tokens, reasoning_output_tokens, total_tokens
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      );
      for (const event of normalizedTokenEvents) {
        insertTokenEvent.run(
          session.sessionKey,
          event.dedupeKey,
          event.timestamp,
          event.inputTokens,
          event.outputTokens,
          event.cachedInputTokens,
          event.reasoningOutputTokens,
          event.totalTokens
        );
      }
      this.refreshFtsForSession(session.sessionKey);
      const branchTag = branchTagName(session.gitBranch);
      if (branchTag) this.addTagToSession(session.sessionKey, branchTag);
    });
  }
  setCustomTitle(sessionKey, title) {
    const normalized = title?.trim() || null;
    this.db.prepare("UPDATE sessions SET custom_title = ? WHERE session_key = ?").run(normalized, sessionKey);
    this.refreshFtsForSession(sessionKey);
  }
  setPinned(sessionKey, pinned) {
    this.db.prepare("UPDATE sessions SET pinned = ? WHERE session_key = ?").run(pinned ? 1 : 0, sessionKey);
  }
  setFavorited(sessionKey, favorited) {
    this.db.prepare("UPDATE sessions SET favorited = ? WHERE session_key = ?").run(favorited ? 1 : 0, sessionKey);
  }
  setHidden(sessionKey, hidden) {
    this.db.prepare("UPDATE sessions SET hidden = ? WHERE session_key = ?").run(hidden ? 1 : 0, sessionKey);
  }
  markOpened(sessionKey) {
    this.db.prepare("UPDATE sessions SET last_opened_at = ? WHERE session_key = ?").run(Date.now(), sessionKey);
  }
  markResumed(sessionKey) {
    this.db.prepare("UPDATE sessions SET last_resumed_at = ? WHERE session_key = ?").run(Date.now(), sessionKey);
  }
  addTag(sessionKey, tagName) {
    const name = tagName.trim();
    if (!name) return;
    this.transaction(() => {
      this.addTagToSession(sessionKey, name);
    });
  }
  removeTag(sessionKey, tagName) {
    this.transaction(() => {
      this.db.prepare(
        `
          DELETE FROM session_tags
          WHERE session_key = ?
            AND tag_id = (SELECT id FROM tags WHERE name = ?)
        `
      ).run(sessionKey, tagName);
      this.deleteUnusedTag(tagName);
    });
  }
  deleteTag(tagName) {
    this.db.prepare("DELETE FROM tags WHERE name = ?").run(tagName.trim());
  }
  listTags() {
    return this.db.prepare("SELECT name FROM tags ORDER BY lower(name)").all().map(
      (row) => row.name
    );
  }
  listProjects() {
    const rows = this.db.prepare(
      `
        SELECT project_path, COUNT(*) AS session_count
        FROM sessions
        WHERE trim(project_path) != ''
        GROUP BY project_path
      `
    ).all();
    const summaries = rows.map((row) => ({
      path: row.project_path,
      label: projectLabel(row.project_path),
      sessionCount: row.session_count
    }));
    const basenameCounts = /* @__PURE__ */ new Map();
    for (const summary of summaries) {
      const basename = projectBasename(summary.path);
      basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
    }
    return summaries.map((summary) => ({
      ...summary,
      label: (basenameCounts.get(projectBasename(summary.path)) || 0) > 1 ? projectParentLabel(summary.path) : summary.label
    })).sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));
  }
  getSession(sessionKey) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey);
    return row ? this.hydrateRow(row, null) : null;
  }
  getMessages(sessionKey, offset = 0, limit = 120) {
    return this.db.prepare(
      `
          SELECT message_index, role, content, timestamp
          FROM messages
          WHERE session_key = ?
          ORDER BY message_index
          LIMIT ? OFFSET ?
        `
    ).all(sessionKey, limit, offset).map((row) => ({ index: row.message_index, role: row.role, content: row.content, timestamp: row.timestamp }));
  }
  getAllMessages(sessionKey) {
    return this.getMessages(sessionKey, 0, 1e5);
  }
  getStats(options = {}, now = Date.now()) {
    const range = resolveStatsRange(options, now);
    const summariesBySource = /* @__PURE__ */ new Map();
    for (const row of this.aggregateActiveSessionsBySource(range)) {
      summaryForSource(summariesBySource, row.source).sessionCount = row.session_count;
    }
    for (const row of this.aggregateMessagesBySource(range)) {
      summaryForSource(summariesBySource, row.source).messageCount = row.message_count;
    }
    const tokenRows = this.aggregateTokenEventsBySource(range);
    const tokenSourceRows = range.since === null && tokenRows.length === 0 ? this.aggregateSessionTokensBySource() : tokenRows;
    for (const row of tokenSourceRows) {
      const summary = summaryForSource(summariesBySource, row.source);
      summary.inputTokens = row.input_tokens;
      summary.outputTokens = row.output_tokens;
      summary.cachedInputTokens = row.cached_input_tokens;
      summary.reasoningOutputTokens = row.reasoning_output_tokens;
      summary.totalTokens = row.total_tokens;
    }
    const bySource = [...summariesBySource.entries()].map(([source, summary]) => ({ source, ...summary })).filter((summary) => summary.sessionCount > 0 || summary.messageCount > 0 || summary.totalTokens > 0).sort((a, b) => a.source.localeCompare(b.source));
    const total = bySource.reduce(
      (acc, row) => ({
        sessionCount: acc.sessionCount + row.sessionCount,
        messageCount: acc.messageCount + row.messageCount,
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        cachedInputTokens: acc.cachedInputTokens + row.cachedInputTokens,
        reasoningOutputTokens: acc.reasoningOutputTokens + row.reasoningOutputTokens,
        totalTokens: acc.totalTokens + row.totalTokens
      }),
      emptyStatsSummary()
    );
    return {
      total,
      bySource,
      range
    };
  }
  searchSessions(options = {}) {
    const limit = options.limit ?? 200;
    const query = options.query?.trim() || "";
    const ftsMatches = query ? this.searchFts(query) : /* @__PURE__ */ new Map();
    const rows = this.getCandidateRows(options);
    const tagsBySession = this.getTagsForSessions(rows.map((row) => row.session_key));
    const merged = /* @__PURE__ */ new Map();
    for (const row of rows) {
      const hasFtsMatch = ftsMatches.has(row.session_key);
      const ftsSnippet = hasFtsMatch ? ftsMatches.get(row.session_key) ?? null : null;
      const hydrated = this.hydrateRow(row, query ? ftsSnippet : null, tagsBySession.get(row.session_key) ?? []);
      if (query && !hasFtsMatch && !this.matchesTextFields(hydrated, query)) {
        const snippet = this.findSnippet(row.session_key, query);
        if (!snippet) continue;
        hydrated.matchSnippet = snippet;
      }
      merged.set(hydrated.sessionKey, hydrated);
    }
    return [...merged.values()].sort((a, b) => this.score(b, query) - this.score(a, query) || this.sortValue(b, options.sortBy) - this.sortValue(a, options.sortBy)).slice(0, limit);
  }
  clearSearchIndex() {
    this.transaction(() => {
      this.db.prepare("DELETE FROM messages").run();
      this.db.prepare("DELETE FROM token_events").run();
      this.db.prepare("DELETE FROM session_fts").run();
      this.db.prepare(
        `
          UPDATE sessions
          SET file_mtime_ms = 0,
            file_size = 0,
            message_count = 0,
            input_tokens = 0,
            output_tokens = 0,
            cached_input_tokens = 0,
            reasoning_output_tokens = 0,
            total_tokens = 0,
            original_title = '',
            first_question = ''
        `
      ).run();
    });
  }
  deleteSessionsBySource(sources) {
    if (sources.length === 0) return;
    const placeholders = sources.map(() => "?").join(", ");
    this.transaction(() => {
      this.db.prepare(`DELETE FROM session_fts WHERE session_key IN (SELECT session_key FROM sessions WHERE source IN (${placeholders}))`).run(...sources);
      this.db.prepare(`DELETE FROM sessions WHERE source IN (${placeholders})`).run(...sources);
      this.deleteUnusedTags();
    });
  }
  migrate() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        raw_id TEXT NOT NULL,
        source TEXT NOT NULL,
        project_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_title TEXT NOT NULL,
        first_question TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        file_mtime_ms REAL NOT NULL,
        file_size INTEGER NOT NULL,
        pr_url TEXT,
        pr_number INTEGER,
        custom_title TEXT,
        favorited INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        last_opened_at INTEGER,
        last_resumed_at INTEGER,
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        session_key TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (session_key, message_index),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS token_events (
        session_key TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_key, dedupe_key),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS session_tags (
        session_key TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (session_key, tag_id),
        FOREIGN KEY (session_key) REFERENCES sessions(session_key) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
        session_key UNINDEXED,
        title,
        first_question,
        content_text,
        project_path,
        tokenize = 'unicode61'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_hidden_favorited_pinned
        ON sessions(hidden, favorited, pinned);
      CREATE INDEX IF NOT EXISTS idx_sessions_source
        ON sessions(source);
      CREATE INDEX IF NOT EXISTS idx_sessions_project_path
        ON sessions(project_path);
      CREATE INDEX IF NOT EXISTS idx_session_tags_tag_session
        ON session_tags(tag_id, session_key);
      CREATE INDEX IF NOT EXISTS idx_token_events_timestamp
        ON token_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_token_events_dedupe
        ON token_events(dedupe_key, total_tokens, timestamp);
    `);
    this.addColumnIfMissing("sessions", "favorited", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "reasoning_output_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("sessions", "total_tokens", "INTEGER NOT NULL DEFAULT 0");
  }
  addColumnIfMissing(tableName, columnName, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!columns.some((column) => column.name === columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }
  refreshFtsForSession(sessionKey) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE session_key = ?").get(sessionKey);
    if (!row) return;
    const contentText = this.db.prepare("SELECT content FROM messages WHERE session_key = ? ORDER BY message_index").all(
      sessionKey
    ).map((message) => message.content).join("\n\n");
    const title = row.custom_title || row.first_question || row.original_title || "Untitled Session";
    this.db.prepare("DELETE FROM session_fts WHERE session_key = ?").run(sessionKey);
    this.db.prepare(
      "INSERT INTO session_fts (session_key, title, first_question, content_text, project_path) VALUES (?, ?, ?, ?, ?)"
    ).run(sessionKey, title, row.first_question, contentText, row.project_path);
  }
  deleteUnusedTag(tagName) {
    this.db.prepare(
      `
        DELETE FROM tags
        WHERE name = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_tags
            WHERE session_tags.tag_id = tags.id
          )
      `
    ).run(tagName);
  }
  deleteUnusedTags() {
    this.db.prepare(
      `
        DELETE FROM tags
        WHERE NOT EXISTS (
          SELECT 1
          FROM session_tags
          WHERE session_tags.tag_id = tags.id
        )
      `
    ).run();
  }
  addTagToSession(sessionKey, tagName) {
    const name = tagName.trim();
    if (!name) return;
    this.db.prepare("INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING").run(name);
    const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name);
    this.db.prepare("INSERT INTO session_tags (session_key, tag_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(sessionKey, tag.id);
  }
  aggregateActiveSessionsBySource(range) {
    if (range.since === null) {
      return this.db.prepare(
        `
          SELECT source, COUNT(*) AS session_count
          FROM sessions
          GROUP BY source
          ORDER BY source
        `
      ).all();
    }
    const messageTimestampMs = "CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000";
    return this.db.prepare(
      `
        WITH active AS (
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN messages ON messages.session_key = sessions.session_key
          WHERE ${messageTimestampMs} >= ? AND ${messageTimestampMs} <= ?
          UNION
          SELECT sessions.source AS source, sessions.session_key AS session_key
          FROM sessions
          JOIN token_events ON token_events.session_key = sessions.session_key
          WHERE token_events.timestamp >= ? AND token_events.timestamp <= ?
        )
        SELECT source, COUNT(DISTINCT session_key) AS session_count
        FROM active
        GROUP BY source
        ORDER BY source
      `
    ).all(range.since, range.until, range.since, range.until);
  }
  aggregateMessagesBySource(range) {
    if (range.since === null) {
      return this.db.prepare(
        `
          SELECT source, COALESCE(SUM(message_count), 0) AS message_count
          FROM sessions
          GROUP BY source
          ORDER BY source
        `
      ).all();
    }
    const messageTimestampMs = "CAST(strftime('%s', messages.timestamp) AS INTEGER) * 1000";
    return this.db.prepare(
      `
        SELECT sessions.source AS source, COUNT(*) AS message_count
        FROM messages
        JOIN sessions ON sessions.session_key = messages.session_key
        WHERE ${messageTimestampMs} >= ? AND ${messageTimestampMs} <= ?
        GROUP BY sessions.source
        ORDER BY sessions.source
      `
    ).all(range.since, range.until);
  }
  aggregateTokenEventsBySource(range) {
    const whereClause = range.since === null ? "" : "WHERE timestamp >= ? AND timestamp <= ?";
    const args = range.since === null ? [] : [range.since, range.until];
    return this.db.prepare(
      `
        WITH ranked AS (
          SELECT
            sessions.source AS source,
            token_events.dedupe_key AS dedupe_key,
            token_events.timestamp AS timestamp,
            token_events.input_tokens AS input_tokens,
            token_events.output_tokens AS output_tokens,
            token_events.cached_input_tokens AS cached_input_tokens,
            token_events.reasoning_output_tokens AS reasoning_output_tokens,
            token_events.total_tokens AS total_tokens,
            ROW_NUMBER() OVER (
              PARTITION BY token_events.dedupe_key
              ORDER BY
                token_events.total_tokens DESC,
                CASE sessions.source
                  WHEN 'codex-cli' THEN 1
                  WHEN 'claude-cli' THEN 1
                  WHEN 'codex-app' THEN 2
                  WHEN 'claude-app' THEN 2
                  ELSE 9
                END,
                token_events.timestamp ASC
            ) AS row_rank
          FROM token_events
          JOIN sessions ON sessions.session_key = token_events.session_key
        ),
        deduped AS (
          SELECT
            source,
            dedupe_key,
            timestamp,
            input_tokens,
            output_tokens,
            cached_input_tokens,
            reasoning_output_tokens,
            total_tokens
          FROM ranked
          WHERE row_rank = 1
        )
        SELECT
          source,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM deduped
        ${whereClause}
        GROUP BY source
        ORDER BY source
      `
    ).all(...args);
  }
  aggregateSessionTokensBySource() {
    return this.db.prepare(
      `
        SELECT
          source,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
          COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
          COALESCE(SUM(total_tokens), 0) AS total_tokens
        FROM sessions
        GROUP BY source
        ORDER BY source
      `
    ).all();
  }
  getCandidateRows(options) {
    const where = [];
    const args = [];
    if (options.visibility === "hidden") where.push("hidden = 1");
    else if (options.visibility === "favorites") where.push("hidden = 0 AND favorited = 1");
    else if (options.visibility === "pinned") where.push("hidden = 0 AND pinned = 1");
    else where.push("hidden = 0");
    if (options.projectPath) {
      where.push("project_path = ?");
      args.push(options.projectPath);
    }
    if (options.source && options.source !== "all") {
      if (options.source === "claude") {
        where.push("source IN ('claude-cli', 'claude-app')");
      } else if (options.source === "codex") {
        where.push("source IN ('codex-cli', 'codex-app')");
      } else {
        where.push("source = ?");
        args.push(options.source);
      }
    }
    if (options.tag) {
      where.push(
        `
        EXISTS (
          SELECT 1
          FROM session_tags
          JOIN tags ON tags.id = session_tags.tag_id
          WHERE session_tags.session_key = sessions.session_key
            AND tags.name = ?
        )
      `
      );
      args.push(options.tag);
    }
    return this.db.prepare(`SELECT * FROM sessions WHERE ${where.join(" AND ")}`).all(...args);
  }
  matchesTextFields(result, query) {
    const lower = query.toLowerCase();
    if (result.displayTitle.toLowerCase().includes(lower)) return true;
    if (result.originalTitle.toLowerCase().includes(lower)) return true;
    if (result.firstQuestion.toLowerCase().includes(lower)) return true;
    if (result.projectPath.toLowerCase().includes(lower)) return true;
    if (result.rawId.toLowerCase().includes(lower)) return true;
    return false;
  }
  findSnippet(sessionKey, query) {
    const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
    const row = this.db.prepare(
      `
        SELECT content
        FROM messages
        WHERE session_key = ? AND lower(content) LIKE lower(?) ESCAPE '\\'
        ORDER BY message_index
        LIMIT 1
      `
    ).get(sessionKey, like);
    if (!row) return null;
    const content = row.content.replace(/\s+/g, " ");
    const idx = content.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return content.slice(0, 180);
    const start = Math.max(0, idx - 60);
    const end = Math.min(content.length, idx + query.length + 80);
    return `${start > 0 ? "..." : ""}${content.slice(start, end)}${end < content.length ? "..." : ""}`;
  }
  searchFts(query) {
    const expression = buildFtsQuery(query);
    if (!expression) return /* @__PURE__ */ new Map();
    try {
      const rows = this.db.prepare(
        `
          SELECT session_key, snippet(session_fts, 3, '', '', '...', 18) AS snippet
          FROM session_fts
          WHERE session_fts MATCH ?
        `
      ).all(expression);
      return new Map(rows.map((row) => [row.session_key, row.snippet]));
    } catch {
      return /* @__PURE__ */ new Map();
    }
  }
  getTagsForSession(sessionKey) {
    return this.db.prepare(
      `
          SELECT tags.name
          FROM tags
          JOIN session_tags ON session_tags.tag_id = tags.id
          WHERE session_tags.session_key = ?
          ORDER BY lower(tags.name)
        `
    ).all(sessionKey).map((tag) => tag.name);
  }
  getTagsForSessions(sessionKeys) {
    const tagsBySession = /* @__PURE__ */ new Map();
    if (sessionKeys.length === 0) return tagsBySession;
    const shouldFilterBySession = sessionKeys.length <= 900;
    const placeholders = shouldFilterBySession ? sessionKeys.map(() => "?").join(",") : "";
    const rows = this.db.prepare(
      `
        SELECT session_tags.session_key, tags.name
        FROM session_tags
        JOIN tags ON tags.id = session_tags.tag_id
        ${shouldFilterBySession ? `WHERE session_tags.session_key IN (${placeholders})` : ""}
        ORDER BY session_tags.session_key, lower(tags.name)
      `
    ).all(...shouldFilterBySession ? sessionKeys : []);
    const allowed = shouldFilterBySession ? null : new Set(sessionKeys);
    for (const row of rows) {
      if (allowed && !allowed.has(row.session_key)) continue;
      const tags = tagsBySession.get(row.session_key) ?? [];
      tags.push(row.name);
      tagsBySession.set(row.session_key, tags);
    }
    return tagsBySession;
  }
  hydrateRow(row, snippet, tags = this.getTagsForSession(row.session_key)) {
    const displayTitle = row.custom_title || row.first_question || row.original_title || "Untitled Session";
    return {
      sessionKey: row.session_key,
      rawId: row.raw_id,
      source: row.source,
      projectPath: row.project_path,
      filePath: row.file_path,
      originalTitle: row.original_title,
      firstQuestion: row.first_question,
      timestamp: row.timestamp,
      fileMtimeMs: row.file_mtime_ms,
      fileSize: row.file_size,
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      tokenUsage: {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cachedInputTokens: row.cached_input_tokens,
        reasoningOutputTokens: row.reasoning_output_tokens,
        totalTokens: row.total_tokens
      },
      customTitle: row.custom_title,
      displayTitle,
      favorited: row.favorited === 1,
      pinned: row.pinned === 1,
      hidden: row.hidden === 1,
      tags,
      matchSnippet: snippet,
      lastOpenedAt: row.last_opened_at,
      lastResumedAt: row.last_resumed_at,
      messageCount: row.message_count
    };
  }
  score(result, query) {
    if (!query) return result.pinned ? 1e12 : 0;
    const q = query.toLowerCase();
    const title = result.displayTitle.toLowerCase();
    let score = 0;
    if (title === q) score += 1e3;
    else if (title.startsWith(q)) score += 700;
    else if (title.includes(q)) score += 500;
    if (result.firstQuestion.toLowerCase().includes(q)) score += 300;
    if (result.matchSnippet) score += 120;
    if (result.projectPath.toLowerCase().includes(q) || result.rawId.toLowerCase().includes(q)) score += 50;
    if (result.pinned) score += 25;
    return score;
  }
  sortValue(result, sortBy = "created") {
    if (sortBy === "created") return result.timestamp || 0;
    if (sortBy === "updated") return result.fileMtimeMs || result.timestamp || 0;
    return Math.max(result.lastResumedAt || 0, result.fileMtimeMs || 0, result.timestamp || 0);
  }
}
function emptyStatsSummary() {
  return {
    sessionCount: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}
function summaryForSource(summariesBySource, source) {
  const existing = summariesBySource.get(source);
  if (existing) return existing;
  const summary = emptyStatsSummary();
  summariesBySource.set(source, summary);
  return summary;
}
function emptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}
function normalizeTokenUsage(tokenUsage) {
  const inputTokens = nonNegativeNumber(tokenUsage?.inputTokens);
  const outputTokens = nonNegativeNumber(tokenUsage?.outputTokens);
  const cachedInputTokens = nonNegativeNumber(tokenUsage?.cachedInputTokens);
  const reasoningOutputTokens = nonNegativeNumber(tokenUsage?.reasoningOutputTokens);
  const derivedTotal = inputTokens + outputTokens + cachedInputTokens + reasoningOutputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    totalTokens: nonNegativeNumber(tokenUsage?.totalTokens) || derivedTotal
  };
}
function normalizeTokenEvent(event) {
  return {
    ...normalizeTokenUsage(event),
    timestamp: nonNegativeNumber(event.timestamp),
    dedupeKey: event.dedupeKey.trim()
  };
}
function tokenUsageFromEvents(events) {
  return events.reduce(
    (acc, event) => ({
      inputTokens: acc.inputTokens + event.inputTokens,
      outputTokens: acc.outputTokens + event.outputTokens,
      cachedInputTokens: acc.cachedInputTokens + event.cachedInputTokens,
      reasoningOutputTokens: acc.reasoningOutputTokens + event.reasoningOutputTokens,
      totalTokens: acc.totalTokens + event.totalTokens
    }),
    emptyTokenUsage()
  );
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
function resolveStatsRange(options, now) {
  const period = options.period ?? "today";
  if (period === "allTime") return { period, since: null, until: now };
  if (period === "today") return { period, since: startOfLocalDay(now), until: now };
  if (period === "thirtyDay") return { period, since: now - 30 * 24 * 60 * 60 * 1e3, until: now };
  return { period: "sevenDay", since: now - 7 * 24 * 60 * 60 * 1e3, until: now };
}
function startOfLocalDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
function buildFtsQuery(query) {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((token) => token.replace(/"/g, "")).filter(Boolean).map((token) => `${token}*`).join(" ");
}
function branchTagName(branch) {
  const normalized = branch?.trim();
  return normalized ? `branch:${normalized}` : null;
}
function projectParts(projectPath) {
  return projectPath.split(/[\\/]+/).filter(Boolean);
}
function projectBasename(projectPath) {
  const parts = projectParts(projectPath);
  return parts.at(-1) || projectPath;
}
function projectLabel(projectPath) {
  return projectBasename(projectPath) || projectPath;
}
function projectParentLabel(projectPath) {
  const parts = projectParts(projectPath);
  if (parts.length >= 2) return `${parts.at(-2)}/${parts.at(-1)}`;
  return projectLabel(projectPath);
}
const INITIAL_INDEX_DELAY_MS = 750;
const AUTO_INDEX_REFRESH_INTERVAL_MS = 10 * 60 * 1e3;
const __dirname$1 = path.dirname(fileURLToPath(import.meta.url));
const PRODUCT_NAME = "Agent-Session-Search";
app.setName(PRODUCT_NAME);
app.setAppUserModelId("dev.zszz3.agent-session-search");
let mainWindow = null;
let tray = null;
let store;
let indexStatus = { running: false, indexed: 0, total: 0, lastIndexedAt: null, error: null };
let activeIndexRun = null;
let autoIndexTimer = null;
const settingsStore = new Store({
  defaults: defaultSettings
});
function getSettings() {
  return { ...defaultSettings, ...settingsStore.store };
}
function getPreferredWindowBounds() {
  const defaultWidth = 1120;
  const defaultHeight = 760;
  const cursorPoint = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint);
  const width = Math.min(defaultWidth, workArea.width);
  const height = Math.min(defaultHeight, workArea.height);
  return {
    width,
    height,
    x: Math.round(workArea.x + Math.max(0, workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - height) / 2)
  };
}
function createWindow() {
  const preloadPath = path.join(__dirname$1, "../preload/index.mjs");
  const initialBounds = getPreferredWindowBounds();
  mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 860,
    minHeight: 560,
    title: PRODUCT_NAME,
    show: false,
    ...process.platform === "darwin" ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 14 } } : {},
    backgroundColor: "#0a0b0d",
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
  });
  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error("[renderer]", message, `${sourceId}:${line}`);
    else console.log("[renderer]", message);
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname$1, "../renderer/index.html"));
  }
}
function toggleWindow() {
  if (!mainWindow) createWindow();
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else {
    mainWindow.setBounds(getPreferredWindowBounds(), false);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("focus-search");
  }
}
function createTray() {
  const image = nativeImage.createFromDataURL(
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 18 18'><rect x='2' y='3' width='14' height='12' rx='2' fill='black'/><rect x='4' y='5' width='10' height='1.5' fill='white'/><rect x='4' y='8' width='7' height='1.5' fill='white'/><rect x='4' y='11' width='4' height='1.5' fill='white'/></svg>"
  );
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PRODUCT_NAME}`, click: toggleWindow },
      { label: "Refresh Now", click: () => void runIndexSync() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ])
  );
}
function createApplicationMenu() {
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME });
  const appMenu = process.platform === "darwin" ? [
    {
      label: PRODUCT_NAME,
      submenu: [
        { label: `About ${PRODUCT_NAME}`, role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { label: `Hide ${PRODUCT_NAME}`, accelerator: "Command+H", role: "hide" },
        { label: "Hide Others", accelerator: "Command+Alt+H", role: "hideOthers" },
        { label: "Show All", role: "unhide" },
        { type: "separator" },
        { label: `Quit ${PRODUCT_NAME}`, accelerator: "Command+Q", click: () => app.quit() }
      ]
    }
  ] : [];
  const template = [
    ...appMenu,
    {
      label: "File",
      submenu: [process.platform === "darwin" ? { role: "close" } : { label: "Quit", role: "quit" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Refresh Now", accelerator: "CmdOrCtrl+R", click: () => void runIndexSync() },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: process.platform === "darwin" ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }, { role: "close" }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function runIndexSync() {
  if (activeIndexRun) return activeIndexRun;
  indexStatus = { ...indexStatus, running: true, error: null };
  mainWindow?.webContents.send("index-status", indexStatus);
  activeIndexRun = syncDefaultSessionsInBatches(store, {
    batchSize: 2,
    loadOptions: {
      includeClaudeInternal: getSettings().includeClaudeInternal,
      includeCodexInternal: getSettings().includeCodexInternal
    },
    onProgress: (status) => {
      indexStatus = { ...status, lastIndexedAt: indexStatus.lastIndexedAt };
      mainWindow?.webContents.send("index-status", indexStatus);
    }
  }).then((status) => {
    indexStatus = status;
    mainWindow?.webContents.send("index-status", indexStatus);
    return indexStatus;
  }).catch((error) => {
    indexStatus = {
      running: false,
      indexed: 0,
      total: 0,
      lastIndexedAt: indexStatus.lastIndexedAt,
      error: String(error)
    };
    mainWindow?.webContents.send("index-status", indexStatus);
    return indexStatus;
  }).finally(() => {
    activeIndexRun = null;
  });
  return activeIndexRun;
}
function startAutoIndexRefresh() {
  if (autoIndexTimer) return;
  autoIndexTimer = setInterval(() => {
    void runIndexSync();
  }, AUTO_INDEX_REFRESH_INTERVAL_MS);
}
function stopAutoIndexRefresh() {
  if (!autoIndexTimer) return;
  clearInterval(autoIndexTimer);
  autoIndexTimer = null;
}
function registerIpc() {
  ipcMain.handle("search:sessions", (_event, options) => store.searchSessions(options));
  ipcMain.handle("session:get", (_event, sessionKey) => {
    store.markOpened(sessionKey);
    return store.getSession(sessionKey);
  });
  ipcMain.handle(
    "session:messages",
    (_event, sessionKey, offset, limit) => store.getMessages(sessionKey, offset ?? 0, limit ?? 120)
  );
  ipcMain.handle("stats:get", (_event, options) => store.getStats(options));
  ipcMain.handle("quota:get", () => loadUsageQuotaSnapshot());
  ipcMain.handle("tags:list", () => store.listTags());
  ipcMain.handle("projects:list", () => store.listProjects());
  ipcMain.handle("title:set", (_event, sessionKey, title) => store.setCustomTitle(sessionKey, title));
  ipcMain.handle("tag:add", (_event, sessionKey, tagName) => store.addTag(sessionKey, tagName));
  ipcMain.handle("tag:remove", (_event, sessionKey, tagName) => store.removeTag(sessionKey, tagName));
  ipcMain.handle("tag:delete", (_event, tagName) => store.deleteTag(tagName));
  ipcMain.handle("favorite:set", (_event, sessionKey, favorited) => store.setFavorited(sessionKey, favorited));
  ipcMain.handle("pin:set", (_event, sessionKey, pinned) => store.setPinned(sessionKey, pinned));
  ipcMain.handle("hide:set", (_event, sessionKey, hidden) => store.setHidden(sessionKey, hidden));
  ipcMain.handle("index:refresh", () => runIndexSync());
  ipcMain.handle("index:status", () => indexStatus);
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_event, settings) => {
    const previous = getSettings();
    settingsStore.set({ ...getSettings(), ...settings });
    const next = getSettings();
    if (previous.includeClaudeInternal && !next.includeClaudeInternal) store.deleteSessionsBySource(["claude-internal"]);
    if (previous.includeCodexInternal && !next.includeCodexInternal) store.deleteSessionsBySource(["codex-internal"]);
    return next;
  });
  ipcMain.handle("command:copy-resume", (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(getResumeCommand(session, getSettings()));
  });
  ipcMain.handle("command:resume", async (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    store.markResumed(sessionKey);
    await openResumeInTerminal(session, getSettings());
  });
  ipcMain.handle("command:resume-iterm", async (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    store.markResumed(sessionKey);
    await openResumeInSpecificTerminal(session, getSettings(), "iTerm");
  });
  ipcMain.handle("command:open-app", async (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (session) await openNativeApp(session.source);
  });
  ipcMain.handle("command:reveal", async (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (session) await revealInFileManager(session.projectPath || session.filePath);
  });
  ipcMain.handle("command:copy-markdown", (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionMarkdown(session, store.getAllMessages(sessionKey)));
  });
  ipcMain.handle("command:copy-plain", (_event, sessionKey) => {
    const session = store.getSession(sessionKey);
    if (!session) return;
    clipboard.writeText(formatSessionPlainText(session, store.getAllMessages(sessionKey)));
  });
}
app.whenReady().then(() => {
  const dbPath = path.join(app.getPath("userData"), "session-search.sqlite");
  store = new SessionStore(dbPath);
  registerIpc();
  createApplicationMenu();
  createWindow();
  createTray();
  globalShortcut.register("Alt+Space", toggleWindow);
  setTimeout(() => void runIndexSync(), INITIAL_INDEX_DELAY_MS);
  startAutoIndexRefresh();
});
app.on("window-all-closed", () => {
});
app.on("before-quit", () => {
  stopAutoIndexRefresh();
  globalShortcut.unregisterAll();
  store?.close();
});
