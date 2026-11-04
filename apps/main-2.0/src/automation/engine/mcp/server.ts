import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestLocalSessionBackend } from "../../../main/session-backend-client";

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: unknown;
}

const TOOL_ROUTES: Record<string, string> = {
  search_tools: "/mcp/gateway/tools/search",
  get_tool: "/mcp/gateway/tools/get",
  call_tool: "/mcp/gateway/tools/call",
  list_skills: "/mcp/gateway/skills/list",
  get_skill: "/mcp/gateway/skills/get",
  search_resources: "/mcp/gateway/resources/search",
  get_resource: "/mcp/gateway/resources/get",
  search_sessions: "/mcp/gateway/sessions/search",
  get_session: "/mcp/gateway/sessions/get",
};

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

export function mcpToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "search_tools",
      description: "分页浏览 AgentRecall 中已开放的索引工具。可通过 sourceId 只查看某个内置或第三方 MCP 工具源；结果仅包含简要索引，完整参数请调用 get_tool。",
      inputSchema: objectSchema({
        sourceId: { type: "string", description: "可选的工具源 ID；省略时浏览全部已开放索引工具。" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        cursor: { type: "string", description: "上一页返回的 nextCursor。" },
      }),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_tool",
      description: "根据 search_tools 返回的 toolRef 读取一个工具的完整说明和输入参数 Schema。",
      inputSchema: objectSchema({ toolRef: { type: "string", minLength: 1 } }, ["toolRef"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "call_tool",
      description: "调用已通过 AgentRecall MCP 页面启用的索引工具。先用 search_tools 获取 toolRef，再用 get_tool 查看参数。",
      inputSchema: objectSchema({
        toolRef: { type: "string", minLength: 1 },
        arguments: { type: "object", additionalProperties: true },
      }, ["toolRef"]),
    },
    {
      name: "list_skills",
      description: "列出 AgentRecall 已管理的 Skill 简要索引；需要完整说明时再调用 get_skill。",
      inputSchema: objectSchema({}),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_skill",
      description: "根据 list_skills 返回的 managedId 读取一个 Skill 的完整 Markdown 说明。",
      inputSchema: objectSchema({ managedId: { type: "string", minLength: 1 } }, ["managedId"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "search_sessions",
      description: "查找过去如何解决问题，返回会话摘要、sessionKey 和团队命中轮次；使用 get_session 读取。",
      inputSchema: objectSchema({
        query: { type: "string", maxLength: 1000 },
        scope: { type: "string", enum: ["local", "team"], default: "local" },
        teamId: { type: "string", description: "团队范围必填；本机范围不填。" },
        page: { type: "integer", minimum: 1, maximum: 4000, description: "仅团队支持分页，每页 50 项。" },
        includeTools: { type: "boolean", description: "仅团队：搜索工具输出，默认关闭。" },
        source: { type: "string" },
        project: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "本机结果数；团队固定每页 50 项。" },
      }),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_session",
      description: "读取搜索返回的会话。本机会话按消息分页；团队会话默认列出轮次，再传 turnId 读取单轮。",
      inputSchema: objectSchema({
        record: { type: "integer", minimum: 0, maximum: 127, description: "团队分享中的会话序号，默认 0；可用命中的 record。" },
        turnId: { type: "string", description: "团队轮次 ID，从搜索命中或轮次列表获得。" },
        sessionKey: { type: "string", minLength: 1 },
        maxMessages: { type: "integer", minimum: 1, maximum: 200 },
        offset: { type: "integer", minimum: 0 },
      }, ["sessionKey"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "search_resources",
      description: "查找可复用的 Skill、文档和共享指令，返回摘要和 id；使用 get_resource 读取正文。",
      inputSchema: objectSchema({
        query: { type: "string", minLength: 1, maxLength: 1000 },
        scope: { type: "string", enum: ["local", "team"], default: "local", description: "local 搜托管 Skills；team 搜本地团队工作副本。" },
        teamId: { type: "string", description: "团队范围必填。" },
        type: { type: "string", enum: ["skill", "document", "instruction"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        offset: { type: "integer", minimum: 0, maximum: 200000 },
      }, ["query"]),
      annotations: { readOnlyHint: true },
    },
    {
      name: "get_resource",
      description: "按资源搜索结果的 id、type 和范围读取正文；nextOffset 非空时可继续分页。",
      inputSchema: objectSchema({
        id: { type: "string", minLength: 1 }, type: { type: "string", enum: ["skill", "document", "instruction"] },
        scope: { type: "string", enum: ["local", "team"], default: "local" }, teamId: { type: "string" },
        offset: { type: "integer", minimum: 0, maximum: 2000000 },
        maxChars: { type: "integer", minimum: 1, maximum: 32000, default: 8000 },
      }, ["id", "type"]),
      annotations: { readOnlyHint: true },
    },
  ];
}

export function resolveBridgeDiscoveryPath(): string {
  if (process.env.AGENT_RECALL_MCP_BRIDGE) return process.env.AGENT_RECALL_MCP_BRIDGE;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "agent-recall-v2", "automation-mcp-bridge.json");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "agent-recall-v2", "automation-mcp-bridge.json");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-recall-v2", "automation-mcp-bridge.json");
}

async function readBridgeDiscovery(): Promise<{ host: string; port: number; token: string }> {
  const discoveryPath = resolveBridgeDiscoveryPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(discoveryPath, "utf8")) as unknown;
  } catch {
    throw new Error("AgentRecall is not running. Open the desktop app first, then retry this tool call.");
  }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  if (typeof record.host !== "string" || typeof record.port !== "number" || typeof record.token !== "string") {
    throw new Error("AgentRecall MCP bridge discovery file is invalid.");
  }
  return {
    host: record.host,
    port: record.port,
    token: record.token,
  };
}

export async function callMcpTool(name: string, args: unknown): Promise<unknown> {
  const route = TOOL_ROUTES[name];
  if (!route) throw new Error(`Unknown MCP tool: ${name}`);
  const body = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if ((name === "search_sessions" || name === "get_session") && body.scope !== "team"
    && !(typeof body.sessionKey === "string" && body.sessionKey.startsWith("shared:"))) {
    return requestLocalSessionBackend(name === "search_sessions" ? "search" : "get", body);
  }
  const discovery = await readBridgeDiscovery();
  const response = await fetch(`http://${discovery.host}:${discovery.port}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${discovery.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) throw new Error(`MCP bridge request failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

interface StdioServerLifecycle {
  beginRequest(): void;
  endRequest(): void;
  beginStdoutWrite(): (() => void) | null;
}

let activeStdioServer: StdioServerLifecycle | null = null;

function writeJsonRpc(payload: unknown): void {
  const line = `${JSON.stringify(payload)}\n`;
  // Pipe writes are asynchronous; only count a response as delivered once its
  // write callback fires, so shutdown never truncates the last response.
  const finishWrite = activeStdioServer?.beginStdoutWrite();
  if (finishWrite) process.stdout.write(line, finishWrite);
  else process.stdout.write(line);
}

async function handleJsonRpc(request: JsonRpcRequest): Promise<void> {
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "agent-recall",
            version: "0.1.0",
          },
        },
      });
      return;
    }
    if (request.method === "tools/list") {
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: mcpToolDefinitions() },
      });
      return;
    }
    if (request.method === "tools/call") {
      const params = request.params && typeof request.params === "object" ? (request.params as Record<string, unknown>) : {};
      const name = typeof params.name === "string" ? params.name : "";
      const result = await callMcpTool(name, params.arguments ?? {});
      const resultRecord = result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined;
      const isError = resultRecord?.isError === true
        || Boolean(resultRecord && "ok" in resultRecord && !resultRecord.ok);
      writeJsonRpc({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError,
        },
      });
      return;
    }
    writeJsonRpc({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method}` } });
  } catch (error) {
    writeJsonRpc({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

const STDIO_MCP_SHUTDOWN_DRAIN_MS = 5_000;

export interface StdioMcpServerOptions {
  stdin?: NodeJS.ReadableStream & { readableEnded: boolean; destroyed: boolean };
  stdout?: NodeJS.WritableStream;
  signalTarget?: { on(signal: NodeJS.Signals, listener: () => void): unknown };
  exit?: (code: number) => void;
  drainMs?: number;
}

function shutdownDrainMsFromEnvironment(): number {
  const raw = process.env.AGENT_RECALL_MCP_SHUTDOWN_DRAIN_MS?.trim();
  if (!raw) return STDIO_MCP_SHUTDOWN_DRAIN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : STDIO_MCP_SHUTDOWN_DRAIN_MS;
}

export function startStdioMcpServer(options: StdioMcpServerOptions = {}): void {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const signalTarget = options.signalTarget ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const drainMs = options.drainMs ?? shutdownDrainMsFromEnvironment();
  let buffer = "";
  let inFlightRequests = 0;
  let pendingStdoutWrites = 0;
  let shutdownReason: string | null = null;
  let exited = false;
  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const settle = () => {
    if (shutdownReason !== null && inFlightRequests <= 0 && pendingStdoutWrites <= 0) exitOnce(0);
  };
  const shutdown = (reason: string) => {
    if (shutdownReason !== null) return;
    shutdownReason = reason;
    if (inFlightRequests <= 0 && pendingStdoutWrites <= 0) {
      exitOnce(0);
      return;
    }
    // The host is already gone; give in-flight requests a bounded window to
    // flush their last responses, then stop instead of leaking the process.
    const drainTimer = setTimeout(() => exitOnce(0), drainMs);
    drainTimer.unref();
  };
  const lifecycle: StdioServerLifecycle = {
    beginRequest: () => {
      inFlightRequests += 1;
    },
    endRequest: () => {
      inFlightRequests -= 1;
      settle();
    },
    beginStdoutWrite: () => {
      pendingStdoutWrites += 1;
      return () => {
        pendingStdoutWrites -= 1;
        settle();
      };
    },
  };
  activeStdioServer = lifecycle;

  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    if (shutdownReason !== null) return;
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      lifecycle.beginRequest();
      void handleJsonRpc(JSON.parse(line) as JsonRpcRequest).finally(() => lifecycle.endRequest());
    }
  });
  // Hosts release stdio MCP servers by closing the pipes; without these
  // handlers the gateway entry outlives their client (issue #499).
  stdin.on("end", () => shutdown("stdin end"));
  stdin.on("close", () => shutdown("stdin close"));
  stdin.on("error", () => shutdown("stdin error"));
  stdout.on("error", () => shutdown("stdout error"));
  signalTarget.on("SIGTERM", () => shutdown("SIGTERM"));
  signalTarget.on("SIGINT", () => shutdown("SIGINT"));
  if (stdin.readableEnded || stdin.destroyed) shutdown("stdin already closed");
}
