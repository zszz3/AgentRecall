import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import test from "node:test";
import { cli, fixture } from "./fixtures.js";

test("CLI routes session/resource search and reads to the authenticated local V2 service", async t => {
  const { root, home } = await fixture(t);
  const seen: Array<{ url: string; body: unknown }> = [];
  const token = "a".repeat(64);
  const server = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let body = ""; for await (const chunk of request) body += chunk;
    seen.push({ url: request.url!, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ items: [], nextOffset: null }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const file = path.join(root, "bridge.json"); const original = process.env.AGENT_RECALL_MCP_BRIDGE;
  process.env.AGENT_RECALL_MCP_BRIDGE = file;
  t.after(() => { if (original === undefined) delete process.env.AGENT_RECALL_MCP_BRIDGE; else process.env.AGENT_RECALL_MCP_BRIDGE = original; });
  await fs.writeFile(file, JSON.stringify({ host: "127.0.0.1", port: address.port, token }));
  for (const args of [["session", "search", "retry"], ["resource", "search", "review", "--scope", "team", "--team", "dev", "--type", "skill"], ["resource", "get", "review", "--type", "skill", "--offset", "8"], ["session", "get", "codex:test"]]) {
    const result = await cli(home, root, args); assert.equal(result.code, 0, result.stdout);
  }
  assert.deepEqual(seen.map(item => item.url), ["/mcp/gateway/sessions/search", "/mcp/gateway/resources/search", "/mcp/gateway/resources/get", "/mcp/gateway/sessions/get"]);
  assert.deepEqual(seen[1]?.body, { query: "review", scope: "team", teamId: "dev", type: "skill" });
  assert.equal((await cli(home, root, ["resource", "search", "x", "--scope", "team"])).code, 2);
  assert.equal((await cli(home, root, ["session", "search", "x", "--limit", "NaN"])).code, 2);
  await fs.writeFile(file, JSON.stringify({ host: "example.com", port: address.port, token }));
  assert.equal((await cli(home, root, ["session", "search", "x"])).result.error?.code, "INVALID_BRIDGE");
  assert.equal(seen.length, 4);
});
