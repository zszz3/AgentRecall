import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { requestSessionBackend, acquireSessionBackendMaintenance } from "../bin/session-backend-client.cjs";
import { runSessionBackendCommand } from "../bin/session-backend-cli.cjs";

const token = "a".repeat(64);

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-session-client-"));
  const packagePath = path.join(root, "package");
  const userDataPath = path.join(root, "data");
  await mkdir(path.join(packagePath, "out", "main"), { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({ version: "1.2.3", type: "module" }));
  const options = { packagePath, userDataPath, homeDir: path.join(root, "home"), nodePath: process.execPath };
  context.after(async () => {
    try {
      const discovery = JSON.parse(await readFile(path.join(userDataPath, "session-backend.json"), "utf8"));
      if (discovery.pid !== process.pid) {
        try { process.kill(discovery.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try { process.kill(discovery.pid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    } finally {
      // A terminated child can release its cwd after its PID disappears.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  return { root, options, packagePath, userDataPath };
}

async function discovery(fixture, overrides = {}) {
  await writeFile(path.join(fixture.userDataPath, "session-backend.json"), JSON.stringify({
    protocolVersion: 1, pid: process.pid, host: "127.0.0.1", port: 12345, token,
    packagePath: fixture.packagePath, appVersion: "1.2.3", ...overrides,
  }), { mode: 0o600 });
}

async function serving(context, handler) {
  const instance = createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }));
  return instance.address().port;
}

function statusOr(request, response, handler) {
  if (request.url === "/session/status") {
    response.end(JSON.stringify({ running: true, pid: process.pid, protocolVersion: 1 }));
  } else handler(request, response);
}

async function syntheticBackend(fixture) {
  await writeFile(path.join(fixture.packagePath, "out", "main", "session-backend-entry.js"), `
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
const directory = process.env.AGENT_RECALL_USER_DATA_DIR;
appendFileSync(path.join(directory, 'starts'), 'start\\n');
const server = createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ${token}') { response.writeHead(403); response.end(JSON.stringify({error:'unauthorized'})); return; }
  let data = ''; request.on('data', chunk => data += chunk); request.on('end', () => {
    if (request.url === '/session/status') response.end(JSON.stringify({running:true,pid:process.pid,protocolVersion:1}));
    else if (request.url === '/session/stop') { response.end(JSON.stringify({stopped:true})); server.close(() => { unlinkSync(path.join(directory, 'session-backend.json')); setTimeout(() => process.exit(0), 100); }); }
    else response.end(JSON.stringify({body:JSON.parse(data), home:process.env.AGENT_RECALL_SESSION_HOME, electron:process.env.ELECTRON_RUN_AS_NODE || null, desktop:process.env.AGENT_RECALL_SESSION_DESKTOP_PID || null}));
  });
});
server.listen(0, '127.0.0.1', () => {
  const target = path.join(directory, 'session-backend.json');
  writeFileSync(target + '.tmp', JSON.stringify({protocolVersion:1,pid:process.pid,host:'127.0.0.1',port:server.address().port,token:'${token}',packagePath:process.cwd(),appVersion:JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'))).version}), {mode:0o600});
  renameSync(target + '.tmp', target);
});
`);
}

test("status and stop do not launch a missing backend", async (context) => {
  const f = await fixture(context);
  for (const action of ["status", "stop"]) {
    assert.deepEqual(await requestSessionBackend(action, {}, { ...f.options, start: false }), { running: false });
  }
  await assert.rejects(readFile(path.join(f.userDataPath, "starts")), { code: "ENOENT" });
});

test("concurrent clients start one backend, pass isolated home and reuse it", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  const settled = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => requestSessionBackend("search", { query: `session ${index}` }, f.options)));
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  const results = settled.map((result) => result.value);
  assert.equal(await readFile(path.join(f.userDataPath, "starts"), "utf8"), "start\n");
  assert.deepEqual(results.map((result) => result.body.query), Array.from({ length: 5 }, (_, index) => `session ${index}`));
  assert.equal(results[0].home, f.options.homeDir);
  assert.equal(results[0].electron, null);
  assert.equal(results[0].desktop, null);
  assert.deepEqual(await requestSessionBackend("stop", {}, { ...f.options, start: false }), { stopped: true });
  await assert.rejects(readFile(path.join(f.userDataPath, "session-backend.json")), { code: "ENOENT" });
});

test("a dead discovery PID is replaced by an on-demand backend", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  await discovery(f, { pid: 2147483647 });
  assert.deepEqual((await requestSessionBackend("search", { query: "new" }, f.options)).body, { query: "new" });
  assert.equal(await readFile(path.join(f.userDataPath, "starts"), "utf8"), "start\n");
});

test("remote hosts, malformed discovery and invalid tokens fail without launching", async (context) => {
  const f = await fixture(context);
  await discovery(f, { host: "example.com" });
  await assert.rejects(requestSessionBackend("search", {}, f.options), /Invalid session backend discovery/);
  await discovery(f, { token: "bad" });
  await assert.rejects(requestSessionBackend("search", {}, f.options), /Invalid session backend discovery/);
  await writeFile(path.join(f.userDataPath, "session-backend.json"), "{");
  await assert.rejects(requestSessionBackend("search", {}, f.options), /Invalid session backend discovery JSON/);
});

test("403 and business errors never trigger a replacement backend or expose the token", async (context) => {
  const f = await fixture(context);
  let businessFailure = false;
  const port = await serving(context, (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    if (businessFailure) {
      statusOr(request, response, () => { response.writeHead(500); response.end(JSON.stringify({ error: "search failed" })); });
      return;
    }
    response.writeHead(403); response.end(JSON.stringify({ error: `denied ${token}` }));
  });
  await discovery(f, { port });
  await assert.rejects(requestSessionBackend("search", {}, f.options), (error) => /HTTP 403/.test(error.message) && !error.message.includes(token));
  businessFailure = true;
  await assert.rejects(requestSessionBackend("search", {}, f.options), /HTTP 500: search failed/);
  await assert.rejects(readFile(path.join(f.userDataPath, "starts")), { code: "ENOENT" });
});

test("only an explicit desktop caller passes its PID to the backend", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  const result = await requestSessionBackend("search", {}, { ...f.options, desktopPid: process.pid });
  assert.equal(result.desktop, String(process.pid));
});

test("live package or version mismatches fail without stopping the owner", async (context) => {
  const f = await fixture(context);
  for (const overrides of [{ appVersion: "0.9.0" }, { packagePath: f.root }]) {
    await discovery(f, overrides);
    await assert.rejects(requestSessionBackend("search", {}, { ...f.options, start: false }), /Stop the session backend/);
  }
});

test("explicit status and stop can manage an older or different package", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  await requestSessionBackend("search", {}, f.options);
  const target = path.join(f.userDataPath, "session-backend.json");
  const owner = JSON.parse(await readFile(target, "utf8"));
  await discovery(f, { ...owner, appVersion: "0.9.0", packagePath: path.join(f.root, "removed-package") });
  assert.equal((await requestSessionBackend("status", {}, { ...f.options, start: false })).running, true);
  assert.deepEqual(await requestSessionBackend("stop", {}, { ...f.options, start: false }), { stopped: true });
  assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
});

test("responses are bounded and the timeout includes a stalled response body", async (context) => {
  const f = await fixture(context);
  let mode = "large";
  const port = await serving(context, (request, response) => statusOr(request, response, () => {
    if (mode === "large") response.end('"' + "x".repeat(1024 * 1024) + '"');
    else { response.writeHead(200, { "content-type": "application/json" }); response.write('{"partial":'); }
  }));
  await discovery(f, { port });
  await assert.rejects(requestSessionBackend("search", {}, f.options), /exceeds the 1 MiB limit/);
  mode = "stall";
  await assert.rejects(requestSessionBackend("search", {}, { ...f.options, timeoutMs: 100 }), /timed out/);
});

test("redirects are rejected and never followed", async (context) => {
  const f = await fixture(context);
  const port = await serving(context, (request, response) => statusOr(request, response, () => {
    response.writeHead(302, { location: "http://example.com" }); response.end(JSON.stringify({ error: "redirect" }));
  }));
  await discovery(f, { port });
  await assert.rejects(requestSessionBackend("search", {}, f.options), /HTTP 302/);
});

test("early child exit reports the log path immediately", async (context) => {
  const f = await fixture(context);
  await writeFile(path.join(f.packagePath, "out", "main", "session-backend-entry.js"), "process.exit(17);\n");
  const started = Date.now();
  await assert.rejects(requestSessionBackend("search", {}, f.options), /exited before becoming ready.*session-backend.log/);
  assert.ok(Date.now() - started < 5_000);
});


test("stop refuses a busy backend and does not claim completion while its PID is alive", async (context) => {
  const f = await fixture(context);
  let busy = true;
  const port = await serving(context, (request, response) => statusOr(request, response, () => {
    response.writeHead(busy ? 409 : 200);
    response.end(JSON.stringify(busy ? { error: "Session backend is in use." } : { stopped: true }));
  }));
  await discovery(f, { port });
  await assert.rejects(requestSessionBackend("stop", {}, { ...f.options, start: false }), /HTTP 409.*in use/);
  busy = false;
  await assert.rejects(requestSessionBackend("stop", {}, { ...f.options, start: false, timeoutMs: 100 }), /shutdown did not complete/);
});

test("maintenance waits for full shutdown and blocks cold starts until released", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  await requestSessionBackend("search", {}, f.options);
  const release = await acquireSessionBackendMaintenance(f.options);
  let pending;
  try {
    pending = requestSessionBackend("search", { query: "after maintenance" }, f.options);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await readFile(path.join(f.userDataPath, "starts"), "utf8"), "start\n");
  } finally {
    await release();
    if (pending) await pending;
  }
  assert.equal(await readFile(path.join(f.userDataPath, "starts"), "utf8"), "start\nstart\n");
});

test("public commands validate arguments and forward only supported session fields", async (context) => {
  const f = await fixture(context);
  await syntheticBackend(f);
  let output = "";
  const options = { clientOptions: f.options, write: (text) => { output += text; }, errorWrite: () => assert.fail("JSON failures must use stdout") };
  assert.equal(await runSessionBackendCommand(["session", "get", "codex:fixture", "--offset", "4", "--limit", "8", "--json"], options), 0);
  assert.deepEqual(JSON.parse(output).data.body, { sessionKey: "codex:fixture", offset: 4, maxMessages: 8 });
  output = "";
  assert.equal(await runSessionBackendCommand(["session", "search", "中文", "--limit", "51", "--json"], options), 1);
  assert.equal(JSON.parse(output).ok, false);
  output = "";
  assert.equal(await runSessionBackendCommand(["session", "search", "fixture", "--model", "unused", "--json"], options), 1);
  assert.equal(JSON.parse(output).ok, false);
});
