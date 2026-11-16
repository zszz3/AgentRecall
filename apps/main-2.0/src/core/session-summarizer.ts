import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { httpTransportFailureReason } from "./http-transport-error";

// Accepts any role string so non user/assistant rows (e.g. tool output) can be filtered out.
export interface SummaryInputMessage {
  role: string;
  content: string;
}

// AI session summaries: a one-line "problem + solution" summary plus suggested
// tags/title for each session. The summary is what makes session search good —
// it normalizes wildly different transcripts into searchable language.

export interface SummaryEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  apiFormat: "openai_chat" | "openai_responses" | "anthropic" | "codex_exec" | "claude_exec";
  command?: string;
  cwd?: string;
  modelArg?: string;
  /** Extra read-only CLI flags used to test a draft without writing user configuration. */
  cliArgs?: string[];
  reasoningEffort?: string;
  /**
   * Extra environment for CLI-backed endpoints. This is how a summary source points `codex` /
   * `claude` at a config directory other than the machine's own, since neither CLI takes a base
   * URL or an API key on the command line.
   */
  env?: Record<string, string>;
  onTemporarySession?: (sessionKey: string) => void;
  /** Main-process transport for direct HTTP providers; Electron injection honors the system proxy. */
  fetch?: SummaryFetch;
}

export type SummaryFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionSummaryResult {
  summary: string;
  tags: string[];
  title: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ResponsesInputMessage {
  type: "message";
  role: "user";
  content: Array<{ type: "input_text"; text: string }>;
}

const MAX_CHARS_PER_MESSAGE = 1200;
const MAX_TAGS = 5;

// A long session keeps its problem statement at the start and its resolution at
// the end; the middle is mostly tool churn. So we summarize a head + tail excerpt
// rather than just the opening, while staying within one bounded LLM call.
export interface SessionExcerpt {
  head: readonly SummaryInputMessage[];
  tail: readonly SummaryInputMessage[];
  // Count of messages between head and tail that were dropped (for the marker).
  omittedCount: number;
}

// Accepts any custom API config shape (Codex ApiConfig or Claude ClaudeApiConfig);
// only these fields matter for talking to the provider.
export interface SummaryProviderConfig {
  activeProvider: string;
  customBaseUrl: string;
  customModel: string;
  customApiKey: string;
  customApiFormat: string;
}

// Picks the first active, complete custom endpoint from the candidate configs in
// order. Official Codex is handled separately through `codex exec --ephemeral`.
export function resolveSummaryEndpoint(candidates: readonly SummaryProviderConfig[]): SummaryEndpoint | null {
  for (const config of candidates) {
    if (config.activeProvider !== "custom") continue;
    const baseUrl = config.customBaseUrl.trim().replace(/\/+$/, "");
    const model = config.customModel.trim();
    const apiKey = config.customApiKey.trim();
    if (baseUrl && model && apiKey) {
      // Detect Anthropic either from the declared format or the conventional
      // /anthropic base path (GLM/DeepSeek/Kimi coding endpoints), since the
      // dedicated summary config can only store an OpenAI-ish format.
      const isAnthropic = config.customApiFormat === "anthropic" || /\/anthropic(\/|$)/.test(baseUrl);
      const apiFormat = isAnthropic ? "anthropic" : config.customApiFormat === "openai_responses" ? "openai_responses" : "openai_chat";
      return { baseUrl, model, apiKey, apiFormat };
    }
  }
  return null;
}

// A stored summary remembers which version of the session it described, so we can
// tell when the session has since been updated and the summary needs refreshing.
export interface SummaryRecord {
  basisUpdatedAt: number;
}

export type SummaryFreshness = "missing" | "stale" | "fresh";

export function summaryFreshness(session: { updatedAt: number }, record: SummaryRecord | null): SummaryFreshness {
  if (!record) return "missing";
  return session.updatedAt > record.basisUpdatedAt ? "stale" : "fresh";
}

// Batch/auto backfill: only touch sessions updated within maxAgeMs, and only when
// the summary is missing or stale. Manual single-session summaries bypass this.
export function needsBackfill(
  session: { updatedAt: number },
  record: SummaryRecord | null,
  now: number,
  maxAgeMs: number,
): boolean {
  if (now - session.updatedAt > maxAgeMs) return false;
  return summaryFreshness(session, record) !== "fresh";
}

const SYSTEM_PROMPT =
  "You label developer AI-coding sessions so they can be found again later. " +
  "Read the transcript excerpt and reply with a single JSON object and nothing else: " +
  '{"summary": string, "title": string, "tags": string[]}. ' +
  "summary: one or two sentences. Name the component, area, or files involved, the problem, " +
  "AND how it was solved (or the current state). Be specific and concrete; avoid vague phrasing. " +
  "title: <= 8 words. tags: 2-5 short lowercase topic tags (tools, languages, domains). " +
  "Write summary and title in the same language the user mostly used in the transcript.";

export function buildSummaryMessages(excerpt: SessionExcerpt): ChatMessage[] {
  const transcript = buildTranscript(excerpt);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Transcript excerpt:\n\n${transcript}` },
  ];
}

function formatMessageLine(message: SummaryInputMessage): string | null {
  const content = (message.content ?? "").trim();
  if (!content) return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  const clipped = content.length > MAX_CHARS_PER_MESSAGE ? `${content.slice(0, MAX_CHARS_PER_MESSAGE)}…` : content;
  return `${message.role.toUpperCase()}: ${clipped}`;
}

function buildTranscript(excerpt: SessionExcerpt): string {
  const headLines = excerpt.head.map(formatMessageLine).filter((line): line is string => line !== null);
  const tailLines = excerpt.tail.map(formatMessageLine).filter((line): line is string => line !== null);
  const parts = [...headLines];
  if (excerpt.omittedCount > 0) parts.push(`[... ${excerpt.omittedCount} messages omitted ...]`);
  parts.push(...tailLines);
  return parts.join("\n\n");
}

export function parseSummaryResponse(text: string): SessionSummaryResult {
  const candidates = extractJsonObjects(text);
  let sawObject = false;
  // The answer is the last complete object the model produced, so a schema echo or a
  // preamble that happens to contain an object cannot win over the real summary.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidates[index]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    sawObject = true;
    const record = parsed as Record<string, unknown>;
    const summary = typeof record.summary === "string" ? record.summary.trim() : "";
    if (!summary) continue;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    return { summary, title, tags: normalizeTags(record.tags) };
  }
  if (sawObject) throw new Error("AI summary response had no summary.");
  throw new Error(`AI summary response was not valid JSON. ${describeSummaryReply(text)}`.trim());
}

// The reply is the only evidence of why a summary failed, and it is otherwise discarded.
function describeSummaryReply(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (!collapsed) return "";
  return `Model replied: ${collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed}`;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().toLowerCase().replace(/\s+/g, "-");
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/**
 * Models wrap the JSON in prose or code fences, and CLI providers can emit a preamble before the
 * answer. Slicing from the first `{` to the last `}` swallows that surrounding text whenever it
 * contains a brace of its own — a trailing note, an echoed snippet, two objects — and the summary
 * then fails as unparseable. So collect every span that closes as a complete object instead.
 */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const end = findObjectEnd(text, index);
    // A brace the surrounding prose never closes is not an object; the real one may still
    // follow, so keep looking from the next character instead of giving up on the reply.
    if (end === -1) continue;
    objects.push(text.slice(index, end + 1));
    index = end;
  }
  return objects;
}

/**
 * Index of the brace closing the object opened at `start`, or -1 when it never closes. State is
 * per-object rather than per-reply: quotes in the prose ahead of an object are not JSON strings,
 * and treating them as such would hide the object behind them. Within the object, string literals
 * and escapes are tracked so a brace or quote in a summary cannot end it early.
 */
function findObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export type ChatCompletionFn = (endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

export async function summarizeSession(
  excerpt: SessionExcerpt,
  endpoint: SummaryEndpoint,
  chat: ChatCompletionFn = defaultChatCompletion,
  signal?: AbortSignal,
): Promise<SessionSummaryResult> {
  const chatMessages = buildSummaryMessages(excerpt);
  if (!chatMessages[1].content.includes("USER") && !chatMessages[1].content.includes("ASSISTANT")) {
    throw new Error("Session has no readable user/assistant messages to summarize.");
  }
  const reply = await chat(endpoint, chatMessages, signal);
  return parseSummaryResponse(reply);
}

function defaultChatCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  if (endpoint.apiFormat === "codex_exec") return codexExecCompletion(endpoint, messages, signal);
  if (endpoint.apiFormat === "claude_exec") return claudeExecCompletion(endpoint, messages, signal);
  if (endpoint.apiFormat === "anthropic") return anthropicCompletion(endpoint, messages, signal);
  if (endpoint.apiFormat === "openai_responses") return openaiResponsesCompletion(endpoint, messages, signal);
  return openaiChatCompletion(endpoint, messages, signal);
}

export const requestSummaryCompletion: ChatCompletionFn = defaultChatCompletion;

const REQUEST_TIMEOUT_MS = 60_000;

// Always bounds the request so a hung provider cannot block the (sequential) batch
// forever — the original symptom of summaries appearing to be "stuck".
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  fetchImpl: SummaryFetch = fetch,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: merged,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`AI summary request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    if (error instanceof Error) {
      const reason = httpTransportFailureReason(error) || error.message;
      throw new Error(`AI summary request could not reach ${url}: ${reason}.`, { cause: error });
    }
    throw new Error(`AI summary request could not reach ${url}: ${String(error)}.`);
  }
}

// Some newer models (GPT-5 / o-series and compatible providers) reject a `temperature`
// parameter outright with an HTTP 400. Detect that specific failure so callers can retry
// the request once without the sampling knob instead of surfacing an error to the user.
export function isTemperatureUnsupported(status: number, detail: string): boolean {
  return status === 400 && /temperature/i.test(detail) && /(deprecated|unsupported|not support|does not support|only the default)/i.test(detail);
}

// The mirror of the temperature case: plenty of OpenAI-compatible gateways front models that
// have no reasoning stage and reject the parameter. Retrying without it keeps a summary working
// on those providers instead of failing because of a control the user set for a different model.
export function isReasoningEffortUnsupported(status: number, detail: string): boolean {
  return status === 400
    && /reasoning/i.test(detail)
    && /(deprecated|unsupported|not support|does not support|unknown|unrecognized|invalid|extra)/i.test(detail);
}

/**
 * Issues the request, dropping `temperature` and then `reasoning` if the provider says it cannot
 * accept them. Each knob is retried at most once, so this makes at most three round trips.
 */
async function postWithOptionalKnobs(
  send: (knobs: { temperature: boolean; reasoning: boolean }) => Promise<Response>,
  wantsReasoning: boolean,
): Promise<Response> {
  const knobs = { temperature: true, reasoning: wantsReasoning };
  let response = await send(knobs);
  while (!response.ok) {
    const detail = await safeReadText(response);
    if (knobs.temperature && isTemperatureUnsupported(response.status, detail)) knobs.temperature = false;
    else if (knobs.reasoning && isReasoningEffortUnsupported(response.status, detail)) knobs.reasoning = false;
    else throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
    response = await send(knobs);
  }
  return response;
}

// OpenAI-compatible /chat/completions (DeepSeek, GLM pay-as-you-go, Kimi, etc.).
async function openaiChatCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const effort = endpoint.reasoningEffort?.trim() ?? "";
  const response = await postWithOptionalKnobs(
    (knobs) =>
      postJson(
        `${endpoint.baseUrl}/chat/completions`,
        { Authorization: `Bearer ${endpoint.apiKey}` },
        {
          model: endpoint.model,
          messages,
          ...(knobs.temperature ? { temperature: 0.2 } : {}),
          ...(knobs.reasoning ? { reasoning_effort: effort } : {}),
          stream: false,
        },
        signal,
        endpoint.fetch,
      ),
    Boolean(effort),
  );
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI summary response had no content.");
  return content;
}

// OpenAI-compatible Responses API (/responses), used by Codex-style providers.
async function openaiResponsesCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const effort = endpoint.reasoningEffort?.trim() ?? "";
  const response = await postWithOptionalKnobs(
    (knobs) =>
      postJson(
        `${endpoint.baseUrl}/responses`,
        { Authorization: `Bearer ${endpoint.apiKey}` },
        {
          model: endpoint.model,
          instructions: responsesInstructions(messages),
          input: toResponsesInput(messages),
          ...(knobs.temperature ? { temperature: 0.2 } : {}),
          ...(knobs.reasoning ? { reasoning: { effort } } : {}),
          stream: false,
        },
        signal,
        endpoint.fetch,
      ),
    Boolean(effort),
  );
  const data = (await response.json()) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  const content =
    typeof data.output_text === "string"
      ? data.output_text
      : Array.isArray(data.output)
        ? data.output
            .flatMap((item) => item.content ?? [])
            .filter((block) => (block.type === "output_text" || block.type === "text") && typeof block.text === "string")
            .map((block) => block.text)
            .join("")
        : "";
  if (!content.trim()) throw new Error("AI summary response had no content.");
  return content;
}

const DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const SIMPLE_NODE_WRAPPER_PATTERN = /^\s*(?:@echo\s+off\s*\r?\n)?\s*"([^"\r\n]+\.(?:exe|com))"\s+"([^"\r\n]+\.(?:c?m?js))"\s+%\*\s*$/iu;
const SIMPLE_NATIVE_WRAPPER_PATTERN = /^\s*(?:@echo\s+off\s*\r?\n)?\s*"([^"\r\n]+\.(?:exe|com))"\s+%\*\s*$/iu;
const NPM_CMD_SHIM_PATTERN = /"%(?:~dp0|dp0%)\\([^"\r\n]+?\.(?:c?m?js))"/iu;

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const upper = key.toUpperCase();
  const entry = Object.entries(env).find(([name]) => name.toUpperCase() === upper);
  return entry?.[1];
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = envValue(env, "PATHEXT") || DEFAULT_WINDOWS_PATHEXT;
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
}

function probeWindowsFile(basePath: string, extensions: readonly string[]): string | null {
  if (path.win32.extname(basePath)) {
    return existsSync(basePath) ? basePath : null;
  }
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  return existsSync(basePath) ? basePath : null;
}

function resolveWindowsExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const extensions = windowsPathExtensions(env);
  if (/[\\/]/u.test(trimmed) || path.win32.isAbsolute(trimmed)) {
    const resolved = path.win32.isAbsolute(trimmed)
      ? path.win32.normalize(trimmed)
      : path.win32.resolve(cwd, trimmed);
    return probeWindowsFile(resolved, extensions);
  }
  const searchDirs = (envValue(env, "PATH") ?? "")
    .split(path.win32.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  for (const dir of searchDirs) {
    const found = probeWindowsFile(path.win32.join(dir, trimmed), extensions);
    if (found) return found;
  }
  return null;
}

function resolveNodeExe(
  shimPath: string,
  env: NodeJS.ProcessEnv,
): { file: string; envOverrides?: Record<string, string> } {
  const adjacentNode = path.win32.join(path.win32.dirname(shimPath), "node.exe");
  if (existsSync(adjacentNode)) return { file: adjacentNode };
  const configuredNode = envValue(env, "AGENT_RECALL_NODE_PATH")?.trim();
  if (configuredNode && existsSync(configuredNode)) return { file: configuredNode };
  const onPath = resolveWindowsExecutable("node.exe", path.win32.dirname(shimPath), env);
  if (onPath) return { file: onPath };
  return process.versions.electron
    ? { file: process.execPath, envOverrides: { ELECTRON_RUN_AS_NODE: "1" } }
    : { file: process.execPath };
}

function quoteWindowsCmdExecutable(command: string): string {
  const text = String(command);
  if (/[\r\n\0"]/u.test(text)) {
    throw new Error("Windows CLI executable path cannot contain quotes, newlines, or NUL bytes.");
  }
  return `"${text.replace(/%/g, '"^%"')}"`;
}

function resolveWindowsCliInvocation(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { file: string; args: string[]; windowsVerbatimArguments?: true; envOverrides?: Record<string, string> } {
  const resolved = resolveWindowsExecutable(command, cwd, env);
  const target = resolved ?? command.trim();
  const ext = path.win32.extname(target).toLowerCase();

  if (resolved && (ext === ".cmd" || ext === ".bat")) {
    try {
      const content = readFileSync(resolved, "utf8");
      const shimDir = path.win32.dirname(resolved);
      const nodeWrapper = content.match(SIMPLE_NODE_WRAPPER_PATTERN);
      if (nodeWrapper) {
        const exePath = path.win32.resolve(shimDir, nodeWrapper[1]);
        const scriptPath = path.win32.resolve(shimDir, nodeWrapper[2]);
        if (existsSync(exePath) && existsSync(scriptPath)) {
          return { file: exePath, args: [scriptPath, ...args] };
        }
      }
      const nativeWrapper = content.match(SIMPLE_NATIVE_WRAPPER_PATTERN);
      if (nativeWrapper) {
        const exePath = path.win32.resolve(shimDir, nativeWrapper[1]);
        if (existsSync(exePath)) {
          return { file: exePath, args: [...args] };
        }
      }
      const npmShim = content.match(NPM_CMD_SHIM_PATTERN);
      if (npmShim) {
        const scriptPath = path.win32.resolve(shimDir, npmShim[1]);
        if (existsSync(scriptPath)) {
          const node = resolveNodeExe(resolved, env);
          return {
            file: node.file,
            args: [scriptPath, ...args],
            ...(node.envOverrides ? { envOverrides: node.envOverrides } : {}),
          };
        }
      }
    } catch {
      // Fall through to cmd.exe if the batch file cannot be read directly.
    }
  }

  if (ext === ".cmd" || ext === ".bat") {
    const comspec = envValue(env, "ComSpec") || "cmd.exe";
    const commandLine = `"${[quoteWindowsCmdExecutable(target), ...args.map(quoteWindowsArg)].join(" ")}"`;
    return {
      file: comspec,
      args: ["/d", "/v:off", "/s", "/c", commandLine],
      windowsVerbatimArguments: true,
    };
  }

  return { file: target, args: [...args] };
}

function terminateWindowsProcessTree(proc: ChildProcess): void {
  if (typeof proc.pid === "number" && proc.pid > 0 && proc.exitCode === null) {
    try {
      const killer = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      killer.once("error", () => {
        if (proc.exitCode === null && !proc.killed) proc.kill();
      });
      killer.once("exit", (code) => {
        if (code !== 0 && proc.exitCode === null && !proc.killed) proc.kill();
      });
      killer.unref();
      return;
    } catch {
      // Fall back to direct child termination if taskkill cannot be spawned.
    }
  }
  if (!proc.killed) proc.kill();
}

// Spawns a CLI binary cross-platform. On Windows, npm `.cmd` shims and simple
// batch wrappers are unwrapped to direct `node.exe` / `.exe` calls (`shell: false`)
// and abort signals tear down the full Windows process tree via `taskkill /T /F`.
// The prompt is sent through stdin so Windows command-line length limits never apply.
function spawnCli(
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; input: string; env?: Record<string, string> },
) {
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
  const env: NodeJS.ProcessEnv = options.env ? { ...process.env, ...options.env } : process.env;
  if (process.platform !== "win32") {
    const proc = spawn(command, args, { cwd: options.cwd, env, stdio, signal: options.signal });
    proc.stdin.on("error", () => {
      // Ignore EPIPE when the child exits before reading the entire prompt.
    });
    proc.stdin.end(options.input);
    return proc;
  }

  const invocation = resolveWindowsCliInvocation(command, args, options.cwd, env);
  const finalEnv = invocation.envOverrides ? { ...env, ...invocation.envOverrides } : env;
  const proc = spawn(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: finalEnv,
    stdio,
    shell: false,
    windowsHide: true,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  const onAbort = () => terminateWindowsProcessTree(proc);
  const cleanup = () => options.signal.removeEventListener("abort", onAbort);
  options.signal.addEventListener("abort", onAbort, { once: true });
  proc.once("close", cleanup);
  proc.once("error", cleanup);
  if (options.signal.aborted) onAbort();
  proc.stdin.on("error", () => {
    // Ignore EPIPE when an aborted or missing child exits before reading stdin.
  });
  proc.stdin.end(options.input);
  return proc;
}

// Quote a single argument for a Windows .cmd/.bat script via cmd.exe /d /v:off /s /c.
// Applies MSVCRT quoting followed by two passes of ^-escaping on cmd metacharacters
// so both cmd /c and batch %* expansion preserve quotes, metacharacters, and %VAR%.
export function quoteWindowsArg(arg: string): string {
  const text = String(arg);
  if (/[\r\n\0]/u.test(text)) {
    throw new Error("Windows CLI arguments cannot contain newlines or NUL bytes.");
  }
  let msvcr = '"';
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
    } else if (ch === '"') {
      msvcr += `${"\\".repeat(backslashes * 2 + 1)}"`;
      backslashes = 0;
    } else {
      msvcr += `${"\\".repeat(backslashes)}${ch}`;
      backslashes = 0;
    }
  }
  msvcr += `${"\\".repeat(backslashes * 2)}"`;

  const escapeCmdMeta = (value: string) => value.replace(/[()%!^"<>&|]/g, "^$&");
  return escapeCmdMeta(escapeCmdMeta(msvcr));
}

async function codexExecCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const command = endpoint.command?.trim() || "codex";
  const cwd = endpoint.cwd || process.cwd();
  const prompt = `${responsesInstructions(messages)}\n\n${messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")}`;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2);
  const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  return new Promise<string>((resolve, reject) => {
    if (mergedSignal.aborted) {
      reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
      return;
    }
    const proc = spawnCli(command, [
      "exec",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      ...(endpoint.modelArg ? ["--model", endpoint.modelArg] : []),
      ...(endpoint.reasoningEffort
        ? ["--config", `model_reasoning_effort=\"${endpoint.reasoningEffort}\"`]
        : []),
      ...(endpoint.cliArgs ?? []),
    ], {
      cwd,
      signal: mergedSignal,
      input: prompt,
      env: endpoint.env,
    });
    let stderr = "";
    let stdoutError = "";
    let content = "";
    let stdoutBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = consumeJsonLines(stdoutBuffer + chunk.toString(), (line) => {
        const event = parseCodexExecLine(line);
        if (event?.type === "thread.started" && event.thread_id) {
          endpoint.onTemporarySession?.(`codex:${event.thread_id}`);
        }
        const diagnostic = extractCodexExecError(event);
        if (diagnostic) stdoutError = diagnostic;
        if (event?.type === "item.completed") {
          const text = extractCodexExecItemText(event.item);
          if (text) content += content ? `\n${text}` : text;
        }
      });
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      if (error.name === "AbortError") {
        reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`Local Codex executable was not found: ${command}`));
        return;
      }
      reject(error);
    });
    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        const event = parseCodexExecLine(stdoutBuffer.trim());
        if (event?.type === "thread.started" && event.thread_id) {
          endpoint.onTemporarySession?.(`codex:${event.thread_id}`);
        }
        const diagnostic = extractCodexExecError(event);
        if (diagnostic) stdoutError = diagnostic;
        if (event?.type === "item.completed") {
          const text = extractCodexExecItemText(event.item);
          if (text) content += content ? `\n${text}` : text;
        }
      }
      if (mergedSignal.aborted) {
        reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
        return;
      }
      if (code !== 0) {
        // A null exit code means the process was killed by a signal — this is how an
        // aborted/timed-out run terminates. Treat it as a timeout/cancellation and stop;
        // do NOT fall back to claude, which would silently launch a second full summary
        // run after the caller already cancelled or the deadline already passed.
        if (code === null) {
          reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
          return;
        }
        // Keep local Codex failures visible instead of silently launching another
        // provider after the user explicitly selected Codex for summaries.
        const hasNotFoundError = code === 9009 ||
                                  stderr.toLowerCase().includes("not found") ||
                                  stderr.toLowerCase().includes("not recognized") ||
                                  stderr.toLowerCase().includes("no such file") ||
                                  stderr.toLowerCase().includes("cannot find");
        if (hasNotFoundError) {
          reject(new Error(`Local Codex executable was not found: ${command}`));
          return;
        }
        const diagnostics = [stdoutError.trim().slice(-1000), stderr.trim().slice(-1000)]
          .filter(Boolean)
          .join("\n");
        reject(new Error(`Codex summary exited with ${String(code)}. ${diagnostics}`.trim()));
        return;
      }
      if (!content.trim()) {
        reject(new Error("AI summary response had no content."));
        return;
      }
      resolve(content);
    });
  });
}

async function claudeExecCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const command = endpoint.command?.trim() || "claude";
  const cwd = endpoint.cwd || process.cwd();
  const prompt = `${responsesInstructions(messages)}\n\n${messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")}`;
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2);
  const mergedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    "bypassPermissions",
    ...(endpoint.modelArg ? ["--model", endpoint.modelArg] : []),
    ...(endpoint.cliArgs ?? []),
  ];

  return new Promise<string>((resolve, reject) => {
    if (mergedSignal.aborted) {
      reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
      return;
    }
    const proc = spawnCli(command, args, { cwd, signal: mergedSignal, input: prompt, env: endpoint.env });
    const sessionIds = new Set<string>();
    let stderr = "";
    let streamedContent = "";
    let resultContent = "";
    let stdoutBuffer = "";
    const notifiedSessionIds = new Set<string>();
    const recordTemporarySession = (sessionId: string): void => {
      sessionIds.add(sessionId);
      if (notifiedSessionIds.has(sessionId)) return;
      notifiedSessionIds.add(sessionId);
      endpoint.onTemporarySession?.(`claude:${sessionId}`);
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = consumeJsonLines(stdoutBuffer + chunk.toString(), (line) => {
        const event = parseJsonLine(line);
        const sessionId = extractClaudeSessionId(event);
        if (sessionId) recordTemporarySession(sessionId);
        if (isRecord(event) && event.type === "result") {
          const result = typeof event.result === "string" ? event.result : "";
          if (result) resultContent = result;
        } else {
          streamedContent += extractClaudeEventText(event);
        }
      });
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      if (error.name === "AbortError") reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
      else reject(error);
    });
    proc.on("close", (code, signalName) => {
      if (stdoutBuffer.trim()) {
        const event = parseJsonLine(stdoutBuffer.trim());
        const sessionId = extractClaudeSessionId(event);
        if (sessionId) recordTemporarySession(sessionId);
        if (isRecord(event) && event.type === "result" && typeof event.result === "string") resultContent = event.result;
        else streamedContent += extractClaudeEventText(event);
      }
      void deleteClaudeTemporarySessions(cwd, sessionIds, claudeHomeFor(endpoint));
      if (mergedSignal.aborted) {
        reject(new Error(`AI summary request timed out after ${(REQUEST_TIMEOUT_MS * 2) / 1000}s.`));
        return;
      }
      if (code !== 0) {
        const status = code === null ? `unknown${signalName ? ` (${signalName})` : ""}` : String(code);
        reject(new Error(`Claude Code summary exited with ${status}. ${stderr.trim().slice(-1000)}`.trim()));
        return;
      }
      const content = resultContent || streamedContent;
      if (!content.trim()) {
        reject(new Error("AI summary response had no content."));
        return;
      }
      resolve(content);
    });
  });
}

function consumeJsonLines(buffer: string, onLine: (line: string) => void): string {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
  return rest;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

function parseCodexExecLine(line: string): { type?: string; thread_id?: string; item?: unknown; error?: unknown; message?: unknown } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { type?: string; thread_id?: string; item?: unknown }) : null;
  } catch {
    return null;
  }
}

function extractCodexExecError(event: { type?: string; item?: unknown; error?: unknown; message?: unknown } | null): string {
  if (!event) return "";
  const candidate = event.type === "error"
    ? event.message
    : event.type === "turn.failed" && isRecord(event.error)
      ? event.error.message
      : event.type === "item.completed" && isRecord(event.item) && event.item.type === "error"
        ? event.item.message
        : "";
  return typeof candidate === "string" ? candidate : "";
}

function extractClaudeSessionId(event: unknown): string {
  if (!isRecord(event)) return "";
  const sessionId = typeof event.session_id === "string" ? event.session_id : typeof event.sessionId === "string" ? event.sessionId : "";
  return sessionId.trim();
}

function extractClaudeEventText(event: unknown): string {
  if (!isRecord(event)) return "";
  if (event.type !== "assistant" && event.type !== "message") return "";
  const message = isRecord(event.message) ? event.message : event;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : typeof part.content === "string" ? part.content : "";
    })
    .join("");
}

/**
 * Where the Claude CLI will have written this run's transcript. It follows `CLAUDE_CONFIG_DIR`
 * when the endpoint points at its own config directory, so cleanup deletes the ephemeral session
 * the CLI actually created rather than looking for it under `~/.claude` and leaving it behind.
 */
function claudeHomeFor(endpoint: SummaryEndpoint): string {
  return endpoint.env?.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

async function deleteClaudeTemporarySessions(
  cwd: string,
  sessionIds: Iterable<string>,
  claudeHome: string,
): Promise<void> {
  const slug = cwd.replace(/[^a-zA-Z0-9-]/g, "-");
  await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      try {
        await rm(path.join(claudeHome, "projects", slug, `${sessionId}.jsonl`), { force: true });
      } catch {
        // Best-effort cleanup only; the summary result should not depend on local history deletion.
      }
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractCodexExecItemText(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const record = item as Record<string, unknown>;
  if (record.type !== "agent_message") return "";
  return typeof record.text === "string" ? record.text : "";
}

function toResponsesInput(messages: ChatMessage[]): ResponsesInputMessage[] {
  return messages.filter((message) => message.role === "user").map((message) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message.content }],
  }));
}

function responsesInstructions(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
}

// Anthropic Messages API (/v1/messages). Covers coding-plan providers used with
// Claude Code (GLM / DeepSeek / Kimi anthropic endpoints). Sends both x-api-key
// and Authorization: Bearer so it works across compatible providers.
async function anthropicCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const userMessages = messages.filter((m) => m.role === "user").map((m) => ({ role: "user", content: m.content }));
  const response = await postJson(
    `${endpoint.baseUrl}/v1/messages`,
    { "x-api-key": endpoint.apiKey, Authorization: `Bearer ${endpoint.apiKey}`, "anthropic-version": "2023-06-01" },
    { model: endpoint.model, max_tokens: 1024, system, messages: userMessages },
    signal,
    endpoint.fetch,
  );
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
  }
  const data = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = Array.isArray(data.content)
    ? data.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
    : "";
  if (!text.trim()) throw new Error("AI summary response had no content.");
  return text;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return "";
  }
}
