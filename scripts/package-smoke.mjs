import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const home = path.join(tempRoot, "home");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  AGENT_RECALL_TEST_HOME: home,
  AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
  AGENT_RECALL_NO_UPDATE_CHECK: "1",
};
let workflowMcpProcess = null;
let localPostgres = null;
let localPostgresClient = null;

async function chooseAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("Could not allocate a PostgreSQL smoke-test port."));
      });
    });
  });
}

async function stopWorkflowMcp(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!stopped && child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function queryWorkflowMcp(entryPath) {
  const child = spawn(process.execPath, [entryPath], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  workflowMcpProcess = child;
  let stdout = "";
  let stderr = "";
  const responses = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Workflow MCP handshake timed out. ${stderr}`)), 10_000);
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      const parsed = lines.filter(Boolean).map((line) => JSON.parse(line));
      const all = [...(child.__responses ?? []), ...parsed];
      child.__responses = all;
      if (all.some((item) => item.id === 1) && all.some((item) => item.id === 2)) finish(all);
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Workflow MCP exited before handshake (${code}). ${stderr}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
  await stopWorkflowMcp(child);
  workflowMcpProcess = null;
  return responses;
}

try {
  await Promise.all([packDir, prefix, home].map((directory) => mkdir(directory, { recursive: true })));
  const { stdout } = await execFileAsync(npm, ["pack", "--json", "--pack-destination", packDir], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    maxBuffer: 8 * 1024 * 1024,
  });
  const json = stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1];
  if (!json) throw new Error("npm pack did not emit a trailing JSON result.");
  const [packed] = JSON.parse(json);
  if (!packed?.filename) throw new Error("npm pack did not return an archive name.");
  const archive = path.join(packDir, packed.filename);
  await execFileAsync(npm, ["install", "--global", archive, "--prefix", prefix, "--no-audit", "--no-fund"], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packageRoots = process.platform === "win32"
    ? [path.join(prefix, "node_modules", "agent-recall")]
    : [path.join(prefix, "lib", "node_modules", "agent-recall"), path.join(prefix, "node_modules", "agent-recall")];
  let installedRoot = null;
  for (const candidate of packageRoots) {
    try { await access(path.join(candidate, "package.json")); installedRoot = candidate; break; } catch { /* try the next npm layout */ }
  }
  if (!installedRoot) throw new Error("Could not locate the package installed into the temporary npm prefix.");
  await access(path.join(installedRoot, "out", "main", "index.js"));
  await access(path.join(installedRoot, "out", "mcp", "workflow-entry.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-memory-hook.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-opencode-plugin.mjs"));
  await access(path.join(installedRoot, "bin", "setup-openviking-memory-hooks.cjs"));
  await access(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"));
  const installedRequire = createRequire(path.join(installedRoot, "package.json"));
  const embeddedPostgresEntry = installedRequire.resolve("embedded-postgres");
  const { default: EmbeddedPostgres } = await import(pathToFileURL(embeddedPostgresEntry).href);
  localPostgres = new EmbeddedPostgres({
    databaseDir: path.join(tempRoot, "postgres", "data"),
    port: await chooseAvailablePort(),
    user: "agent_recall_smoke",
    password: "agent-recall-package-smoke",
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: ["--encoding=UTF8"],
    postgresFlags: ["-h", "127.0.0.1"],
    onLog: () => undefined,
    onError: () => undefined,
  });
  await localPostgres.initialise();
  await localPostgres.start();
  await localPostgres.createDatabase("agent_recall_smoke");
  localPostgresClient = localPostgres.getPgClient("agent_recall_smoke", "127.0.0.1");
  try {
    await localPostgresClient.connect();
    const result = await localPostgresClient.query("SELECT 1 AS ready");
    if (result.rows[0]?.ready !== 1) throw new Error("Packaged PostgreSQL runtime did not execute a query.");
  } finally {
    await localPostgresClient.end();
    localPostgresClient = null;
    await localPostgres.stop();
    localPostgres = null;
  }
  const workflowMcpEntry = path.join(installedRoot, "bin", "agent-recall-workflow-mcp.mjs");
  await access(workflowMcpEntry);
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  const mcpResponses = await queryWorkflowMcp(workflowMcpEntry);
  const initialize = mcpResponses.find((item) => item.id === 1);
  const tools = mcpResponses.find((item) => item.id === 2)?.result?.tools;
  if (initialize?.result?.serverInfo?.name !== "agent-recall") throw new Error("Packaged Workflow MCP returned the wrong server identity.");
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "workflow_create")) throw new Error("Packaged Workflow MCP did not advertise workflow_create.");
  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await stopWorkflowMcp(workflowMcpProcess);
  await localPostgresClient?.end().catch(() => undefined);
  await localPostgres?.stop().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
