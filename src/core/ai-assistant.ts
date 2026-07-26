// Conversational AI assistant that finds past sessions by calling search tools.
//
// The model is given function-calling tools mirroring the MCP server
// (search_sessions / list_projects / list_tags / get_session). It decides which
// tools to call, we execute them against the local SessionStore, feed results
// back, and loop until the model produces a final text answer. Along the way we
// collect every sessionKey the model surfaced so the UI can render clickable
// session cards.
//
// The transport layer mirrors session-summarizer.ts (OpenAI /chat/completions
// and Anthropic /v1/messages) but adds tool support. Network functions are
// injectable so the tool-call loop is unit-testable without a real provider.

import { isTemperatureUnsupported, requestSummaryCompletion, type ChatMessage, type SummaryEndpoint } from "./session-summarizer";

export type { SummaryEndpoint } from "./session-summarizer";

// A chat message in our neutral representation. Tool results are carried as a
// `tool` role with the originating call id so both provider formats can rebuild
// their own wire shape.
export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // Present on assistant turns that requested tool calls.
  toolCalls?: AiToolCall[];
  // Present on `tool` messages: which call this is answering.
  toolCallId?: string;
  toolName?: string;
}

export interface AiToolCall {
  id: string;
  name: string;
  // Raw JSON arguments string as emitted by the model.
  arguments: string;
}

// What the main process injects: runs one tool and returns a JSON-serializable
// result, plus the sessionKeys that result surfaced (for UI cards).
export interface ToolExecutionResult {
  result: unknown;
  sessionKeys: string[];
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;

export interface AiAssistantReplyInternal {
  reply: string;
  sessionKeys: string[];
}

export const AI_ASSISTANT_SYSTEM_PROMPT =
  "You are the session-search assistant inside a desktop app that indexes the user's past AI coding sessions " +
  "(Claude Code, Codex, CodeBuddy, etc.). The user describes a session they are trying to find; your job is to " +
  "locate it. ALWAYS use the provided tools to search — never guess from memory. " +
  "Before searching, distill the user's request into a few precise search keywords: keep concrete nouns, " +
  "technical terms, file names, error messages, and identifiers; drop filler words, pronouns, and conversational " +
  "phrasing (e.g. 'find the session where I', 'help me look for'). Search in the same language the user wrote in. " +
  "Prefer search_sessions with those concise keywords; call it multiple times with different keyword sets if the " +
  "first attempt misses. Use list_projects or list_tags to narrow scope when helpful, and get_session to confirm a " +
  "candidate. " +
  "When you have results, reply briefly (in the same language the user wrote in) and explain why each match fits. " +
  "Do not invent sessionKeys. If nothing matches, say so and suggest different keywords.";

// Tool schema in a neutral shape; converted per-provider below.
interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const AI_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "search_sessions",
    description:
      "Search past AI coding sessions by keywords. Matches titles, first questions, transcripts, and AI summaries.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search for." },
        source: { type: "string", description: "Optional source filter, e.g. claude-cli or codex-cli." },
        project: { type: "string", description: "Optional substring match on the project path." },
        limit: { type: "number", description: "Max results (1-50, default 20)." },
      },
    },
  },
  {
    name: "list_projects",
    description: "List indexed projects with their session counts.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "list_tags",
    description: "List all user-created tags.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_session",
    description: "Fetch a single session's metadata, AI summary, and messages by its sessionKey.",
    parameters: {
      type: "object",
      properties: {
        sessionKey: { type: "string", description: "Session key from a search result." },
        maxMessages: { type: "number", description: "Max messages to return (1-200, default 40)." },
        offset: { type: "number", description: "Message index to start from." },
      },
      required: ["sessionKey"],
    },
  },
];

// One round-trip to the LLM. Returns either an assistant text reply or a set of
// tool calls the caller must execute and feed back. Injectable for testing.
export type ToolChatCompletionFn = (
  endpoint: SummaryEndpoint,
  messages: AiChatMessage[],
  signal?: AbortSignal,
) => Promise<{ content: string; toolCalls: AiToolCall[] }>;

const MAX_TOOL_ROUNDS = 6;

// Drives the tool-call loop: call the model, run any requested tools, feed the
// results back, repeat until the model answers in plain text (or we hit the
// round cap). Returns the final reply plus every sessionKey surfaced by tools.
export async function runAiAssistantTurn(
  endpoint: SummaryEndpoint,
  history: AiChatMessage[],
  executeTool: ToolExecutor,
  options: { chat?: ToolChatCompletionFn; signal?: AbortSignal } = {},
): Promise<AiAssistantReplyInternal> {
  const chat = options.chat ?? defaultToolChatCompletion;
  const messages: AiChatMessage[] = [{ role: "system", content: AI_ASSISTANT_SYSTEM_PROMPT }, ...history];
  const sessionKeys: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const { content, toolCalls } = await chat(endpoint, messages, options.signal);

    if (toolCalls.length === 0) {
      return { reply: content.trim(), sessionKeys: dedupe(sessionKeys) };
    }

    // Record the assistant's tool-call turn so the next round has context.
    messages.push({ role: "assistant", content, toolCalls });

    for (const call of toolCalls) {
      const args = parseToolArgs(call.arguments);
      let resultText: string;
      try {
        const execution = await executeTool(call.name, args);
        for (const key of execution.sessionKeys) sessionKeys.push(key);
        resultText = JSON.stringify(execution.result);
      } catch (error) {
        resultText = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      }
      messages.push({ role: "tool", content: resultText, toolCallId: call.id, toolName: call.name });
    }
  }

  // Hit the round cap: ask once more for a final answer with tools disabled.
  const final = await chat(endpoint, [...messages, { role: "user", content: "Summarize what you found so far." }], options.signal);
  return { reply: final.content.trim(), sessionKeys: dedupe(sessionKeys) };
}

// Endpoints that run a local CLI (`codex exec` / `claude`) cannot use our HTTP
// function-calling protocol — they are one-shot text completions. For those we
// fall back to a degraded flow: search the store with the user's own words, then
// ask the CLI to write a natural-language answer grounded in the results.
export function isLocalCliEndpoint(endpoint: SummaryEndpoint): boolean {
  return endpoint.apiFormat === "codex_exec" || endpoint.apiFormat === "claude_exec";
}

// A session hit handed to the fallback so it can be described to the CLI and
// surfaced as a clickable card.
export interface FallbackSessionHit {
  sessionKey: string;
  title: string;
  source: string;
  project: string;
  summary: string | null;
}

// Injected by the caller: runs a keyword search against the store and returns
// the hits (already shaped for the prompt + cards).
export type FallbackSearchFn = (query: string) => Promise<FallbackSessionHit[]>;

// A plain (no-tools) completion. Defaults to the summarizer's completion, which
// already routes codex_exec / claude_exec / HTTP formats.
export type PlainCompletionFn = (endpoint: SummaryEndpoint, messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

const FALLBACK_SYSTEM_PROMPT =
  "You help a developer find a past AI-coding session. You are given the user's request and a list of candidate " +
  "sessions already retrieved from their local history (each with an index, title, source, project, and summary). " +
  "Pick the best matches, answer briefly in the same language the user wrote in, and refer to sessions by their " +
  "title. If none fit, say so and suggest different keywords. Do not invent sessions.";

// One-shot CLIs (codex exec / claude) cannot do HTTP function calling, so the
// model never gets to pick search terms itself. To approximate the tool-calling
// path we run a bounded search loop: ask the CLI for keywords, run the FTS
// search, and — if nothing matched — ask it for *different* keywords and try
// again, up to MAX_FALLBACK_SEARCH_ROUNDS times. Only the search tool is
// exposed (no get_session etc.), keeping the protocol simple and predictable.
const KEYWORD_EXTRACTION_SYSTEM_PROMPT =
  "You convert a developer's natural-language request into search keywords for a full-text search over their past " +
  "AI-coding sessions. Output ONLY the keywords, space-separated, on a single line — no quotes, no explanation, no " +
  "punctuation. Keep concrete nouns, technical terms, file names, error messages, and identifiers; drop filler " +
  "words, pronouns, and conversational phrasing (e.g. 'find the session where I', 'help me look for'). Preserve the " +
  "user's language. Return at most 8 keywords.";

// How many keyword/search attempts the CLI fallback gets. The first round uses
// the user's request; later rounds ask for alternative keywords after a miss.
const MAX_FALLBACK_SEARCH_ROUNDS = 3;

// Pulls the latest user message verbatim. Used as the grounding context and as
// the fallback query when keyword extraction yields nothing useful.
export function extractFallbackQuery(history: readonly AiChatMessage[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].role === "user") return history[i].content.trim();
  }
  return "";
}

// Single-line cleanup of whatever the CLI returns: collapse whitespace, strip
// surrounding quotes/punctuation noise, and cap length so a chatty model can't
// poison the FTS query.
function sanitizeKeywords(raw: string): string {
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// Asks the CLI to distill the request into keywords. `previousAttempts` lists
// keyword sets that already returned nothing, so the model is told to try
// different terms on a retry. On any failure (or empty result) it returns the
// verbatim request so search still runs.
export async function extractFallbackKeywords(
  endpoint: SummaryEndpoint,
  history: readonly AiChatMessage[],
  complete: PlainCompletionFn,
  options: { previousAttempts?: readonly string[]; signal?: AbortSignal } = {},
): Promise<string> {
  const request = extractFallbackQuery(history);
  if (!request) return "";
  const previousAttempts = options.previousAttempts ?? [];
  const userContent = previousAttempts.length
    ? `Request: ${request}\n\nThese keyword sets already returned NO results, so avoid them and try different ` +
      `terms (synonyms, broader or more specific words):\n${previousAttempts.map((a) => `- ${a}`).join("\n")}`
    : request;
  try {
    const raw = await complete(
      endpoint,
      [
        { role: "system", content: KEYWORD_EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      options.signal,
    );
    const keywords = sanitizeKeywords(raw);
    return keywords || request;
  } catch {
    // Extraction is best-effort; never let it break the actual search.
    return request;
  }
}

export async function runAiAssistantFallback(
  endpoint: SummaryEndpoint,
  history: AiChatMessage[],
  search: FallbackSearchFn,
  options: { complete?: PlainCompletionFn; signal?: AbortSignal } = {},
): Promise<AiAssistantReplyInternal> {
  const complete = options.complete ?? requestSummaryCompletion;
  const request = extractFallbackQuery(history);

  // Bounded keyword/search loop: keep trying different keywords until we get
  // hits or run out of rounds. Only the search tool is exposed here.
  const attempts: string[] = [];
  let hits: FallbackSessionHit[] = [];
  if (request) {
    for (let round = 0; round < MAX_FALLBACK_SEARCH_ROUNDS; round += 1) {
      const query = await extractFallbackKeywords(endpoint, history, complete, {
        previousAttempts: attempts,
        signal: options.signal,
      });
      if (!query || attempts.includes(query)) break; // nothing new to try
      attempts.push(query);
      hits = await search(query);
      if (hits.length > 0) break;
    }
  }

  const usedKeywords = attempts.join(" | ") || request;
  const catalog = hits
    .map((hit, index) => {
      const summary = hit.summary ? ` — ${hit.summary}` : "";
      return `[${index + 1}] ${hit.title} (source: ${hit.source}; project: ${hit.project || "n/a"})${summary}`;
    })
    .join("\n");

  const userPrompt = hits.length
    ? `User request: ${request}\n\nSearched with keywords: ${usedKeywords}\n\nCandidate sessions:\n${catalog}\n\nWhich of these best match, and why?`
    : `User request: ${request}\n\nTried these keyword sets: ${usedKeywords}\n\nNo sessions matched any of them in the local history.`;

  const reply = await complete(
    endpoint,
    [
      { role: "system", content: FALLBACK_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    options.signal,
  );

  return { reply: reply.trim(), sessionKeys: dedupe(hits.map((hit) => hit.sessionKey)) };
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function dedupe(keys: string[]): string[] {
  return [...new Set(keys)];
}

// ---------------------------------------------------------------------------
// Transport: OpenAI and Anthropic with tool support.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 60_000;

function defaultToolChatCompletion(
  endpoint: SummaryEndpoint,
  messages: AiChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: AiToolCall[] }> {
  return endpoint.apiFormat === "anthropic"
    ? anthropicToolCompletion(endpoint, messages, signal)
    : openaiToolCompletion(endpoint, messages, signal);
}

export const requestAssistantCompletion: ToolChatCompletionFn = defaultToolChatCompletion;

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
      throw new Error(`AI assistant request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw error;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "";
  }
}

// --- OpenAI /chat/completions with tools ---

function openaiTools(): unknown[] {
  return AI_TOOL_SCHEMAS.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function toOpenAiMessages(messages: AiChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

async function openaiToolCompletion(
  endpoint: SummaryEndpoint,
  messages: AiChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: AiToolCall[] }> {
  const request = (includeTemperature: boolean) =>
    postJson(
      `${endpoint.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${endpoint.apiKey}` },
      { model: endpoint.model, messages: toOpenAiMessages(messages), tools: openaiTools(), ...(includeTemperature ? { temperature: 0.2 } : {}), stream: false },
      signal,
    );
  let response = await request(true);
  if (!response.ok) {
    const detail = await safeReadText(response);
    if (isTemperatureUnsupported(response.status, detail)) {
      response = await request(false);
    } else {
      throw new Error(`AI assistant request failed (HTTP ${response.status}). ${detail}`.trim());
    }
  }
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI assistant request failed (HTTP ${response.status}). ${detail}`.trim());
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
  };
  const message = data.choices?.[0]?.message;
  const toolCalls: AiToolCall[] = (message?.tool_calls ?? [])
    .map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }))
    .filter((call) => call.name);
  return { content: typeof message?.content === "string" ? message.content : "", toolCalls };
}

// --- Anthropic /v1/messages with tools ---

function anthropicTools(): unknown[] {
  return AI_TOOL_SCHEMAS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

// Anthropic keeps system separate and uses content blocks; tool results go in a
// `user` message as tool_result blocks, tool calls in `assistant` as tool_use.
function toAnthropicMessages(messages: AiChatMessage[]): { system: string; messages: unknown[] } {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }],
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseToolArgs(call.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return { system, messages: out };
}

async function anthropicToolCompletion(
  endpoint: SummaryEndpoint,
  messages: AiChatMessage[],
  signal?: AbortSignal,
): Promise<{ content: string; toolCalls: AiToolCall[] }> {
  const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
  const response = await postJson(
    `${endpoint.baseUrl}/v1/messages`,
    { "x-api-key": endpoint.apiKey, Authorization: `Bearer ${endpoint.apiKey}`, "anthropic-version": "2023-06-01" },
    { model: endpoint.model, max_tokens: 1024, system, messages: anthropicMessages, tools: anthropicTools() },
    signal,
  );
  if (!response.ok) {
    const detail = await safeReadText(response);
    throw new Error(`AI assistant request failed (HTTP ${response.status}). ${detail}`.trim());
  }
  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
  };
  const blocks = Array.isArray(data.content) ? data.content : [];
  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const toolCalls: AiToolCall[] = blocks
    .filter((block) => block.type === "tool_use" && block.name)
    .map((block, index) => ({
      id: block.id || `call_${index}`,
      name: block.name ?? "",
      arguments: JSON.stringify(block.input ?? {}),
    }));
  return { content: text, toolCalls };
}
