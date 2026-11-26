import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packReleaseArchive, resolveNpmInvocation } from "./pack-release.mjs";
import { ensureIsolatedGitPath } from "./run-cli-tests.mjs";
import { runSessionBackendSmoke } from "./session-backend-smoke.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const stageRoot = path.join(tempRoot, "stage");
const home = path.join(tempRoot, "home");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  AGENT_RECALL_TEST_HOME: home,
  AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
  AGENT_RECALL_NO_UPDATE_CHECK: "1",
  electron_config_cache: path.join(tempRoot, "electron-cache"),
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  npm_config_cache: process.env.AGENT_RECALL_TEST_NPM_CACHE || path.join(tempRoot, "npm-cache"),
  npm_config_prefix: prefix,
  npm_config_registry: "https://registry.npmjs.org/",
};
let gatewayMcpProcess = null;
let localPostgres = null;
let localPostgresClient = null;
const MAX_RELEASE_PACKAGE_BYTES = 4.3 * 1024 * 1024;

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

async function stopGatewayMcp(child) {
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

async function queryGatewayMcp(entryPath) {
  const child = spawn(process.execPath, [entryPath], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  gatewayMcpProcess = child;
  let stdout = "";
  let stderr = "";
  const responses = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Gateway MCP handshake timed out. ${stderr}`)), 10_000);
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
    child.once("exit", (code) => reject(new Error(`Gateway MCP exited before handshake (${code}). ${stderr}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
  await stopGatewayMcp(child);
  gatewayMcpProcess = null;
  return responses;
}

delete environment.npm_config_allow_scripts;

try {
  await Promise.all([packDir, prefix, stageRoot, home].map((directory) => mkdir(directory, { recursive: true })));
  const archive = await packReleaseArchive({ root, destination: packDir, environment });
  const archiveSize = (await stat(archive)).size;
  if (archiveSize >= MAX_RELEASE_PACKAGE_BYTES) {
    throw new Error(`Release package is ${archiveSize} bytes; expected a package smaller than 4.30 MiB.`);
  }
  const globalInstall = resolveNpmInvocation(
    ["install", "--global", archive, "--prefix", prefix, "--no-audit", "--no-fund"],
    environment,
  );
  await execFileAsync(globalInstall.command, globalInstall.args, {
    cwd: root,
    env: environment,
    shell: false,
    windowsHide: true,
    ...(globalInstall.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
  await Promise.all([
    access(path.join(installedRoot, "out", "main", "index.js")),
    access(path.join(installedRoot, "out", "main", "live-session-worker.js")),
    access(path.join(installedRoot, "out", "main", "session-index-worker.js")),
    access(path.join(installedRoot, "out", "main", "session-backend-entry.js")),
    access(path.join(installedRoot, "out", "cli", "index.js")),
    access(path.join(installedRoot, "bin", "session-backend-client.cjs")),
    access(path.join(installedRoot, "bin", "session-backend-cli.cjs")),
    access(process.platform === "win32" ? path.join(prefix, "agent-recall.cmd") : path.join(prefix, "bin", "agent-recall")),
    access(process.platform === "win32" ? path.join(prefix, "agentrecall.cmd") : path.join(prefix, "bin", "agentrecall")),
  ]);
  const gatewayMcpEntry = path.join(installedRoot, "out", "mcp", "gateway-entry.js");
  await access(gatewayMcpEntry);
  await access(path.join(installedRoot, "dist", "main", "index.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  await access(path.join(installedRoot, "bin", "remove-legacy-memory-hooks.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-memory-hook.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-opencode-plugin.mjs"));
  await access(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"));
  await access(path.join(installedRoot, "assets", "app-icon.png"));
  await access(path.join(installedRoot, "assets", "tray-iconTemplate.png"));
  const rendererAssets = await readdir(path.join(installedRoot, "out", "renderer", "assets"));
  if (!rendererAssets.some((file) => /^logo-.*\.png$/.test(file))) throw new Error("The renderer's bundled brand logo is missing.");
  const sourceAssets = await readdir(path.join(installedRoot, "assets"));
  if (sourceAssets.some((file) => ["logo.png", "show.png", "star-history.svg", "star-history-data.json"].includes(file))) {
    throw new Error("Release packages must not include redundant source or documentation media.");
  }
  const automationSkillIds = [
    "brainstorming",
    "frontend-design",
    "feishu-tech-diagram",
    "handoff",
    "skill-creator",
    "systematic-debugging",
    "personal-finance-planning",
    "resume-optimization",
    "paper-writing",
    "rewrite-technical-tutorial",
    "refactor-review-knowledge",
    "code-review-and-quality",
  ];
  await Promise.all(
    automationSkillIds.map((id) =>
      access(path.join(installedRoot, "assets", "bundled-skills", id, "SKILL.md")),
    ),
  );
  const diagramSkillRoot = path.join(installedRoot, "assets", "bundled-skills", "feishu-tech-diagram");
  await access(path.join(diagramSkillRoot, "tests", "validate_assets.py"));
  const diagramSpecs = JSON.parse(await readFile(path.join(diagramSkillRoot, "references", "template-specs.json"), "utf8"));
  if (!Array.isArray(diagramSpecs) || diagramSpecs.length !== 66) {
    throw new Error("Packaged diagram Skill must include all 66 template specifications.");
  }
  const diagramSamples = await readdir(path.join(diagramSkillRoot, "assets", "samples"));
  if (diagramSamples.filter((entry) => entry.endsWith(".svg")).length !== 66) {
    throw new Error("Packaged diagram Skill must include all 66 SVG samples.");
  }
  const installedRequire = createRequire(path.join(installedRoot, "package.json"));
  installedRequire.resolve("proper-lockfile");
  const {
    restoreEmbeddedPostgresNativeLinks,
  } = installedRequire("./bin/staged-package-dependencies.cjs");
  await restoreEmbeddedPostgresNativeLinks(path.join(installedRoot, "node_modules"));
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
  await runSessionBackendSmoke(installedRoot);
  await access(path.join(installedRoot, "bin", "agent-recall-skill-mcp.mjs"));
  const cliBin = path.join(installedRoot, "bin", "agent-recall.cjs");
  const cliGitConfig = path.join(tempRoot, "cli-gitconfig");
  await writeFile(cliGitConfig, "", "utf8");
  const cliEnvironment = ensureIsolatedGitPath({
    ...environment,
    AGENTRECALL_HOME: path.join(home, ".agentrecall-cli"),
    AGENT_RECALL_USER_DATA_DIR: path.join(tempRoot, "cli-user-data"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: cliGitConfig,
  });
  const { stdout: version } = await execFileAsync(process.execPath, [cliBin, "--version"], { env: cliEnvironment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).bundleDependencies?.includes("electron")) {
    throw new Error("Release package must not bundle Electron.");
  }
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  const runCliJson = async (args, cwd = tempRoot) => {
    const { stdout } = await execFileAsync(process.execPath, [cliBin, ...args, "--json"], { cwd, env: cliEnvironment });
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) throw new Error(`Packaged CLI command failed: ${args.join(" ")} -> ${stdout}`);
    return parsed.data;
  };
  if ((await runCliJson(["--version"])).version !== packageVersion) {
    throw new Error("Packaged CLI --version --json returned an unexpected version.");
  }
  if (!(await runCliJson(["--help"])).help.includes("agent-recall")) {
    throw new Error("Packaged CLI --help did not include unified usage.");
  }
  try {
    await execFileAsync(process.execPath, [cliBin, "unknown-subcommand", "--json"], { env: cliEnvironment });
    throw new Error("Packaged CLI accepted an unknown subcommand.");
  } catch (error) {
    if (error?.code !== 2) throw new Error(`Expected exit code 2 for unknown subcommand, got ${error?.code}.`);
  }
  if ((await runCliJson(["init"])).config.teamEnabled !== false) {
    throw new Error("Packaged CLI init did not create a disabled-by-default team config.");
  }
  const smokeRepo = path.join(tempRoot, "business-repo");
  await mkdir(smokeRepo, { recursive: true });
  await execFileAsync("git", ["init", "-q", smokeRepo], { env: cliEnvironment });
  await execFileAsync("git", ["-C", smokeRepo, "remote", "add", "origin", "git@github.com:example/business.git"], { env: cliEnvironment });
  await runCliJson(["team", "add", "example", "--repo", "https://github.com/example/assets"]);
  await runCliJson(["directory", "add", smokeRepo, "--team", "example", "--target", "codex,claude"]);
  await runCliJson(["project", "add", "business", "--path", smokeRepo, "--team", "example"]);
  await runCliJson(["team", "enable"]);
  if ((await runCliJson(["team", "current"], smokeRepo)).team.id !== "example") {
    throw new Error("Packaged CLI did not resolve the active team.");
  }
  const skillFiles = [{ path: "SKILL.md", content: Buffer.from("---\nname: review\ndescription: Smoke review\n---\nReview the change.\n").toString("base64"), executable: false }];
  const commit = "1".repeat(40);
  await mkdir(path.join(cliEnvironment.AGENTRECALL_HOME, "assets"), { recursive: true });
  await writeFile(path.join(cliEnvironment.AGENTRECALL_HOME, "assets", "example.json"), JSON.stringify({
    schemaVersion: 1,
    repository: "https://github.com/example/assets",
    commit,
    skills: [{ id: "review", description: "Smoke review", files: skillFiles, digest: createHash("sha256").update(JSON.stringify(skillFiles)).digest("hex") }],
  }));
  const installedSkill = await runCliJson(["skill", "install", "review", "--target", "claude", "--revision", commit], smokeRepo);
  if (installedSkill.status !== "installed") throw new Error("Packaged CLI skill install failed.");
  const doctorReport = await runCliJson(["doctor"], smokeRepo);
  if (doctorReport.project?.id !== "business" || doctorReport.healthy !== true) {
    throw new Error(`Packaged CLI doctor returned unexpected status: ${JSON.stringify(doctorReport)}`);
  }
  const mcpResponses = await queryGatewayMcp(gatewayMcpEntry);
  const initialize = mcpResponses.find((item) => item.id === 1);
  const tools = mcpResponses.find((item) => item.id === 2)?.result?.tools;
  if (initialize?.result?.serverInfo?.name !== "agent-recall") throw new Error("Packaged gateway MCP returned the wrong server identity.");
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "search_sessions")) {
    throw new Error("Packaged gateway MCP did not advertise its session tools.");
  }

  const stageEnvironment = {
    ...environment,
    AGENT_RECALL_STAGING_INSTALL: "1",
    AGENT_RECALL_STAGE_ROOT: stageRoot,
  };
  const stageInstall = resolveNpmInvocation(
    ["install", "--prefix", stageRoot, archive, "--no-audit", "--no-fund"],
    stageEnvironment,
  );
  await execFileAsync(stageInstall.command, stageInstall.args, {
    cwd: root,
    env: stageEnvironment,
    shell: false,
    windowsHide: true,
    ...(stageInstall.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stagedRoot = path.join(stageRoot, "node_modules", "agent-recall");
  await execFileAsync(process.execPath, [path.join(stagedRoot, "bin", "install-claude-statusline.cjs")], {
    cwd: stagedRoot,
    env: {
      ...environment,
      AGENT_RECALL_STAGING_INSTALL: "1",
      AGENT_RECALL_STAGE_ROOT: stageRoot,
    },
  });
  const stagedPackage = JSON.parse(await readFile(path.join(stagedRoot, "package.json"), "utf8"));
  if (stagedPackage.bundleDependencies?.includes("electron")) {
    throw new Error("Staged package unexpectedly bundles Electron.");
  }
  await Promise.all([
    access(path.join(stagedRoot, "node_modules", "electron", "package.json")),
    access(path.join(stagedRoot, "node_modules", "electron-store", "package.json")),
  ]);
  const stagedEmbeddedPostgresRoot = path.join(stagedRoot, "node_modules", "@embedded-postgres");
  for (const platformPackage of await readdir(stagedEmbeddedPostgresRoot)) {
    const platformPackageRoot = path.join(stagedEmbeddedPostgresRoot, platformPackage);
    let nativeLinks;
    try {
      nativeLinks = JSON.parse(
        await readFile(path.join(platformPackageRoot, "native", "pg-symlinks.json"), "utf8"),
      );
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    await Promise.all(nativeLinks.map(({ target }) => access(path.join(platformPackageRoot, target))));
  }
  try {
    await access(path.join(home, ".claude", "settings.json"));
    throw new Error("Staging postinstall must not write Claude settings.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await stopGatewayMcp(gatewayMcpProcess);
  await localPostgresClient?.end().catch(() => undefined);
  await localPostgres?.stop().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
