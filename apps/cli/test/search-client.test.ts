import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import test, { type TestContext } from "node:test";
import { cli, fixture } from "./fixtures.js";
import { desktopSearch } from "../src/search-client.js";

async function backgroundFixture(t: TestContext, layout: "npm" | "posix" = "npm") {
  const { root, home } = await fixture(t);
  const bin = path.join(root, "prefix", "bin");
  await fs.mkdir(bin, { recursive: true });
  const packagePath = layout === "npm" ? path.join(bin, "node_modules", "agent-recall-v2") : path.join(root, "prefix", "lib", "node_modules", "agent-recall-v2");
  const launcher = path.join(packagePath, "bin", "agent-recall.cjs");
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({ name: "agent-recall-v2" }));
  await fs.writeFile(path.join(path.dirname(launcher), "session-backend-client.cjs"), "// Synthetic package capability marker.\n");
  const marker = path.join(root, "invocations");
  await fs.writeFile(launcher, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(marker)}, 'called\\n'); console.log(JSON.stringify({ok:true,data:{argv:process.argv.slice(2),home:process.env.HOME}}));\n`);
  const environment = { PATH: bin, HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), XDG_CONFIG_HOME: path.join(home, "config"), AGENT_RECALL_MCP_BRIDGE: path.join(root, "bridge.json") };
  const original = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  return { root, home, bin, launcher, marker, bridge: environment.AGENT_RECALL_MCP_BRIDGE };
}

function resultArguments(value: unknown): string[] {
  assert.ok(value && typeof value === "object" && "argv" in value && Array.isArray(value.argv));
  return value.argv;
}

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

test("missing desktop bridge uses an installed V2 launcher for search/get without a shell", async t => {
  const f = await backgroundFixture(t);
  const query = 'quotes " ; $(touch should-not-exist) `whoami` 中文';
  const searched = await desktopSearch("session", "search", { query, source: "deepseek-cli", project: "/projects/a b", limit: 7, scope: "local" });
  assert.deepEqual(resultArguments(searched), ["session", "search", query, "--json", "--source", "deepseek-cli", "--project", "/projects/a b", "--limit", "7"]);
  const read = await desktopSearch("session", "get", { sessionKey: "codex:session with spaces", offset: 4, maxMessages: 8 });
  assert.deepEqual(resultArguments(read), ["session", "get", "codex:session with spaces", "--json", "--offset", "4", "--limit", "8"]);
  assert.ok(searched && typeof searched === "object" && "home" in searched);
  assert.equal(searched.home, f.home);
  assert.equal(await fs.readFile(f.marker, "utf8"), "called\ncalled\n");
});

test("POSIX PATH symlinks resolve the actual V2 JavaScript launcher", { skip: process.platform === "win32" }, async t => {
  const f = await backgroundFixture(t, "posix");
  await fs.symlink(f.launcher, path.join(f.bin, "agent-recall-v2"));
  assert.deepEqual(resultArguments(await desktopSearch("session", "search", { query: "linked" })), ["session", "search", "linked", "--json"]);
});

test("a refused desktop connection falls back but team and resources still require desktop", async t => {
  const f = await backgroundFixture(t);
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.writeFile(f.bridge, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "a".repeat(64) }));
  assert.deepEqual(resultArguments(await desktopSearch("session", "search", { query: "offline" })), ["session", "search", "offline", "--json"]);
  await fs.rm(f.marker);
  for (const [kind, args] of [["session", { query: "team", scope: "team", teamId: "dev" }], ["resource", { query: "skill" }]] as const) {
    await assert.rejects(desktopSearch(kind, "search", args), { code: "DESKTOP_UNAVAILABLE" });
  }
  await fs.rm(f.bridge);
  await assert.rejects(desktopSearch("session", "search", { query: "team", scope: "team", teamId: "dev" }), { code: "DESKTOP_UNAVAILABLE" });
  await assert.rejects(desktopSearch("resource", "search", { query: "skill" }), { code: "DESKTOP_UNAVAILABLE" });
  await assert.rejects(desktopSearch("session", "get", { sessionKey: "shared:fixture" }), { code: "DESKTOP_UNAVAILABLE" });
  await assert.rejects(fs.readFile(f.marker), { code: "ENOENT" });
});

test("invalid discovery, HTTP failures and timeouts do not bypass the desktop bridge", async t => {
  const f = await backgroundFixture(t);
  for (const contents of ["{", JSON.stringify({ host: "example.com", port: 12345, token: "a".repeat(64) })]) {
    await fs.writeFile(f.bridge, contents);
    await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "INVALID_BRIDGE" });
  }
  let status = 403;
  const server = http.createServer((_request, response) => { response.writeHead(status); response.end(JSON.stringify({ error: "not allowed" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await fs.writeFile(f.bridge, JSON.stringify({ host: "127.0.0.1", port: address.port, token: "a".repeat(64) }));
  for (status of [403, 500]) await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "SEARCH_FAILED" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException("Timed out", "TimeoutError"); };
  try { await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "DESKTOP_UNAVAILABLE" }); }
  finally { globalThis.fetch = originalFetch; }
  await assert.rejects(fs.readFile(f.marker), { code: "ENOENT" });
});

test("missing, old and failing V2 installations report actionable errors", async t => {
  const f = await backgroundFixture(t);
  await fs.rm(path.dirname(path.dirname(f.launcher)), { recursive: true });
  await assert.rejects(desktopSearch("session", "search", { query: "x" }), error => error instanceof Error && "code" in error && error.code === "V2_UNAVAILABLE" && /安装或更新/.test(error.message));
  await fs.mkdir(path.dirname(f.launcher), { recursive: true });
  await fs.writeFile(path.join(path.dirname(f.launcher), "..", "package.json"), JSON.stringify({ name: "unrelated" }));
  await fs.writeFile(f.launcher, "console.log('starting Electron');\n");
  await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "V2_UNAVAILABLE" });
  await fs.writeFile(path.join(path.dirname(f.launcher), "..", "package.json"), JSON.stringify({ name: "agent-recall-v2" }));
  await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "V2_UPDATE_REQUIRED" });
  await fs.writeFile(path.join(path.dirname(f.launcher), "session-backend-client.cjs"), "// Synthetic package capability marker.\n");
  await assert.rejects(desktopSearch("session", "search", { query: "x" }), { code: "V2_UPDATE_REQUIRED" });
  await fs.writeFile(f.launcher, "console.log(JSON.stringify({ok:false,error:{code:'INDEX_FAILED',message:'fixture index failed'}})); process.exitCode=1;\n");
  await assert.rejects(desktopSearch("session", "get", { sessionKey: "codex:x" }), { code: "INDEX_FAILED", message: "fixture index failed" });
  await fs.writeFile(f.launcher, "process.stdout.write('x'.repeat(2 * 1024 * 1024));\n");
  await assert.rejects(desktopSearch("session", "search", { query: "large" }), { code: "RESULT_TOO_LARGE" });
  await assert.rejects(desktopSearch("session", "get", { sessionKey: "codex:x", maxChars: 50 }), { code: "DESKTOP_REQUIRED" });
});
