import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import {
  desktopSearch,
  resolveDesktopBridgePath,
  resolveDesktopUserDataDir,
  type SessionBackendRequestOptions,
} from "../../src/cli/search-client.js";
import { cli, fixture } from "./fixtures.js";

test("CLI routes session/resource search and reads to the authenticated local desktop bridge", async (t) => {
  const { root, home } = await fixture(t);
  const seen: Array<{ url: string; body: unknown }> = [];
  const token = "a".repeat(64);
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ url: request.url!, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ items: [], nextOffset: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const file = path.join(root, "bridge.json");
  const original = process.env.AGENT_RECALL_MCP_BRIDGE;
  process.env.AGENT_RECALL_MCP_BRIDGE = file;
  t.after(() => {
    if (original === undefined) delete process.env.AGENT_RECALL_MCP_BRIDGE;
    else process.env.AGENT_RECALL_MCP_BRIDGE = original;
  });
  await fs.writeFile(file, JSON.stringify({ host: "127.0.0.1", port: address.port, token }));
  for (const args of [
    ["session", "search", "retry"],
    ["resource", "search", "review", "--scope", "team", "--team", "dev", "--type", "skill"],
    ["resource", "get", "review", "--type", "skill", "--offset", "8"],
    ["session", "get", "codex:test"],
  ]) {
    const result = await cli(home, root, args);
    assert.equal(result.code, 0, result.stdout);
  }
  assert.deepEqual(seen.map((item) => item.url), [
    "/mcp/gateway/sessions/search",
    "/mcp/gateway/resources/search",
    "/mcp/gateway/resources/get",
    "/mcp/gateway/sessions/get",
  ]);
  assert.deepEqual(seen[1]?.body, { query: "review", scope: "team", teamId: "dev", type: "skill" });
  assert.equal((await cli(home, root, ["resource", "search", "x", "--scope", "team"])).code, 2);
  assert.equal((await cli(home, root, ["session", "search", "x", "--limit", "NaN"])).code, 2);
  await fs.writeFile(file, JSON.stringify({ host: "example.com", port: address.port, token }));
  assert.equal((await cli(home, root, ["session", "search", "x"])).result.error?.code, "INVALID_BRIDGE");
  assert.equal(seen.length, 4);
});

test("missing desktop bridge calls the in-process session backend client for local search/get", async (t) => {
  const { root, home } = await fixture(t);
  const calls: Array<{ action: string; body: Record<string, unknown> | undefined; options: SessionBackendRequestOptions | undefined }> = [];
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_RECALL_HOME_DIR: home,
    AGENT_RECALL_USER_DATA_DIR: path.join(root, "user-data"),
    AGENT_RECALL_MCP_BRIDGE: path.join(root, "missing-bridge.json"),
  };
  const requestSessionBackend = async (
    action: "search" | "get" | "status" | "stop",
    body?: Record<string, unknown>,
    options?: SessionBackendRequestOptions,
  ) => {
    calls.push({ action, body, options });
    return { action, body, homeDir: options?.homeDir };
  };

  const query = 'quotes " ; $(touch should-not-exist) `whoami` 中文';
  const searched = await desktopSearch(
    "session",
    "search",
    { query, source: "deepseek-cli", project: "/projects/a b", limit: 7, scope: "local" },
    { env, requestSessionBackend },
  );
  assert.deepEqual(searched, {
    action: "search",
    body: { query, source: "deepseek-cli", project: "/projects/a b", limit: 7 },
    homeDir: home,
  });

  const read = await desktopSearch(
    "session",
    "get",
    { sessionKey: "codex:session with spaces", offset: 4, maxMessages: 8, turnIndex: 2 },
    { env, requestSessionBackend },
  );
  assert.deepEqual(read, {
    action: "get",
    body: { sessionKey: "codex:session with spaces", offset: 4, maxMessages: 8, turnIndex: 2 },
    homeDir: home,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options?.userDataPath, path.join(root, "user-data"));
});

test("a refused desktop connection falls back in-process for local sessions, while team/resources still require desktop", async (t) => {
  const { root, home } = await fixture(t);
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  const bridge = path.join(root, "bridge.json");
  await fs.writeFile(bridge, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "a".repeat(64) }));
  const env = { HOME: home, AGENT_RECALL_MCP_BRIDGE: bridge };
  let calls = 0;
  const requestSessionBackend = async (action: "search" | "get" | "status" | "stop", body?: Record<string, unknown>) => {
    calls += 1;
    return { action, body };
  };

  assert.deepEqual(
    await desktopSearch("session", "search", { query: "offline" }, { env, requestSessionBackend }),
    { action: "search", body: { query: "offline" } },
  );
  assert.equal(calls, 1);

  for (const [kind, args] of [
    ["session", { query: "team", scope: "team", teamId: "dev" }],
    ["resource", { query: "skill" }],
  ] as const) {
    await assert.rejects(desktopSearch(kind, "search", args, { env, requestSessionBackend }), { code: "DESKTOP_UNAVAILABLE" });
  }
  await fs.rm(bridge);
  await assert.rejects(desktopSearch("session", "search", { query: "team", scope: "team", teamId: "dev" }, { env, requestSessionBackend }), { code: "DESKTOP_UNAVAILABLE" });
  await assert.rejects(desktopSearch("resource", "search", { query: "skill" }, { env, requestSessionBackend }), { code: "DESKTOP_UNAVAILABLE" });
  await assert.rejects(desktopSearch("session", "get", { sessionKey: "shared:fixture" }, { env, requestSessionBackend }), { code: "DESKTOP_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("invalid discovery, HTTP failures, and timeouts do not bypass the desktop bridge", async (t) => {
  const { root, home } = await fixture(t);
  const bridge = path.join(root, "bridge.json");
  const env = { HOME: home, AGENT_RECALL_MCP_BRIDGE: bridge };
  let backendCalls = 0;
  const requestSessionBackend = async () => {
    backendCalls += 1;
    return {};
  };

  for (const contents of ["{", JSON.stringify({ host: "example.com", port: 12345, token: "a".repeat(64) })]) {
    await fs.writeFile(bridge, contents);
    await assert.rejects(desktopSearch("session", "search", { query: "x" }, { env, requestSessionBackend }), { code: "INVALID_BRIDGE" });
  }

  let status = 403;
  const server = http.createServer((_request, response) => {
    response.writeHead(status);
    response.end(JSON.stringify({ error: "not allowed" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await fs.writeFile(bridge, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "a".repeat(64) }));
  for (status of [403, 500]) {
    await assert.rejects(desktopSearch("session", "search", { query: "x" }, { env, requestSessionBackend }), { code: "SEARCH_FAILED" });
  }

  await assert.rejects(
    desktopSearch("session", "search", { query: "x" }, {
      env,
      requestSessionBackend,
      fetchImpl: async () => { throw new DOMException("Timed out", "TimeoutError"); },
    }),
    { code: "DESKTOP_UNAVAILABLE" },
  );
  assert.equal(backendCalls, 0);
});

test("headless fallback maps backend errors and rejects desktop-only session options", async (t) => {
  const { root, home } = await fixture(t);
  const env = { HOME: home, AGENT_RECALL_MCP_BRIDGE: path.join(root, "missing-bridge.json") };

  await assert.rejects(
    desktopSearch("session", "get", { sessionKey: "codex:x", maxChars: 50 }, { env, requestSessionBackend: async () => ({}) }),
    { code: "DESKTOP_REQUIRED" },
  );
  await assert.rejects(
    desktopSearch("session", "search", { query: "x" }, {
      env,
      requestSessionBackend: async () => { throw new Error("Session backend response exceeds the 1 MiB limit."); },
    }),
    { code: "RESULT_TOO_LARGE" },
  );
  await assert.rejects(
    desktopSearch("session", "search", { query: "x" }, {
      env,
      requestSessionBackend: async () => {
        const error = new Error("Session backend request timed out after 1000 ms.");
        (error as Error & { code?: string }).code = "ETIMEDOUT";
        throw error;
      },
    }),
    { code: "BACKEND_TIMEOUT" },
  );
  await assert.rejects(
    desktopSearch("session", "search", { query: "x" }, {
      env,
      requestSessionBackend: async () => { throw new Error("Session backend HTTP 403: 工具已关闭"); },
    }),
    { code: "SEARCH_FAILED", message: "Session backend HTTP 403: 工具已关闭" },
  );
});

test("resolveDesktopUserDataDir and resolveDesktopBridgePath honor overrides across platforms", () => {
  assert.equal(
    resolveDesktopUserDataDir({ AGENT_RECALL_USER_DATA_DIR: "/tmp/custom-data" }, "darwin"),
    path.resolve("/tmp/custom-data"),
  );
  assert.equal(
    resolveDesktopBridgePath({ AGENT_RECALL_USER_DATA_DIR: "/tmp/custom-data" }, "linux"),
    path.join(path.resolve("/tmp/custom-data"), "automation-mcp-bridge.json"),
  );
  assert.equal(
    resolveDesktopBridgePath({ AGENT_RECALL_MCP_BRIDGE: "/tmp/explicit-bridge.json" }, "win32"),
    path.resolve("/tmp/explicit-bridge.json"),
  );
});
