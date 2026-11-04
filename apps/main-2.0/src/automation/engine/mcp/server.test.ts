import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { callMcpTool, mcpToolDefinitions, resolveBridgeDiscoveryPath, startStdioMcpServer } from "./server";

const originalBridgeEnv = process.env.AGENT_RECALL_MCP_BRIDGE;
const originalStudioToken = process.env.AGENT_RECALL_STUDIO_TOKEN;

async function killAndWaitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(escalate);
      clearTimeout(backstop);
      resolve();
    };
    // SIGTERM may be ignored or stuck; escalate to SIGKILL and drop our ends
    // of the pipes so nothing can hold the suite open on top of a failure.
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
    }, 2_000);
    // Absolute backstop: even a child that refuses to die cannot hang here.
    const backstop = setTimeout(settle, 5_000);
    child.once("close", settle);
    child.once("error", settle);
  });
}
describe("MCP server tools", () => {
  afterEach(() => {
    if (originalBridgeEnv === undefined) delete process.env.AGENT_RECALL_MCP_BRIDGE;
    else process.env.AGENT_RECALL_MCP_BRIDGE = originalBridgeEnv;
    if (originalStudioToken === undefined) delete process.env.AGENT_RECALL_STUDIO_TOKEN;
    else process.env.AGENT_RECALL_STUDIO_TOKEN = originalStudioToken;
    vi.restoreAllMocks();
  });

  test("exposes the separate session and resource Gateway entry tools to external clients", () => {
    expect(mcpToolDefinitions().map((tool) => tool.name)).toEqual([
      "search_tools",
      "get_tool",
      "call_tool",
      "list_skills",
      "get_skill",
      "search_sessions",
      "get_session",
      "search_resources",
      "get_resource",
    ]);
  });

  test("uses env override for bridge discovery", () => {
    process.env.AGENT_RECALL_MCP_BRIDGE = "/tmp/custom-bridge.json";

    expect(resolveBridgeDiscoveryPath()).toBe("/tmp/custom-bridge.json");
  });

  test("does not expose retired Chat tools with a legacy Studio token", async () => {
    process.env.AGENT_RECALL_STUDIO_TOKEN = "studio-scope";
    const names = mcpToolDefinitions().map((tool) => tool.name);
    expect(names.filter((name) => name.startsWith("studio_") || name.startsWith("workspace_"))).toEqual([]);
    await expect(callMcpTool("studio_turn_get", { turnId: "turn-1" }))
      .rejects.toThrow("Unknown MCP tool: studio_turn_get");
  });

  test("propagates an indexed MCP tool error through the Gateway result", async () => {
    const bridge = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({
        content: [{ type: "text", text: "upstream failed" }],
        isError: true,
      })}\n`);
    });
    await new Promise<void>((resolve, reject) => {
      bridge.once("error", reject);
      bridge.listen(0, "127.0.0.1", () => resolve());
    });
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Test bridge did not bind to TCP.");
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-gateway-tool-error-"));
    const discoveryPath = path.join(dir, "bridge.json");
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "secret" }), "utf8");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "gateway-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_MCP_BRIDGE: discoveryPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio response timed out")), 5_000);
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          const newlineIndex = output.indexOf("\n");
          if (newlineIndex < 0) return;
          clearTimeout(timer);
          resolve(JSON.parse(output.slice(0, newlineIndex)));
        });
        child.once("error", reject);
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "call_tool", arguments: { toolRef: "docs/write" } },
        })}\n`);
      });

      expect(response.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining('"isError": true') }],
      });
    } finally {
      child.kill();
      await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    }
  });

  test("gateway stdio server exits after the host closes stdin", async () => {
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "gateway-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RECALL_MCP_BRIDGE: path.join(os.tmpdir(), "missing-mcp-bridge.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await new Promise<Record<string, any>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio response timed out")), 5_000);
        let output = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          const newlineIndex = output.indexOf("\n");
          if (newlineIndex < 0) return;
          clearTimeout(timer);
          resolve(JSON.parse(output.slice(0, newlineIndex)));
        });
        child.once("error", reject);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
      });
      expect(response.result.tools.length).toBeGreaterThan(0);

      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway stdio server outlived closed stdin")), 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", reject);
      });
      expect(exitCode).toBe(0);
    } finally {
      await killAndWaitForExit(child);
    }
  });

  test("drains in-flight requests before exiting on stdin close", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-drain-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await fetchGate;
      return { ok: true, status: 200, json: async () => ({ ok: true, items: [] }) } as Response;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      maybeCallback?: () => void,
    ) => {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      if (callback) setImmediate(callback);
      return true;
    }) as typeof process.stdout.write);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code) });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_tools", arguments: {} } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCodes).toEqual([]);

    releaseFetch();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("waits for the last response to flush before exiting on stdin close", async () => {
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(((
      _chunk: unknown,
      encodingOrCallback?: BufferEncoding | (() => void),
      maybeCallback?: () => void,
    ) => {
      const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
      if (callback) void flushGate.then(callback);
      return true;
    }) as typeof process.stdout.write);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code) });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitCodes).toEqual([]);

    releaseFlush();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("stops waiting for in-flight requests after the drain window", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-drain-cap-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => undefined));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitCodes: number[] = [];
    const stdin = new PassThrough();

    startStdioMcpServer({ stdin, signalTarget: { on: () => undefined }, exit: (code) => exitCodes.push(code), drainMs: 20 });

    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "search_tools", arguments: {} } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    stdin.end();
    await vi.waitFor(() => expect(exitCodes).toEqual([0]));
  });

  test("exits on termination signals and broken stream pipes", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const signalListeners = new Map<string, (() => void)[]>();
    const signalTarget = {
      on(signal: string, listener: () => void) {
        signalListeners.set(signal, [...(signalListeners.get(signal) ?? []), listener]);
        return this;
      },
    };
    const exitCodes: number[] = [];

    startStdioMcpServer({
      stdin,
      stdout,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });

    for (const listener of signalListeners.get("SIGTERM") ?? []) listener();
    expect(exitCodes).toEqual([0]);

    const stdinAlreadyClosed = new PassThrough();
    stdinAlreadyClosed.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    startStdioMcpServer({
      stdin: stdinAlreadyClosed,
      stdout,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });
    expect(exitCodes).toEqual([0, 0]);

    const stdoutForPipeError = new PassThrough();
    startStdioMcpServer({
      stdin: new PassThrough(),
      stdout: stdoutForPipeError,
      signalTarget,
      exit: (code) => exitCodes.push(code),
    });
    stdoutForPipeError.emit("error", new Error("EPIPE"));
    expect(exitCodes).toEqual([0, 0, 0]);
  });

  test("stdio server stops instead of leaking when stdin closes mid-request", async () => {
    const blackholeSockets = new Set<net.Socket>();
    const blackhole = net.createServer((socket) => {
      // Accept the TCP connection but never respond, so the tool call hangs
      // the same way a gateway request in flight while its host dies does.
      blackholeSockets.add(socket);
      socket.on("error", (error: NodeJS.ErrnoException) => {
        // Windows may reset this fixture connection when the child exits mid-request.
        if (error.code !== "ECONNRESET") throw error;
      });
      socket.once("close", () => blackholeSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      blackhole.once("error", reject);
      blackhole.listen(0, "127.0.0.1", () => resolve());
    });
    const address = blackhole.address();
    if (!address || typeof address === "string") throw new Error("Test bridge did not bind to TCP.");
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-recall-stdio-leak-"));
    const discoveryPath = path.join(dir, "bridge.json");
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "secret" }), "utf8");
    const tsxCli = path.resolve("node_modules", "tsx", "dist", "cli.mjs");
    const serverPath = path.resolve("src", "mcp", "gateway-entry.ts");
    const child = spawn(process.execPath, [tsxCli, serverPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_RECALL_MCP_BRIDGE: discoveryPath,
        AGENT_RECALL_MCP_SHUTDOWN_DRAIN_MS: "300",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "call_tool", arguments: { toolRef: "docs/search" } },
      })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      child.stdin.end();
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MCP stdio server leaked after stdin closed mid-request")), 5_000);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        child.once("error", reject);
      });
      expect(exitCode).toBe(0);
    } finally {
      await killAndWaitForExit(child);
      // The blackhole never ends its accepted sockets, so plain close() would
      // wait forever for the half-open connection; drop them explicitly.
      for (const socket of blackholeSockets) socket.destroy();
      await new Promise<void>((resolve, reject) => blackhole.close((error) => error ? reject(error) : resolve()));
    }
  }, 15_000);

  test("calls bridge endpoints with discovery token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "multi-agent-chat-mcp-server-"));
    const discoveryPath = path.join(dir, "bridge.json");
    process.env.AGENT_RECALL_MCP_BRIDGE = discoveryPath;
    await writeFile(discoveryPath, JSON.stringify({ host: "127.0.0.1", port: 48123, token: "secret" }), "utf8");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, items: [] }),
    } as Response);

    const result = await callMcpTool("search_tools", { sourceId: "docs" });

    expect(result).toEqual({ ok: true, items: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:48123/mcp/gateway/tools/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
  });

});
