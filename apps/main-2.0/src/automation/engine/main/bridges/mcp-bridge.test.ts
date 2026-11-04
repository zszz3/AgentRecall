import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startMcpBridge, type McpBridgeGateway, type McpBridgeServer } from "./mcp-bridge";

let bridge: McpBridgeServer | undefined;

async function stopBridge(): Promise<void> {
  if (!bridge) return;
  await bridge.stop();
  bridge = undefined;
}

async function bridgeRequest(route: string, token: string, body: unknown): Promise<Response> {
  if (!bridge) throw new Error("bridge not started");
  return fetch(`http://${bridge.host}:${bridge.port}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function createGateway(): McpBridgeGateway & Record<keyof McpBridgeGateway, ReturnType<typeof vi.fn>> {
  return {
    searchTools: vi.fn(async () => ({ items: [{ toolRef: "docs/search" }] })),
    getTool: vi.fn(async () => ({ toolRef: "docs/search", inputSchema: {} })),
    callTool: vi.fn(async () => ({ ok: true, result: "done" })),
    listSkills: vi.fn(async () => []),
    getSkill: vi.fn(async () => ({ managedId: "skill-1" })),
    searchResources: vi.fn(async () => []),
    getResource: vi.fn(async () => ({})),
    searchSessions: vi.fn(async () => []),
    getSession: vi.fn(async () => ({ sessionKey: "session-1" })),
  };
}

describe("MCP bridge", () => {
  afterEach(async () => {
    await stopBridge();
  });

  test("starts on a dynamic localhost port and writes discovery metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-bridge-"));
    const discoveryPath = path.join(dir, "bridge.json");

    bridge = await startMcpBridge({ discoveryPath, gateway: createGateway() });

    expect(bridge.host).toBe("127.0.0.1");
    expect(bridge.port).toBeGreaterThan(0);
    expect(bridge.token).toHaveLength(64);
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8")) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      host: "127.0.0.1",
      port: bridge.port,
      token: bridge.token,
    });
  });

  test("routes all Gateway operations through the discovery token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-gateway-"));
    const gateway = createGateway();
    bridge = await startMcpBridge({ discoveryPath: path.join(dir, "bridge.json"), gateway });

    const search = await bridgeRequest("/mcp/gateway/tools/search", bridge.token, { sourceId: "docs" });
    expect(await search.json()).toEqual({ items: [{ toolRef: "docs/search" }] });
    expect(gateway.searchTools).toHaveBeenCalledWith({ sourceId: "docs" });
    expect((await bridgeRequest("/mcp/gateway/resources/search", bridge.token, { query: "review" })).status).toBe(200);
    expect(gateway.searchResources).toHaveBeenCalledWith({ query: "review" });
    expect((await bridgeRequest("/mcp/gateway/resources/get", bridge.token, { id: "review", type: "skill" })).status).toBe(200);
    expect(gateway.getResource).toHaveBeenCalledWith({ id: "review", type: "skill" });

    const call = await bridgeRequest("/mcp/gateway/tools/call", bridge.token, {
      toolRef: "docs/search",
      arguments: { query: "gateway" },
    });
    expect(await call.json()).toEqual({ ok: true, result: "done" });
    expect(gateway.callTool).toHaveBeenCalledWith({
      toolRef: "docs/search",
      arguments: { query: "gateway" },
    });
  });

  test("rejects missing tokens and retired non-Gateway routes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-mcp-retired-"));
    bridge = await startMcpBridge({ discoveryPath: path.join(dir, "bridge.json"), gateway: createGateway() });

    expect((await bridgeRequest("/mcp/gateway/resources/search", "invalid", { query: "review" })).status).toBe(401);
    const retired = await bridgeRequest("/mcp/workflow/list", bridge.token, {});
    expect(retired.status).toBe(200);
    expect(await retired.json()).toEqual({ ok: false, error: "Unknown AgentRecall Gateway route: /mcp/workflow/list" });
  });
});
