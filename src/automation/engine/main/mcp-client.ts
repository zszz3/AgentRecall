import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerDefinition, McpToolDefinition } from "../shared/mcp/types";

export async function discoverMcpTools(server: McpServerDefinition): Promise<McpToolDefinition[]> {
  const client = new Client({ name: "agent-recall", version: "0.1.0" });
  const transport = server.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(required(server.url, "HTTP URL")))
    : new StdioClientTransport({
        command: required(server.command, "command"),
        args: server.args,
        env: Object.fromEntries(Object.entries(server.env).map(([key, envName]) => [key, process.env[envName] ?? ""])),
      });
  try {
    await withTimeout(client.connect(transport as Transport), 10_000);
    const result = await withTimeout(client.listTools(), 10_000);
    return result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`MCP ${label} is required`);
  return value.trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("MCP connection timed out")), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
