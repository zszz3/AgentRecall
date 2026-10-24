import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execute = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };

/** Exercises built/installed artifacts with a private HOME and real embedded PostgreSQL. */
export async function runSessionBackendSmoke(packagePath) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-recall-headless-smoke-"));
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_RECALL_HOME_DIR: home, APPDATA: path.join(home, "AppData"),
    XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"), DSH_HOME: path.join(home, ".dsh"),
    AGENT_RECALL_USER_DATA_DIR: data, AGENT_RECALL_TEST_HOME: home, AGENT_RECALL_NODE_PATH: process.execPath,
    AGENT_RECALL_NO_UPDATE_CHECK: "1" };
  delete env.AGENT_RECALL_SESSION_IDLE_TIMEOUT_MS;
  delete env.AGENT_RECALL_DATABASE_URL;
  delete env.AGENT_RECALL_MCP_BRIDGE;
  delete env.AGENT_RECALL_WORKFLOW_MCP_BRIDGE;
  delete env.ELECTRON_RUN_AS_NODE;
  const require = createRequire(import.meta.url);
  const { requestSessionBackend, acquireSessionBackendMaintenance } = require(path.join(packagePath, "bin", "session-backend-client.cjs"));
  const options = { packagePath, userDataPath: data, homeDir: home, nodePath: process.execPath, start: false };
  const cli = async (...args) => {
    try {
      const { stdout } = await execute(process.execPath, [path.join(packagePath, "bin", "agent-recall.cjs"), ...args, "--json"], { env, timeout: 120_000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true, JSON.stringify(result));
      return result.data;
    } catch (error) {
      const log = await readFile(path.join(data, "session-backend.log"), "utf8").catch(() => "");
      throw new Error(`Headless CLI failed: ${error.stdout || error.message}\n${log}`, { cause: error });
    }
  };
  let client;
  let lease;
  let releaseMaintenance;
  let pgPid;
  const waitGone = async (pid) => {
    const deadline = Date.now() + 15_000;
    while (alive(pid) && Date.now() < deadline) await delay(100);
    assert.equal(alive(pid), false, `Process ${pid} did not exit`);
  };
  const readDiscovery = async () => JSON.parse(await readFile(path.join(data, "session-backend.json"), "utf8"));
  try {
    await mkdir(data, { recursive: true });
    await mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
    await writeFile(path.join(data, "config.json"), JSON.stringify({ includeDeepSeekCli: true }));
    const codexFile = path.join(home, ".codex", "sessions", "fixture.jsonl");
    const message = (text, role = "user") => ({ type: "response_item", timestamp: "2026-10-23T00:00:01Z", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    await writeFile(codexFile, [
      { type: "session_meta", timestamp: "2026-10-23T00:00:00Z", payload: { id: "headless-fixture", cwd: root } },
      message("headlessfixture initial Codex conversation"),
      message("fixture answer", "assistant"),
    ].map(JSON.stringify).join("\n") + "\n");
    const dshFile = path.join(home, ".dsh", "sessions", "--fixture--", "dsh-fixture", "session.v4.jsonl.zstd");
    await mkdir(path.dirname(dshFile), { recursive: true });
    await writeFile(dshFile, zstdCompressSync(Buffer.from([
      { type: "session", version: 4, id: "dsh-fixture", createdAt: 1792713600000, cwd: root, delegationDepth: 0 },
      { type: "user/message", seq: 0, time: 1792713600001, data: { id: "m1", role: "user", content: [{ type: "text", text: "headlessfixture DSH conversation" }], source: { kind: "user" } }, surfaceOp: "append" },
    ].map(JSON.stringify).join("\n") + "\n")));
    assert.deepEqual(await cli("backend", "status"), { running: false });
    const started = await cli("backend", "start");
    assert.equal(started.running, true);
    assert.equal(started.lifecycle, "persistent");
    assert.equal(started.backgroundRefreshIntervalMs, 10 * 60_000);
    const initial = await cli("session", "search", "headlessfixture");
    assert.equal(initial.length, 2);
    const first = await readDiscovery();
    assert.notEqual(first.pid, process.pid);
    pgPid = Number((await readFile(path.join(data, "postgres", "data", "postmaster.pid"), "utf8")).split("\n")[0]);
    lease = await requestSessionBackend("attach", {}, options);
    const results = await Promise.all(Array.from({ length: 3 }, () => cli("session", "search", "headlessfixture")));
    assert.ok(results.every((value) => value.length === 2));
    assert.equal((await readDiscovery()).pid, first.pid);
    await assert.rejects(requestSessionBackend("stop", {}, options), /409.*in use/);
    await assert.rejects(acquireSessionBackendMaintenance(options), /409.*in use/);
    await appendFile(codexFile, JSON.stringify(message("freshappendfixture")) + "\n");
    client = new Client({ name: "headless-smoke", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(packagePath, "out", "mcp", "gateway-entry.js")], env, stderr: "pipe" }));
    const tool = async (name, args) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, JSON.stringify(response));
      return JSON.parse(response.content[0].text);
    };
    await assert.rejects(client.callTool({ name: "search_sessions", arguments: { query: "headlessfixture", scope: "team", teamId: "fixture" } }), /desktop app first/);
    await assert.rejects(client.callTool({ name: "search_resources", arguments: { query: "fixture" } }), /desktop app first/);
    const fresh = await tool("search_sessions", { query: "freshappendfixture" });
    assert.equal(fresh.length, 1);
    const read = await tool("get_session", { sessionKey: fresh[0].sessionKey });
    assert.ok(read.messages.some((item) => item.content.includes("freshappendfixture")));
    assert.equal((await readDiscovery()).pid, first.pid);
    await writeFile(path.join(data, "mcp-runtime.json"), JSON.stringify({ disabledTools: ["get_session"] }));
    await assert.rejects(client.callTool({ name: "get_session", arguments: { sessionKey: fresh[0].sessionKey } }), /403.*工具已关闭/);
    await writeFile(path.join(data, "mcp-runtime.json"), "{}");
    await writeFile(path.join(data, "config.json"), JSON.stringify({ includeDeepSeekCli: false }));
    assert.equal((await cli("session", "search", "headlessfixture")).length, 1);
    await requestSessionBackend("release", { leaseId: lease.leaseId }, options);
    lease = undefined;
    // The service and PostgreSQL stay resident after the desktop lease is gone,
    // regardless of the still-connected stdio process. Only an explicit stop exits.
    await delay(1250);
    assert.equal(alive(first.pid), true);
    assert.equal(alive(pgPid), true);
    assert.equal((await cli("backend", "status")).desktopClients, 0);
    assert.deepEqual(await cli("backend", "stop"), { stopped: true });
    await waitGone(first.pid);
    await waitGone(pgPid);
    assert.deepEqual(await cli("backend", "status"), { running: false });
    assert.equal((await tool("search_sessions", { query: "freshappendfixture" })).length, 1);
    const restarted = await readDiscovery();
    assert.notEqual(restarted.pid, first.pid);
    // Crash recovery must wait out the stale owner lease, then adopt the existing
    // managed PostgreSQL process so it too is stopped on the next normal exit.
    lease = await requestSessionBackend("attach", {}, options);
    process.kill(restarted.pid, "SIGKILL");
    await waitGone(restarted.pid);
    lease = undefined;
    assert.equal((await tool("search_sessions", { query: "freshappendfixture" })).length, 1);
    const recovered = await readDiscovery();
    assert.notEqual(recovered.pid, restarted.pid);
    pgPid = Number((await readFile(path.join(data, "postgres", "data", "postmaster.pid"), "utf8")).split("\n")[0]);
    await client.close();
    client = undefined;
    releaseMaintenance = await acquireSessionBackendMaintenance(options);
    await waitGone(recovered.pid);
    await releaseMaintenance();
    releaseMaintenance = undefined;
    assert.deepEqual(await cli("backend", "status"), { running: false });
    console.log("Headless smoke passed: resident service, Codex/DSH, fresh append, concurrent CLI/MCP, permissions, leases, explicit PostgreSQL stop and crash recovery.");
  } catch (error) {
    console.error(await readFile(path.join(data, "session-backend.log"), "utf8").catch(() => "Backend log unavailable."));
    throw error;
  } finally {
    await client?.close();
    if (lease) await requestSessionBackend("release", { leaseId: lease.leaseId }, options);
    await releaseMaintenance?.();
    await requestSessionBackend("stop", {}, options);
    if (pgPid) await waitGone(pgPid);
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runSessionBackendSmoke(path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..")));
}
