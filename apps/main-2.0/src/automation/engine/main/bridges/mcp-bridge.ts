import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

export interface McpBridgeServer {
  host: string;
  port: number;
  /** Bearer token written to the discovery file for the Gateway MCP server. */
  token: string;
  discoveryPath: string;
  stop: () => Promise<void>;
}

export interface McpBridgeGateway {
  searchTools(body: unknown): Promise<unknown>;
  getTool(body: unknown): Promise<unknown>;
  callTool(body: unknown): Promise<unknown>;
  listSkills(body: unknown): Promise<unknown>;
  getSkill(body: unknown): Promise<unknown>;
  searchResources(body: unknown): Promise<unknown>;
  getResource(body: unknown): Promise<unknown>;
  searchSessions(body: unknown): Promise<unknown>;
  getSession(body: unknown): Promise<unknown>;
}

export interface StartMcpBridgeOptions {
  discoveryPath: string;
  gateway: McpBridgeGateway;
}

function jsonResponse(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as unknown;
}

function routeGatewayRequest(gateway: McpBridgeGateway, route: string, body: unknown): Promise<unknown> | unknown {
  switch (route) {
    case "/mcp/gateway/tools/search": return gateway.searchTools(body);
    case "/mcp/gateway/tools/get": return gateway.getTool(body);
    case "/mcp/gateway/tools/call": return gateway.callTool(body);
    case "/mcp/gateway/skills/list": return gateway.listSkills(body);
    case "/mcp/gateway/skills/get": return gateway.getSkill(body);
    case "/mcp/gateway/resources/search": return gateway.searchResources(body);
    case "/mcp/gateway/resources/get": return gateway.getResource(body);
    case "/mcp/gateway/sessions/search": return gateway.searchSessions(body);
    case "/mcp/gateway/sessions/get": return gateway.getSession(body);
    default: return { ok: false, error: `Unknown AgentRecall Gateway route: ${route}` };
  }
}

export async function startMcpBridge(options: StartMcpBridgeOptions): Promise<McpBridgeServer> {
  const host = "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        jsonResponse(response, 405, { ok: false, error: "Method not allowed." });
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        jsonResponse(response, 401, {
          ok: false,
          error: {
            code: "UNAUTHORIZED",
            message: "A valid MCP bridge token is required.",
          },
        });
        return;
      }
      try {
        const body = await readJsonBody(request);
        jsonResponse(response, 200, await routeGatewayRequest(options.gateway, request.url ?? "", body));
      } catch (error) {
        jsonResponse(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  await mkdir(path.dirname(options.discoveryPath), { recursive: true });
  await writeFile(
    options.discoveryPath,
    `${JSON.stringify({ host, port: address.port, token, pid: process.pid, startedAt: Date.now() }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    host,
    port: address.port,
    token,
    discoveryPath: options.discoveryPath,
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(options.discoveryPath, { force: true });
    },
  };
}
