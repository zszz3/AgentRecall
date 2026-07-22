import { createReadStream, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

export type CodexRequestFidelity = "exact-trace" | "reconstructed" | "normalized";

export interface CodexRequestExport {
  body: Record<string, unknown>;
  fidelity: CodexRequestFidelity;
}

interface TraceCandidate {
  body: Record<string, unknown>;
  timestamp: number;
}

export async function resolveCodexResponsesRequest(options: {
  filePath: string;
  rawId: string;
  traceRoot?: string;
}): Promise<CodexRequestExport | null> {
  const exact = options.traceRoot ? await findLatestCodexTraceRequest(options.traceRoot, options.rawId) : null;
  if (exact) return { body: exact, fidelity: "exact-trace" };
  const reconstructed = await reconstructCodexResponsesRequest(options.filePath);
  return reconstructed ? { body: reconstructed, fidelity: "reconstructed" } : null;
}

export async function findLatestCodexTraceRequest(traceRoot: string, threadId: string): Promise<Record<string, unknown> | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(traceRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let latest: TraceCandidate | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("trace-")) continue;
    const bundlePath = path.join(traceRoot, entry.name);
    const eventLogPath = path.join(bundlePath, "trace.jsonl");
    try {
      for await (const event of readJsonObjects(eventLogPath)) {
        const payload = objectField(event, "payload");
        if (!payload || payload.type !== "inference_started" || payload.thread_id !== threadId) continue;
        const requestPayload = objectField(payload, "request_payload");
        const relativePath = requestPayload && typeof requestPayload.path === "string" ? requestPayload.path : "";
        const payloadPath = await resolveBundlePath(bundlePath, relativePath);
        if (!payloadPath) continue;
        const body = await readJsonObject(payloadPath);
        if (!body) continue;
        const timestamp = typeof event.wall_time_unix_ms === "number" ? event.wall_time_unix_ms : 0;
        if (!latest || timestamp >= latest.timestamp) latest = { body, timestamp };
      }
    } catch {
      continue;
    }
  }
  return latest?.body ?? null;
}

export async function reconstructCodexResponsesRequest(filePath: string): Promise<Record<string, unknown> | null> {
  let sessionMeta: Record<string, unknown> | null = null;
  let turnContext: Record<string, unknown> | null = null;
  let input: unknown[] = [];
  const compactionSummaries = new Set<string>();
  try {
    for await (const row of readJsonObjects(filePath)) {
      const payload = objectField(row, "payload");
      if (row.type === "session_meta" && payload) {
        sessionMeta = payload;
      } else if (row.type === "turn_context" && payload) {
        turnContext = payload;
      } else if (row.type === "response_item" && payload && isRequestInputItem(payload)) {
        input.push(payload);
      } else if (row.type === "compacted" && payload) {
        const replacement = Array.isArray(payload.replacement_history) ? payload.replacement_history : null;
        const summary = typeof payload.message === "string" ? payload.message.trim() : "";
        if (replacement) {
          input = replacement.filter(isRequestInputItem);
        } else if (summary) {
          input = input.filter((item) => isRetainedCompactionUserMessage(item, compactionSummaries));
          input.push({ type: "message", role: "user", content: [{ type: "input_text", text: summary }] });
        }
        if (summary) compactionSummaries.add(summary);
      }
    }
  } catch {
    return null;
  }
  if (!sessionMeta && !turnContext && input.length === 0) return null;

  const model = stringField(turnContext, "model") || "YOUR_MODEL";
  const sessionId = stringField(sessionMeta, "session_id") || stringField(sessionMeta, "id");
  const threadId = stringField(sessionMeta, "id") || sessionId;
  const instructions = baseInstructionsText(sessionMeta?.base_instructions);
  const tools = reconstructedTools(sessionMeta?.dynamic_tools, input);
  const reasoning = reconstructedReasoning(turnContext);
  const clientMetadata: Record<string, string> = {};
  if (sessionId) clientMetadata.session_id = sessionId;
  if (threadId) clientMetadata.thread_id = threadId;
  const turnId = stringField(turnContext, "turn_id");
  if (turnId) clientMetadata.turn_id = turnId;

  return {
    model,
    ...(instructions ? { instructions } : {}),
    input,
    tools,
    tool_choice: "auto",
    ...(reasoning ? { reasoning } : {}),
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    ...(sessionId ? { prompt_cache_key: sessionId } : {}),
    ...(Object.keys(clientMetadata).length > 0 ? { client_metadata: clientMetadata } : {}),
  };
}

function reconstructedReasoning(turnContext: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!turnContext) return null;
  const effort = stringField(turnContext, "effort");
  const summary = stringField(turnContext, "summary");
  if (!effort && !summary) return null;
  return { ...(effort ? { effort } : {}), ...(summary && summary !== "none" ? { summary } : {}) };
}

function reconstructedTools(dynamicTools: unknown, input: unknown[]): unknown[] {
  const tools: Record<string, unknown>[] = [];
  const knownNames = new Set<string>();
  for (const raw of Array.isArray(dynamicTools) ? dynamicTools : []) {
    for (const tool of responseToolsFromDynamic(raw)) {
      tools.push(tool);
      collectResponseToolKeys(tool, knownNames);
    }
  }
  for (const item of input) {
    if (!isObject(item) || typeof item.name !== "string") continue;
    if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
    const namespace = typeof item.namespace === "string" ? item.namespace : "";
    const key = responseToolKey(namespace, item.name);
    if (knownNames.has(key)) continue;
    knownNames.add(key);
    if (item.type === "custom_tool_call") {
      tools.push({
        type: "custom",
        name: item.name,
        ...(namespace ? { namespace } : {}),
        description: "Reconstructed from recorded custom tool calls; the original format was not persisted.",
      });
    } else {
      tools.push({
        type: "function",
        name: item.name,
        ...(namespace ? { namespace } : {}),
        description: "Reconstructed from recorded tool calls; the original description was not persisted.",
        strict: false,
        parameters: { type: "object", additionalProperties: true },
      });
    }
  }
  return tools;
}

function collectResponseToolKeys(tool: Record<string, unknown>, keys: Set<string>, namespace = ""): void {
  if (tool.type === "namespace" && typeof tool.name === "string") {
    const childNamespace = namespace ? `${namespace}/${tool.name}` : tool.name;
    for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
      if (isObject(child)) collectResponseToolKeys(child, keys, childNamespace);
    }
    return;
  }
  if (typeof tool.name === "string") {
    const explicitNamespace = typeof tool.namespace === "string" ? tool.namespace : namespace;
    keys.add(responseToolKey(explicitNamespace, tool.name));
  }
}

function responseToolKey(namespace: string, name: string): string {
  return namespace ? `${namespace}::${name}` : name;
}

function responseToolsFromDynamic(raw: unknown): Record<string, unknown>[] {
  if (!isObject(raw)) return [];
  const functionSpec = objectField(raw, "Function") ?? objectField(raw, "function");
  if (functionSpec) return [responseFunctionTool(functionSpec)];
  const namespace = objectField(raw, "Namespace") ?? objectField(raw, "namespace");
  if (!namespace) return isDynamicFunction(raw) ? [responseFunctionTool(raw)] : [];
  const namespaceTools = Array.isArray(namespace.tools) ? namespace.tools : [];
  const functions = namespaceTools.flatMap(responseToolsFromDynamic);
  return functions.length > 0
    ? [{ type: "namespace", name: stringField(namespace, "name"), description: stringField(namespace, "description"), tools: functions }]
    : [];
}

function responseFunctionTool(spec: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "function",
    name: stringField(spec, "name"),
    description: stringField(spec, "description"),
    strict: false,
    parameters: spec.inputSchema ?? spec.input_schema ?? { type: "object", additionalProperties: true },
  };
}

function isDynamicFunction(value: Record<string, unknown>): boolean {
  return typeof value.name === "string" && ("inputSchema" in value || "input_schema" in value);
}

function isRequestInputItem(value: unknown): boolean {
  if (!isObject(value) || typeof value.type !== "string") return false;
  return [
    "message",
    "agent_message",
    "reasoning",
    "local_shell_call",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "tool_search_call",
    "tool_search_output",
    "web_search_call",
    "image_generation_call",
    "context_compaction",
  ].includes(value.type);
}

function baseInstructionsText(value: unknown): string {
  if (typeof value === "string") return value;
  return stringField(isObject(value) ? value : null, "text");
}

async function resolveBundlePath(bundlePath: string, relativePath: string): Promise<string | null> {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  try {
    const resolvedBundle = await fs.realpath(bundlePath);
    const resolvedPath = await fs.realpath(path.resolve(bundlePath, relativePath));
    const relative = path.relative(resolvedBundle, resolvedPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const stat = await fs.stat(resolvedPath);
    return stat.isFile() ? resolvedPath : null;
  } catch {
    return null;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

async function* readJsonObjects(filePath: string): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const parsed = parseObject(line);
    if (parsed) yield parsed;
  }
}

function isRetainedCompactionUserMessage(value: unknown, priorSummaries: Set<string>): boolean {
  if (!isObject(value) || value.type !== "message" || value.role !== "user") return false;
  const content = Array.isArray(value.content) ? value.content : [];
  const text = content.flatMap((part) => isObject(part) && typeof part.text === "string" ? [part.text] : []).join("\n").trim();
  return !priorSummaries.has(text);
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
