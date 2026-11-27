import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerDefinition } from "../shared/mcp/types";
import {
  connectMcpClient,
  discoverMcpTools,
  McpConnectionPool,
  type ConnectedMcpClient,
} from "./mcp-client";

const {
  stdioArgs,
  streamableCalls,
  sseCalls,
  connectBehavior,
} = vi.hoisted(() => ({
  stdioArgs: [] as unknown[],
  streamableCalls: [] as Array<{ url: string; options: unknown }>,
  sseCalls: [] as Array<{ url: string; options: unknown }>,
  connectBehavior: {
    streamableError: null as Error | null,
    sseError: null as Error | null,
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    readonly kind = "stdio";
    constructor(options: unknown) {
      stdioArgs.push(options);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    readonly kind = "streamable-http";
    constructor(url: URL, options: unknown) {
      streamableCalls.push({ url: url.toString(), options });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    readonly kind = "sse";
    constructor(url: URL, options?: unknown) {
      sseCalls.push({ url: url.toString(), options });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    async connect(transport: { kind?: string }): Promise<void> {
      if (transport.kind === "streamable-http" && connectBehavior.streamableError) {
        throw connectBehavior.streamableError;
      }
      if (transport.kind === "sse" && connectBehavior.sseError) {
        throw connectBehavior.sseError;
      }
    }
    async listTools(): Promise<{ tools: Array<{ name: string; inputSchema: unknown; annotations: { readOnlyHint: boolean } }> }> {
      return { tools: [{ name: "tool_a", inputSchema: {}, annotations: { readOnlyHint: true } }] };
    }
    async callTool(): Promise<{ content: Array<{ type: string; text: string }> }> {
      return { content: [{ type: "text", text: "ok" }] };
    }
    async close(): Promise<void> {}
  },
}));

function server(overrides: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "x",
    name: "X",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    env: {},
    enabled: true,
    tools: [],
    status: "untested",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fakeConnectedClient(overrides: {
  transportMode?: ConnectedMcpClient["transportMode"];
  callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
} = {}) {
  const close = vi.fn(async () => undefined);
  const callTool = vi.fn(overrides.callTool ?? (async () => ({ content: [{ type: "text", text: "ok" }] })));
  const client = {
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    callTool,
    close,
  };
  const connection: ConnectedMcpClient = {
    client: client as never,
    transport: {} as never,
    transportMode: overrides.transportMode ?? "stdio",
  };
  return { connection, client, callTool, close };
}

afterEach(() => {
  stdioArgs.length = 0;
  streamableCalls.length = 0;
  sseCalls.length = 0;
  connectBehavior.streamableError = null;
  connectBehavior.sseError = null;
  vi.useRealTimers();
});

describe("discoverMcpTools", () => {
  it("uses literal env when provided", async () => {
    const tools = await discoverMcpTools(
      server(),
      { AGENT_RECALL_MCP_BRIDGE: "/tmp/automation-mcp-bridge.json", EXAMPLE_TOKEN: "secret-token" },
    );
    expect(stdioArgs[0]).toMatchObject({
      env: { AGENT_RECALL_MCP_BRIDGE: "/tmp/automation-mcp-bridge.json", EXAMPLE_TOKEN: "secret-token" },
    });
    expect(tools).toEqual([{ name: "tool_a", inputSchema: {}, readOnly: true }]);
  });

  it("resolves env values as host variable names by default", async () => {
    process.env.HOST_MCP_VAR = "resolved-value";
    try {
      await discoverMcpTools(server({ env: { SOME_KEY: "HOST_MCP_VAR" } }));
      expect(stdioArgs[0]).toMatchObject({ env: { SOME_KEY: "resolved-value" } });
    } finally {
      delete process.env.HOST_MCP_VAR;
    }
  });

  it("falls back to an empty string for unresolvable host variables", async () => {
    await discoverMcpTools(server({ env: { SOME_KEY: "DEFINITELY_NOT_SET_HOST_VAR" } }));
    expect(stdioArgs[0]).toMatchObject({ env: { SOME_KEY: "" } });
  });
});

describe("connectMcpClient HTTP to SSE fallback", () => {
  it("falls back to SSE when Streamable HTTP responds with 405 Method Not Allowed", async () => {
    const error = Object.assign(new Error("HTTP 405 Method Not Allowed"), { code: 405 });
    connectBehavior.streamableError = error;
    process.env.TEST_MCP_HEADER_TOKEN = "Bearer test-token";
    try {
      const connected = await connectMcpClient(
        server({
          transport: "http",
          url: "https://example.com/sse",
          headers: { Authorization: "TEST_MCP_HEADER_TOKEN" },
        }),
        "agent-recall-test",
      );
      expect(connected.transportMode).toBe("sse");
      expect(streamableCalls).toHaveLength(1);
      expect(sseCalls).toHaveLength(1);
      expect(sseCalls[0]!.url).toBe("https://example.com/sse");
      expect(sseCalls[0]!.options).toMatchObject({
        requestInit: { headers: { Authorization: "Bearer test-token" } },
      });
    } finally {
      delete process.env.TEST_MCP_HEADER_TOKEN;
    }
  });

  it("does not fall back to SSE on authentication errors (401)", async () => {
    connectBehavior.streamableError = Object.assign(new Error("HTTP 401 Unauthorized"), { code: 401 });
    await expect(
      connectMcpClient(
        server({ transport: "http", url: "https://example.com/mcp" }),
        "agent-recall-test",
      ),
    ).rejects.toThrow("401");
    expect(sseCalls).toHaveLength(0);
  });
});

describe("McpConnectionPool", () => {
  it("reuses a single connection across repeated calls and deduplicates concurrent connects", async () => {
    let callCounter = 0;
    const fake = fakeConnectedClient({
      callTool: async ({ name }) => {
        callCounter += 1;
        return { content: [{ type: "text", text: `${name}:${callCounter}` }] };
      },
    });
    const connect = vi.fn(async () => {
      await Promise.resolve();
      return fake.connection;
    });
    const pool = new McpConnectionPool({ connect, idleTimeoutMs: 60_000 });
    const target = server({ id: "playwright", name: "Playwright" });

    const [first, second] = await Promise.all([
      pool.invokeTool(target, "navigate", { url: "https://example.com" }),
      pool.invokeTool(target, "click", { selector: "#go" }),
    ]);
    const third = await pool.invokeTool(target, "snapshot", {});

    expect(connect).toHaveBeenCalledTimes(1);
    expect(fake.callTool).toHaveBeenCalledTimes(3);
    expect(first).toEqual({ content: [{ type: "text", text: "navigate:1" }] });
    expect(second).toEqual({ content: [{ type: "text", text: "click:2" }] });
    expect(third).toEqual({ content: [{ type: "text", text: "snapshot:3" }] });
    expect(pool.getRuntimeState("playwright")).toMatchObject({
      state: "running",
      transportMode: "stdio",
    });

    await pool.closeAll();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(pool.getRuntimeState("playwright")).toEqual({ state: "idle" });
  });

  it("evicts and reconnects when connection configuration changes", async () => {
    const firstConn = fakeConnectedClient();
    const secondConn = fakeConnectedClient();
    const connect = vi.fn()
      .mockResolvedValueOnce(firstConn.connection)
      .mockResolvedValueOnce(secondConn.connection);
    const pool = new McpConnectionPool({ connect, idleTimeoutMs: 60_000 });

    await pool.invokeTool(server({ id: "srv", args: ["v1.js"] }), "ping", {});
    await pool.invokeTool(server({ id: "srv", args: ["v2.js"] }), "ping", {});

    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstConn.close).toHaveBeenCalledTimes(1);
    expect(secondConn.close).not.toHaveBeenCalled();
    await pool.closeAll();
  });

  it("evicts idle connections after idleTimeoutMs without closing active calls", async () => {
    vi.useFakeTimers();
    const fake = fakeConnectedClient();
    const connect = vi.fn(async () => fake.connection);
    const pool = new McpConnectionPool({ connect, idleTimeoutMs: 5_000 });

    await pool.invokeTool(server({ id: "idle-srv" }), "ping", {});
    expect(pool.getRuntimeState("idle-srv").state).toBe("running");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fake.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(pool.getRuntimeState("idle-srv")).toEqual({ state: "idle" });
  });

  it("evicts crashed connections and keeps connections alive on invalid-params RPC errors", async () => {
    const firstConn = fakeConnectedClient({
      callTool: async ({ name }) => {
        if (name === "bad_args") {
          throw new McpError(ErrorCode.InvalidParams, "missing required field");
        }
        if (name === "crash") {
          throw new Error("EPIPE broken pipe");
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const secondConn = fakeConnectedClient();
    const connect = vi.fn()
      .mockResolvedValueOnce(firstConn.connection)
      .mockResolvedValueOnce(secondConn.connection);
    const pool = new McpConnectionPool({ connect, idleTimeoutMs: 60_000 });
    const target = server({ id: "resilient" });

    // Non-fatal parameter error should keep the pooled connection alive.
    await expect(pool.invokeTool(target, "bad_args", {})).rejects.toThrow("missing required field");
    expect(firstConn.close).not.toHaveBeenCalled();

    // Transport failure should evict the dead connection and record error state.
    await expect(pool.invokeTool(target, "crash", {})).rejects.toThrow("EPIPE broken pipe");
    expect(firstConn.close).toHaveBeenCalledTimes(1);
    expect(pool.getRuntimeState("resilient")).toMatchObject({
      state: "error",
      lastError: "EPIPE broken pipe",
    });

    // Next call cleanly establishes a fresh connection.
    await pool.invokeTool(target, "healthy", {});
    expect(connect).toHaveBeenCalledTimes(2);
    expect(pool.getRuntimeState("resilient").state).toBe("running");
    await pool.closeAll();
  });

  it("evicts immediately when the underlying transport closes unexpectedly between calls", async () => {
    const firstConn = fakeConnectedClient();
    const secondConn = fakeConnectedClient();
    const connect = vi.fn()
      .mockResolvedValueOnce(firstConn.connection)
      .mockResolvedValueOnce(secondConn.connection);
    const pool = new McpConnectionPool({ connect, idleTimeoutMs: 60_000 });
    const target = server({ id: "flaky" });

    await pool.invokeTool(target, "step1", {});
    firstConn.client.onclose?.();
    expect(pool.getRuntimeState("flaky")).toEqual({ state: "idle" });

    await pool.invokeTool(target, "step2", {});
    expect(connect).toHaveBeenCalledTimes(2);
    await pool.closeAll();
  });
});
