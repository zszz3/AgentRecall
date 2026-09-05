import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";
import { extractCodexExecToolNames } from "./session-loaders/codex-rollout";
import { sessionSourceDescriptor } from "./session-sources";
import type { SessionFormat, SessionSource } from "./types";

export type ContextComponentKind =
  | "system_instructions"
  | "developer_instructions"
  | "tool_inventory"
  | "skill_listing"
  | "mcp_instructions"
  | "deferred_tools"
  | "agent_listing";

export type ContextComponentFidelity = "full" | "listing";

export interface ContextComponent {
  kind: ContextComponentKind;
  title: string;
  fidelity: ContextComponentFidelity;
  text?: string;
  items?: string[];
  bytes?: number;
  sourceHint?: string;
  note?: string;
}

export type SessionContextComponentsStatus = "ok" | "source_unavailable" | "unsupported";

export interface SessionContextComponents {
  status: SessionContextComponentsStatus;
  source: SessionSource;
  format: SessionFormat | null;
  components: ContextComponent[];
}

const CODEX_SOURCES = new Set(["codex-cli", "codex-app", "stepcode-codex", "tcodex-cli"]);
const CLAUDE_SOURCES = new Set(["claude-cli", "claude-app", "stepcode-claude", "tclaude-cli"]);

const PREVIEW_CHAR_LIMIT = 12_000;
/** Cap payload text so React/IPC never materialize multi‑MB strings. */
const COMPONENT_TEXT_CHAR_LIMIT = 48_000;
/** After session_meta, stop once developer text is capped (late reinjections are truncated). */
const CODEX_DEVELOPER_CHAR_BUDGET = COMPONENT_TEXT_CHAR_LIMIT;

type CacheEntry = {
  mtimeMs: number;
  size: number;
  result: SessionContextComponents;
};

/** Bound cached extractions; evict the least-recently-used entry past this cap. */
const EXTRACT_CACHE_MAX_ENTRIES = 64;

const extractCache = new Map<string, CacheEntry>();

/**
 * On-demand session-level context metadata extracted from the local source
 * file. Does not enter the message index or format-adapters path.
 */
export async function extractSessionContextComponents(options: {
  source: SessionSource;
  filePath: string | null | undefined;
  sourceAvailable?: boolean;
}): Promise<SessionContextComponents> {
  const descriptor = sessionSourceDescriptor(options.source);
  const format = descriptor.format;
  const base: SessionContextComponents = {
    status: "ok",
    source: options.source,
    format,
    components: [],
  };

  if (!CODEX_SOURCES.has(options.source) && !CLAUDE_SOURCES.has(options.source)) {
    return { ...base, status: "unsupported", format };
  }

  if (options.sourceAvailable === false || !options.filePath) {
    return { ...base, status: "source_unavailable" };
  }

  let stat: { mtimeMs: number; size: number; isFile(): boolean };
  try {
    stat = await fs.stat(options.filePath);
    if (!stat.isFile()) return { ...base, status: "source_unavailable" };
  } catch {
    return { ...base, status: "source_unavailable" };
  }

  const cacheKey = `${options.source}\0${options.filePath}`;
  const cached = extractCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Re-insert so a hot session moves to the newest slot and survives eviction.
    extractCache.delete(cacheKey);
    extractCache.set(cacheKey, cached);
    return cached.result;
  }

  try {
    const components = CODEX_SOURCES.has(options.source)
      ? await extractCodexContextComponents(options.filePath)
      : await extractClaudeContextComponents(options.filePath);
    const result = { ...base, components };
    extractCache.set(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, result });
    // Map preserves insertion order, so the first key is the least-recently-used.
    while (extractCache.size > EXTRACT_CACHE_MAX_ENTRIES) {
      const oldest = extractCache.keys().next().value;
      if (oldest === undefined) break;
      extractCache.delete(oldest);
    }
    return result;
  } catch {
    return { ...base, status: "source_unavailable" };
  }
}

export async function extractCodexContextComponents(filePath: string): Promise<ContextComponent[]> {
  let sessionMeta: Record<string, unknown> | null = null;
  const developerTexts: string[] = [];
  const toolNames = new Set<string>();
  let developerChars = 0;
  let toolsFromDynamic = false;
  let toolsFromCalls = false;

  for await (const row of readJsonObjects(filePath, isCodexContextLine)) {
    const payload = objectField(row, "payload");
    if (row.type === "session_meta" && payload) {
      sessionMeta = payload;
      const dynamicNames = toolNamesFromDynamic(payload.dynamic_tools);
      if (dynamicNames.length > 0) toolsFromDynamic = true;
      for (const name of dynamicNames) toolNames.add(name);
      continue;
    }

    if ((row.type === "response_item" || row.type === "event_msg" || row.type === "item_completed") && payload) {
      const callNames = toolNamesFromCallPayload(payload, row.type);
      if (callNames.length > 0) {
        toolsFromCalls = true;
        for (const name of callNames) toolNames.add(name);
        continue;
      }
    }

    if (row.type !== "response_item" || !payload || payload.type !== "message") continue;
    // Keep scanning for tool calls after the developer budget is full — modern
    // Codex rollouts often omit session_meta.dynamic_tools entirely.
    if (developerChars >= CODEX_DEVELOPER_CHAR_BUDGET) continue;
    const role = typeof payload.role === "string" ? payload.role : "";
    if (role !== "developer" && role !== "system") continue;
    const text = messageText(payload.content).trim();
    if (!text) continue;
    developerTexts.push(text);
    developerChars += text.length;
  }

  const components: ContextComponent[] = [];
  const baseInstructions = clampComponentText(baseInstructionsText(sessionMeta?.base_instructions).trim());
  if (baseInstructions.text) {
    components.push({
      kind: "system_instructions",
      title: "系统提示词",
      fidelity: "full",
      text: baseInstructions.text,
      bytes: Buffer.byteLength(baseInstructions.text, "utf8"),
      sourceHint: "session_meta.base_instructions",
      ...(baseInstructions.truncated
        ? { note: `全文过长，已截断至约 ${COMPONENT_TEXT_CHAR_LIMIT} 字符。` }
        : {}),
    });
  }

  if (developerTexts.length > 0) {
    const joinedRaw = developerTexts.map((text, index) =>
      developerTexts.length === 1 ? text : `—— Developer #${index + 1} ——\n${text}`,
    ).join("\n\n");
    const joined = clampComponentText(joinedRaw);
    components.push({
      kind: "developer_instructions",
      title: "Developer 提示词",
      fidelity: "full",
      text: joined.text,
      items: developerTexts.map((_, index) => `Developer #${index + 1}`),
      bytes: Buffer.byteLength(joined.text, "utf8"),
      sourceHint: "response_item role=developer|system",
      note: joined.truncated
        ? "由 harness 注入（Memory、权限、multi-agent 等），不是用户提示词。用户提示词见下方对话中的 User 消息。全文过长，已截断。"
        : "由 harness 注入（Memory、权限、multi-agent 等），不是用户提示词。用户提示词见下方对话中的 User 消息。",
    });
  }

  const tools = [...toolNames].sort((a, b) => a.localeCompare(b));
  if (tools.length > 0) {
    const sourceHint = toolsFromDynamic && toolsFromCalls
      ? "session_meta.dynamic_tools + tool calls"
      : toolsFromDynamic
        ? "session_meta.dynamic_tools"
        : "response_item/event_msg/item_completed tool calls";
    components.push({
      kind: "tool_inventory",
      title: "工具清单",
      fidelity: "listing",
      items: tools,
      sourceHint,
      ...(!toolsFromDynamic && toolsFromCalls
        ? { note: "由本会话中实际出现的 tool call 反推；未调用过的工具不会出现在此清单。" }
        : {}),
    });
  }

  return components;
}

export async function extractClaudeContextComponents(filePath: string): Promise<ContextComponent[]> {
  const skillContents: string[] = [];
  const skillNames = new Set<string>();
  const mcpNames = new Set<string>();
  const mcpBlocks: string[] = [];
  const deferredTools = new Set<string>();
  const agentTypes = new Set<string>();
  const agentLines: string[] = [];

  for await (const row of readJsonObjects(filePath, isClaudeContextLine)) {
    if (row.type !== "attachment") continue;
    const attachment = objectField(row, "attachment") ?? row;
    const type = typeof attachment.type === "string" ? attachment.type : "";

    if (type === "skill_listing") {
      const content = typeof attachment.content === "string" ? attachment.content.trim() : "";
      if (content) {
        skillContents.push(content);
        for (const name of skillNamesFromListing(content)) skillNames.add(name);
      }
      continue;
    }

    if (type === "mcp_instructions_delta") {
      for (const name of stringArray(attachment.addedNames)) mcpNames.add(name);
      for (const block of stringArray(attachment.addedBlocks)) {
        const trimmed = block.trim();
        if (trimmed) mcpBlocks.push(trimmed);
      }
      continue;
    }

    if (type === "deferred_tools_delta") {
      for (const name of stringArray(attachment.addedNames)) deferredTools.add(name);
      continue;
    }

    if (type === "agent_listing_delta") {
      for (const name of stringArray(attachment.addedTypes)) agentTypes.add(name);
      for (const line of stringArray(attachment.addedLines)) {
        const trimmed = line.trim();
        if (trimmed) agentLines.push(trimmed);
      }
    }
  }

  const components: ContextComponent[] = [];

  if (skillContents.length > 0 || skillNames.size > 0) {
    const clamped = clampComponentText(skillContents.join("\n\n").trim());
    components.push({
      kind: "skill_listing",
      title: "Skills 清单",
      fidelity: clamped.text ? "full" : "listing",
      ...(clamped.text ? { text: clamped.text, bytes: Buffer.byteLength(clamped.text, "utf8") } : {}),
      ...(skillNames.size > 0 ? { items: [...skillNames].sort((a, b) => a.localeCompare(b)) } : {}),
      sourceHint: "attachment.skill_listing",
      ...(clamped.truncated ? { note: `全文过长，已截断至约 ${COMPONENT_TEXT_CHAR_LIMIT} 字符。` } : {}),
    });
  }

  if (mcpNames.size > 0 || mcpBlocks.length > 0) {
    const clamped = clampComponentText(mcpBlocks.join("\n\n").trim());
    components.push({
      kind: "mcp_instructions",
      title: "MCP 说明",
      fidelity: clamped.text ? "full" : "listing",
      ...(clamped.text ? { text: clamped.text, bytes: Buffer.byteLength(clamped.text, "utf8") } : {}),
      ...(mcpNames.size > 0 ? { items: [...mcpNames].sort((a, b) => a.localeCompare(b)) } : {}),
      sourceHint: "attachment.mcp_instructions_delta",
      ...(clamped.truncated ? { note: `全文过长，已截断至约 ${COMPONENT_TEXT_CHAR_LIMIT} 字符。` } : {}),
    });
  }

  if (deferredTools.size > 0) {
    components.push({
      kind: "deferred_tools",
      title: "延迟加载工具",
      fidelity: "listing",
      items: [...deferredTools].sort((a, b) => a.localeCompare(b)),
      sourceHint: "attachment.deferred_tools_delta",
    });
  }

  if (agentTypes.size > 0 || agentLines.length > 0) {
    const clamped = clampComponentText(agentLines.join("\n").trim());
    components.push({
      kind: "agent_listing",
      title: "Agent 清单",
      fidelity: clamped.text ? "full" : "listing",
      ...(clamped.text ? { text: clamped.text, bytes: Buffer.byteLength(clamped.text, "utf8") } : {}),
      ...(agentTypes.size > 0 ? { items: [...agentTypes].sort((a, b) => a.localeCompare(b)) } : {}),
      sourceHint: "attachment.agent_listing_delta",
      ...(clamped.truncated ? { note: `全文过长，已截断至约 ${COMPONENT_TEXT_CHAR_LIMIT} 字符。` } : {}),
    });
  }

  return components;
}

export function truncateContextText(text: string, limit = PREVIEW_CHAR_LIMIT): {
  preview: string;
  truncated: boolean;
} {
  if (text.length <= limit) return { preview: text, truncated: false };
  return { preview: `${text.slice(0, limit)}\n…`, truncated: true };
}

function clampComponentText(text: string, limit = COMPONENT_TEXT_CHAR_LIMIT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…`, truncated: true };
}

function isCodexContextLine(line: string): boolean {
  // Cheap reject before JSON.parse — most rollout lines are tool/assistant noise.
  return line.includes("session_meta")
    || line.includes("\"developer\"")
    || line.includes("\"system\"")
    || line.includes("function_call")
    || line.includes("custom_tool_call")
    || line.includes("mcp_tool_call")
    || line.includes("DynamicToolCall")
    || line.includes("dynamic_tool_call");
}

function isClaudeContextLine(line: string): boolean {
  return line.includes("attachment")
    && (
      line.includes("skill_listing")
      || line.includes("mcp_instructions_delta")
      || line.includes("deferred_tools_delta")
      || line.includes("agent_listing_delta")
    );
}

function baseInstructionsText(value: unknown): string {
  if (typeof value === "string") return value;
  return stringField(isObject(value) ? value : null, "text");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!isObject(item)) continue;
    if (typeof item.text === "string" && item.text) parts.push(item.text);
  }
  return parts.join("\n");
}

function toolNamesFromDynamic(dynamicTools: unknown): string[] {
  const names: string[] = [];
  if (!Array.isArray(dynamicTools)) return names;
  for (const raw of dynamicTools) {
    collectDynamicToolNames(raw, names);
  }
  return names;
}

/** Infer tool names from response_item payloads when dynamic_tools is absent. */
function toolNamesFromCallPayload(payload: Record<string, unknown>, rowType = ""): string[] {
  const type = typeof payload.type === "string" ? payload.type : rowType;
  if (type === "function_call" || type === "custom_tool_call" || type === "tool_call") {
    const name = stringField(payload, "name").trim();
    const names = name ? [name] : [];
    if (type === "custom_tool_call" && name === "exec") {
      names.push(...extractCodexExecToolNames(payload.input).map((tool) => tool.replaceAll("__", ".")));
    }
    return names;
  }
  if (type === "mcp_tool_call" || type === "mcp_tool_call_end") {
    const invocation = objectField(payload, "invocation");
    if (!invocation) return [];
    const server = stringField(invocation, "server").trim();
    const tool = stringField(invocation, "tool").trim();
    if (server && tool) return [`${server}/${tool}`];
    return tool || server ? [tool || server] : [];
  }
  if (type === "item_completed") {
    const rawItem = objectField(payload, "item");
    if (!rawItem) return [];
    let item = rawItem;
    let itemType = stringField(item, "type").replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase();
    if (!itemType) {
      for (const [key, value] of Object.entries(rawItem)) {
        if (!isObject(value)) continue;
        item = value;
        itemType = key.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase();
        break;
      }
    }
    if (itemType !== "dynamictoolcall") return [];
    const tool = stringField(item, "tool").trim();
    const names = tool ? [tool] : [];
    if (tool === "exec") {
      names.push(...extractCodexExecToolNames(item.arguments).map((name) => name.replaceAll("__", ".")));
    }
    return names;
  }
  return [];
}

function collectDynamicToolNames(raw: unknown, names: string[]): void {
  if (!isObject(raw)) return;
  const functionSpec = objectField(raw, "Function") ?? objectField(raw, "function");
  if (functionSpec) {
    const name = stringField(functionSpec, "name");
    if (name) names.push(name);
    return;
  }
  const namespace = objectField(raw, "Namespace") ?? objectField(raw, "namespace");
  if (namespace) {
    const nested = Array.isArray(namespace.tools) ? namespace.tools : [];
    for (const child of nested) collectDynamicToolNames(child, names);
    return;
  }
  const name = stringField(raw, "name");
  if (name && ("inputSchema" in raw || "input_schema" in raw)) names.push(name);
}

function skillNamesFromListing(content: string): string[] {
  const names = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^[-*]\s+`?\/?([A-Za-z0-9][\w.-]*)`?(?:\s*[:：-]|$)/)
      || trimmed.match(/^`?\/([A-Za-z0-9][\w.-]*)`?(?:\s*[:：-]|$)/);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function* readJsonObjects(
  filePath: string,
  shouldParse: (line: string) => boolean = () => true,
): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  try {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!shouldParse(line)) continue;
      const parsed = parseObject(line);
      if (parsed) yield parsed;
    }
  } finally {
    input.destroy();
  }
}

function parseObject(line: string): Record<string, unknown> | null {
  if (!line.trim()) return null;
  try {
    const value = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  return isObject(value) && isObject(value[key]) ? value[key] : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string {
  const field = value?.[key];
  return typeof field === "string" ? field : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
