import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  onTemporarySession?: (sessionKey: string) => void;
}

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
  const json = extractJsonObject(text);
  if (!json) throw new Error("AI summary response was not valid JSON.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("AI summary response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("AI summary response was not an object.");
  const record = parsed as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const tags = normalizeTags(record.tags);
  if (!summary) throw new Error("AI summary response had no summary.");
  return { summary, title, tags };
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

// Models sometimes wrap JSON in prose or code fences; grab the outermost object.
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + 1);
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
async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: merged,
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`AI summary request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  }
}

// Some newer models (GPT-5 / o-series and compatible providers) reject a `temperature`
// parameter outright with an HTTP 400. Detect that specific failure so callers can retry
// the request once without the sampling knob instead of surfacing an error to the user.
export function isTemperatureUnsupported(status: number, detail: string): boolean {
  return status === 400 && /temperature/i.test(detail) && /(deprecated|unsupported|not support|does not support|only the default)/i.test(detail);
}

// OpenAI-compatible /chat/completions (DeepSeek, GLM pay-as-you-go, Kimi, etc.).
async function openaiChatCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const request = (includeTemperature: boolean) =>
    postJson(
      `${endpoint.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${endpoint.apiKey}` },
      { model: endpoint.model, messages, ...(includeTemperature ? { temperature: 0.2 } : {}), stream: false },
      signal,
    );
  let response = await request(true);
  if (!response.ok) {
    const detail = await safeReadText(response);
    if (isTemperatureUnsupported(response.status, detail)) {
      response = await request(false);
    } else {
      throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
    }
  }
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI summary response had no content.");
  return content;
}

// OpenAI-compatible Responses API (/responses), used by Codex-style providers.
async function openaiResponsesCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const request = (includeTemperature: boolean) =>
    postJson(
      `${endpoint.baseUrl}/responses`,
      { Authorization: `Bearer ${endpoint.apiKey}` },
      {
        model: endpoint.model,
        instructions: responsesInstructions(messages),
        input: toResponsesInput(messages),
        ...(includeTemperature ? { temperature: 0.2 } : {}),
        stream: false,
      },
      signal,
    );
  let response = await request(true);
  if (!response.ok) {
    const detail = await safeReadText(response);
    if (isTemperatureUnsupported(response.status, detail)) {
      response = await request(false);
    } else {
      throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
    }
  }
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
  }
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

// Spawns a CLI binary cross-platform. On Windows the `codex` / `claude` commands
// are usually npm `.cmd` shims, which Node's spawn cannot execute directly unless
// it goes through a shell. We therefore set `shell: true` on win32 and quote the
// arguments ourselves (cmd.exe needs each arg wrapped and embedded quotes/specials
// escaped), so multi-line prompts survive. POSIX keeps the safe no-shell path.
function spawnCli(command: string, args: string[], options: { cwd: string; signal: AbortSignal }) {
  if (process.platform !== "win32") {
    return spawn(command, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
  }
  // On Windows with shell: true, we need to join command and args into a single string.
  // Only quote the arguments, not the command itself (the shell resolves the command).
  const quotedArgs = args.map(quoteWindowsArg);
  const cmdString = [command, ...quotedArgs].join(" ");
  return spawn(cmdString, [], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal,
    shell: true,
  });
}

// Quote a single argument for cmd.exe. Inside double quotes cmd does NOT interpret
// & | < > ( ) ^, so we only need to: wrap in quotes, double embedded quotes, and
// neutralize % to avoid environment-variable expansion. Newlines inside the quoted
// span are passed through as part of the argument.
export function quoteWindowsArg(arg: string): string {
  const escaped = arg.replace(/"/g, '""').replace(/%/g, "%%");
  return `"${escaped}"`;
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
    const proc = spawnCli(command, ["exec", "--ephemeral", "--json", "--skip-git-repo-check", "--sandbox", "read-only", prompt], {
      cwd,
      signal: mergedSignal,
    });
    let stderr = "";
    let content = "";
    let stdoutBuffer = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = consumeJsonLines(stdoutBuffer + chunk.toString(), (line) => {
        const event = parseCodexExecLine(line);
        if (event?.type === "thread.started" && event.thread_id) {
          endpoint.onTemporarySession?.(`codex:${event.thread_id}`);
        }
        if (event?.type === "item.completed") {
          const text = extractCodexExecItemText(event.item);
          if (text) content += text;
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
      // If codex is not found, fall back to claude exec
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(claudeExecCompletion(endpoint, messages, signal));
        return;
      }
      reject(error);
    });
    proc.on("close", (code, signalName) => {
      if (stdoutBuffer.trim()) {
        const event = parseCodexExecLine(stdoutBuffer.trim());
        if (event?.type === "thread.started" && event.thread_id) {
          endpoint.onTemporarySession?.(`codex:${event.thread_id}`);
        }
        if (event?.type === "item.completed") {
          const text = extractCodexExecItemText(event.item);
          if (text) content += text;
        }
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
        // If codex exited with error, try falling back to claude exec
        // This handles cases where codex command doesn't exist or fails to run
        // We check for ENOENT-like patterns in stderr, and also fallback when
        // exit code is 1 with minimal/no content (typical of "command not found" on Windows)
        const hasNotFoundError = stderr.toLowerCase().includes("not found") ||
                                  stderr.toLowerCase().includes("not recognized") ||
                                  stderr.toLowerCase().includes("no such file") ||
                                  stderr.toLowerCase().includes("cannot find");
        const isEmptyError = code === 1 && (!content.trim() || stdoutBuffer.length < 100);
        if (hasNotFoundError || isEmptyError) {
          resolve(claudeExecCompletion(endpoint, messages, signal));
          return;
        }
        reject(new Error(`Codex summary exited with ${String(code)}. ${stderr.trim().slice(-1000)}`.trim()));
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
    prompt,
  ];

  return new Promise<string>((resolve, reject) => {
    const proc = spawnCli(command, args, { cwd, signal: mergedSignal });
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
      void deleteClaudeTemporarySessions(cwd, sessionIds);
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

function parseCodexExecLine(line: string): { type?: string; thread_id?: string; item?: unknown } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { type?: string; thread_id?: string; item?: unknown }) : null;
  } catch {
    return null;
  }
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

async function deleteClaudeTemporarySessions(cwd: string, sessionIds: Iterable<string>): Promise<void> {
  const slug = cwd.replace(/[\\/]/g, "-");
  await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      try {
        await rm(path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`), { force: true });
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
