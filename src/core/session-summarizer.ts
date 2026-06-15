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
  apiFormat: "openai_chat" | "anthropic";
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

// Picks the first usable custom endpoint from the candidate configs in order.
// Callers pass the dedicated summary config first, then existing configs, so an
// unconfigured dedicated provider transparently falls back to the existing one
// (including a Claude/Anthropic coding-plan provider).
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
      return { baseUrl, model, apiKey, apiFormat: isAnthropic ? "anthropic" : "openai_chat" };
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
  return endpoint.apiFormat === "anthropic"
    ? anthropicCompletion(endpoint, messages, signal)
    : openaiChatCompletion(endpoint, messages, signal);
}

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

// OpenAI-compatible /chat/completions (DeepSeek, GLM pay-as-you-go, Kimi, etc.).
async function openaiChatCompletion(endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const response = await postJson(
    `${endpoint.baseUrl}/chat/completions`,
    { Authorization: `Bearer ${endpoint.apiKey}` },
    { model: endpoint.model, messages, temperature: 0.2, stream: false },
    signal,
  );
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI summary request failed (HTTP ${response.status}). ${detail}`.trim());
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI summary response had no content.");
  return content;
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
