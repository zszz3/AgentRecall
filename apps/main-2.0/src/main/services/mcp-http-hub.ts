import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpExternalClientId, McpHttpHubStatus } from "../../automation/engine/shared/mcp/types";
import { mcpToolDefinitions } from "../../automation/engine/mcp/server";
import type { McpDirectHubTool, McpGatewayScopeOptions } from "./mcp-automation-module";

export const DEFAULT_MCP_HUB_PORT = 4326;
export const MCP_HUB_CLIENT_IDS = new Set<McpExternalClientId>([
  "codex",
  "claude",
  "cursor",
  "gemini",
  "opencode",
  "qwen",
  "zcode",
]);

const HUB_INSTRUCTIONS = "AgentRecall 保存了本机编码 Agent 的历史会话和从中提炼的经验卡。排查报错、改动不熟悉的代码或做技术取舍之前，先用 search_sessions 搜索报错原文或任务关键词，看这个项目以前怎么解决、哪些做法无效、用户做过什么决定。结论较旧时先核对再用。";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_SESSIONS = 64;

export interface McpHttpHubGateway {
  listDirectTools(options?: McpGatewayScopeOptions): Promise<McpDirectHubTool[]>;
  listHubToolCatalog?(options?: McpGatewayScopeOptions): Promise<{
    enabledBuiltins: Set<string>;
    directTools: McpDirectHubTool[];
  }>;
  callDirectTool(
    exposedName: string,
    args: Record<string, unknown>,
    options?: McpGatewayScopeOptions,
  ): Promise<unknown>;
  searchTools(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  getTool(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  callTool(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  listSkills(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  getSkill(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  searchResources(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  getResource(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  searchSessions(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  getSession(body: unknown, options?: McpGatewayScopeOptions): Promise<unknown>;
  isDirectBuiltinEnabled(
    sourceId: "agent-recall-session-search" | "agent-recall-skills",
    toolName: string,
    options?: McpGatewayScopeOptions,
  ): Promise<boolean>;
}

export interface StartMcpHttpHubOptions {
  port?: number;
  host?: string;
  token: string;
  gateway: McpHttpHubGateway;
  resolveAllowedServerIds?: (clientId: McpExternalClientId) => readonly string[] | undefined;
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
}

export interface McpHttpHubServer {
  host: string;
  port: number;
  url: string;
  token: string;
  getStatus(): McpHttpHubStatus;
  notifyToolsChanged(): void;
  stop(): Promise<void>;
}

interface HubSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  clientId?: McpExternalClientId;
  lastActivityAt: number;
}

function isAllowedLoopbackOrigin(originHeader: string | undefined): boolean {
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.hostname === "127.0.0.1"
      || parsed.hostname === "localhost"
      || parsed.hostname === "[::1]"
      || parsed.hostname === "::1";
  } catch {
    return false;
  }
}

function parseHubRoute(rawUrl: string | undefined): { ok: true; clientId?: McpExternalClientId } | { ok: false } {
  const pathname = (rawUrl ?? "/").split("?", 1)[0]!.replace(/\/+$/, "") || "/";
  if (pathname === "/mcp") return { ok: true };
  if (pathname.startsWith("/mcp/")) {
    const segment = pathname.slice("/mcp/".length);
    if (!segment.includes("/") && MCP_HUB_CLIENT_IDS.has(segment as McpExternalClientId)) {
      return { ok: true, clientId: segment as McpExternalClientId };
    }
  }
  return { ok: false };
}

function isAuthorized(authHeader: string | undefined, expectedToken: string): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(authHeader.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("MCP request body exceeds 8 MiB limit.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function toCallToolResult(result: unknown): CallToolResult {
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && Array.isArray((result as { content?: unknown }).content)
  ) {
    const record = result as { content: CallToolResult["content"]; isError?: unknown; structuredContent?: Record<string, unknown> };
    return {
      content: record.content,
      ...(record.isError === true ? { isError: true } : {}),
      ...(record.structuredContent ? { structuredContent: record.structuredContent } : {}),
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

function builtinToolSource(name: string): "agent-recall-session-search" | "agent-recall-skills" | null {
  if (name === "search_sessions" || name === "get_session") return "agent-recall-session-search";
  if (name === "list_skills" || name === "get_skill" || name === "search_resources" || name === "get_resource") {
    return "agent-recall-skills";
  }
  return null;
}

function createHubProtocolServer(
  gateway: McpHttpHubGateway,
  getAllowedServerIds: () => readonly string[] | undefined,
  clientLabel: string,
): Server {
  const server = new Server(
    { name: "agent-recall", version: "2.0.0" },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: HUB_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const allowedServerIds = getAllowedServerIds();
    const scopeOptions: McpGatewayScopeOptions = {
      ...(allowedServerIds ? { allowedServerIds } : {}),
      clientLabel,
    };
    const builtins: Tool[] = [];
    let directTools: McpDirectHubTool[];
    if (gateway.listHubToolCatalog) {
      const catalog = await gateway.listHubToolCatalog(scopeOptions);
      for (const def of mcpToolDefinitions()) {
        const source = builtinToolSource(def.name);
        if (source && !catalog.enabledBuiltins.has(def.name)) continue;
        builtins.push({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema as Tool["inputSchema"],
          ...(def.annotations ? { annotations: def.annotations } : {}),
        });
      }
      directTools = catalog.directTools;
    } else {
      for (const def of mcpToolDefinitions()) {
        const source = builtinToolSource(def.name);
        if (source) {
          const enabled = await gateway.isDirectBuiltinEnabled(source, def.name, scopeOptions);
          if (!enabled) continue;
        }
        builtins.push({
          name: def.name,
          description: def.description,
          inputSchema: def.inputSchema as Tool["inputSchema"],
          ...(def.annotations ? { annotations: def.annotations } : {}),
        });
      }
      directTools = await gateway.listDirectTools(scopeOptions);
    }
    const direct: Tool[] = directTools.map((tool) => ({
      name: tool.exposedName,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool["inputSchema"],
      ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
    }));
    return { tools: [...builtins, ...direct] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments && typeof request.params.arguments === "object" && !Array.isArray(request.params.arguments)
      ? request.params.arguments
      : {}) as Record<string, unknown>;
    const allowedServerIds = getAllowedServerIds();
    const scopeOptions: McpGatewayScopeOptions = {
      ...(allowedServerIds ? { allowedServerIds } : {}),
      clientLabel,
    };

    try {
      let result: unknown;
      switch (name) {
        case "search_tools":
          result = await gateway.searchTools(args, scopeOptions);
          break;
        case "get_tool":
          result = await gateway.getTool(args, scopeOptions);
          break;
        case "call_tool":
          result = await gateway.callTool(args, scopeOptions);
          break;
        case "list_skills":
          result = await gateway.listSkills(args, scopeOptions);
          break;
        case "get_skill":
          result = await gateway.getSkill(args, scopeOptions);
          break;
        case "search_resources":
          result = await gateway.searchResources(args, scopeOptions);
          break;
        case "get_resource":
          result = await gateway.getResource(args, scopeOptions);
          break;
        case "search_sessions":
          result = await gateway.searchSessions(args, scopeOptions);
          break;
        case "get_session":
          result = await gateway.getSession(args, scopeOptions);
          break;
        default:
          result = await gateway.callDirectTool(name, args, scopeOptions);
          break;
      }
      return toCallToolResult(result);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  return server;
}

export async function startMcpHttpHub(options: StartMcpHttpHubOptions): Promise<McpHttpHubServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? DEFAULT_MCP_HUB_PORT;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const sessions = new Map<string, HubSession>();
  let running = false;

  const disposeSession = async (sessionId: string, session: HubSession): Promise<void> => {
    if (sessions.get(sessionId) === session) {
      sessions.delete(sessionId);
    }
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };

  const sweepIdleSessions = () => {
    if (sessionIdleTimeoutMs <= 0) return;
    const cutoff = Date.now() - sessionIdleTimeoutMs;
    for (const [id, session] of [...sessions.entries()]) {
      if (session.lastActivityAt < cutoff) {
        void disposeSession(id, session);
      }
    }
  };

  const evictOldestIfFull = () => {
    while (sessions.size >= maxSessions) {
      let oldestId: string | undefined;
      let oldestSession: HubSession | undefined;
      for (const [id, session] of sessions.entries()) {
        if (!oldestSession || session.lastActivityAt < oldestSession.lastActivityAt) {
          oldestId = id;
          oldestSession = session;
        }
      }
      if (!oldestId || !oldestSession) break;
      void disposeSession(oldestId, oldestSession);
    }
  };

  const sweepIntervalMs = sessionIdleTimeoutMs > 0
    ? Math.max(50, Math.min(60_000, Math.floor(sessionIdleTimeoutMs / 2)))
    : 0;
  const sweepTimer = sweepIntervalMs > 0
    ? setInterval(sweepIdleSessions, sweepIntervalMs)
    : undefined;
  sweepTimer?.unref?.();

  const server = http.createServer((request, response) => {
    void (async () => {
      const route = parseHubRoute(request.url);
      if (!route.ok) {
        writeJson(response, 404, { error: "Unknown MCP Hub endpoint. Use /mcp or /mcp/<clientId>." });
        return;
      }
      if (!isAllowedLoopbackOrigin(request.headers.origin)) {
        writeJson(response, 403, { error: "Cross-origin requests to AgentRecall MCP Hub are forbidden." });
        return;
      }
      if (!isAuthorized(request.headers.authorization, options.token)) {
        writeJson(response, 401, { error: "A valid Bearer token is required for AgentRecall MCP Hub." });
        return;
      }

      const method = (request.method ?? "GET").toUpperCase();
      const sessionIdHeader = request.headers["mcp-session-id"];
      const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader.trim() : undefined;

      if (method === "POST") {
        let body: unknown;
        try {
          body = await readRequestJson(request);
        } catch (error) {
          writeJson(response, 400, {
            jsonrpc: "2.0",
            error: { code: -32700, message: error instanceof Error ? error.message : "Invalid JSON body." },
            id: null,
          });
          return;
        }

        if (sessionId) {
          const existing = sessions.get(sessionId);
          if (!existing || existing.clientId !== route.clientId) {
            writeJson(response, 404, {
              jsonrpc: "2.0",
              error: { code: -32001, message: "MCP session not found." },
              id: null,
            });
            return;
          }
          existing.lastActivityAt = Date.now();
          await existing.transport.handleRequest(request, response, body);
          return;
        }

        if (!isInitializeRequest(body)) {
          writeJson(response, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: missing mcp-session-id for non-initialize request." },
            id: null,
          });
          return;
        }

        sweepIdleSessions();
        evictOldestIfFull();

        let registeredId: string | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdId) => {
            registeredId = createdId;
            sessions.set(createdId, {
              server: mcpServer,
              transport,
              clientId: route.clientId,
              lastActivityAt: Date.now(),
            });
          },
        });
        const mcpServer = createHubProtocolServer(
          options.gateway,
          () => (route.clientId ? options.resolveAllowedServerIds?.(route.clientId) : undefined),
          route.clientId ?? "http-hub",
        );
        transport.onclose = () => {
          const id = transport.sessionId ?? registeredId;
          if (id) sessions.delete(id);
        };
        try {
          await mcpServer.connect(transport);
          await transport.handleRequest(request, response, body);
        } catch (error) {
          if (!registeredId) {
            await transport.close().catch(() => undefined);
            await mcpServer.close().catch(() => undefined);
          }
          throw error;
        }
        return;
      }

      if (method === "GET" || method === "DELETE") {
        if (!sessionId) {
          writeJson(response, 400, { error: "Missing mcp-session-id header." });
          return;
        }
        const existing = sessions.get(sessionId);
        if (!existing || existing.clientId !== route.clientId) {
          writeJson(response, 404, { error: "MCP session not found." });
          return;
        }
        existing.lastActivityAt = Date.now();
        await existing.transport.handleRequest(request, response);
        if (method === "DELETE") {
          await disposeSession(sessionId, existing);
        }
        return;
      }

      writeJson(response, 405, { error: "Method not allowed." });
    })().catch((error) => {
      if (!response.headersSent) {
        writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      running = true;
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const hubUrl = `http://${host}:${boundPort}/mcp`;

  return {
    host,
    port: boundPort,
    url: hubUrl,
    token: options.token,
    getStatus: (): McpHttpHubStatus => ({
      running,
      url: hubUrl,
      port: boundPort,
      activeSessions: sessions.size,
    }),
    notifyToolsChanged: () => {
      for (const session of sessions.values()) {
        void session.server.sendToolListChanged().catch(() => undefined);
      }
    },
    stop: async () => {
      running = false;
      if (sweepTimer) clearInterval(sweepTimer);
      const active = [...sessions.entries()];
      sessions.clear();
      await Promise.allSettled(active.map(([id, session]) => disposeSession(id, session)));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
