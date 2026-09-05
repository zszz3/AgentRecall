import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build as viteBuild } from "vite";
import { packReleaseArchive } from "./pack-release.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const stageRoot = path.join(tempRoot, "stage");
const home = path.join(tempRoot, "home");
const skillVerifierRoot = path.join(tempRoot, "skill-verifier");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
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
let workflowMcpProcess = null;
let localPostgres = null;
let localPostgresClient = null;
const MAX_RELEASE_PACKAGE_BYTES = 4.25 * 1024 * 1024;

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

delete environment.npm_config_allow_scripts;

try {
  await Promise.all([packDir, prefix, stageRoot, home].map((directory) => mkdir(directory, { recursive: true })));
  const archive = await packReleaseArchive({ root, destination: packDir, environment });
  const archiveSize = (await stat(archive)).size;
  if (archiveSize >= MAX_RELEASE_PACKAGE_BYTES) {
    throw new Error(`Release package is ${archiveSize} bytes; expected a package smaller than 4.25 MiB.`);
  }
  await execFileAsync(npm, ["install", "--global", archive, "--prefix", prefix, "--no-audit", "--no-fund"], {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const packageRoots = process.platform === "win32"
    ? [path.join(prefix, "node_modules", "agent-recall-v2")]
    : [path.join(prefix, "lib", "node_modules", "agent-recall-v2"), path.join(prefix, "node_modules", "agent-recall-v2")];
  let installedRoot = null;
  for (const candidate of packageRoots) {
    try { await access(path.join(candidate, "package.json")); installedRoot = candidate; break; } catch { /* try the next npm layout */ }
  }
  if (!installedRoot) throw new Error("Could not locate the package installed into the temporary npm prefix.");
  await Promise.all([
    access(path.join(installedRoot, "out", "main", "index.js")),
    access(path.join(installedRoot, "out", "main", "live-session-worker.js")),
  ]);
  await access(path.join(installedRoot, "out", "mcp", "workflow-entry.js"));
  await access(path.join(installedRoot, "dist", "main", "index.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-memory-hook.cjs"));
  await access(path.join(installedRoot, "bin", "openviking-opencode-plugin.mjs"));
  await access(path.join(installedRoot, "bin", "setup-openviking-memory-hooks.cjs"));
  await access(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"));
  await access(path.join(installedRoot, "assets", "bundled-skills", "rewrite-technical-tutorial", "SKILL.md"));
  const diagramSkillRoot = path.join(installedRoot, "assets", "bundled-skills", "feishu-tech-diagram");
  await access(path.join(diagramSkillRoot, "SKILL.md"));
  await access(path.join(diagramSkillRoot, "tests", "validate_assets.py"));
  const diagramSpecs = JSON.parse(await readFile(path.join(diagramSkillRoot, "references", "template-specs.json"), "utf8"));
  if (!Array.isArray(diagramSpecs) || diagramSpecs.length !== 66) {
    throw new Error("Packaged diagram Skill must include all 66 template specifications.");
  }
  const diagramSamples = await readdir(path.join(diagramSkillRoot, "assets", "samples"));
  if (diagramSamples.filter((entry) => entry.endsWith(".svg")).length !== 66) {
    throw new Error("Packaged diagram Skill must include all 66 SVG samples.");
  }

  // Keep smoke-only entry points out of out/main. The installed package is the
  // Vite root so absolute asset globs read the exact files in the archive.
  await viteBuild({
    root: installedRoot,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    build: {
      ssr: true,
      target: "node22",
      outDir: skillVerifierRoot,
      emptyOutDir: true,
      rollupOptions: {
        input: {
          "bundled-skill-library": path.join(root, "src", "automation", "engine", "shared", "bundled-skill-library.ts"),
          "managed-skill-library": path.join(root, "src", "core", "managed-skill-library.ts"),
        },
        output: {
          entryFileNames: "[name].mjs",
        },
      },
    },
  });

  const bundledSkillLibrary = await import(pathToFileURL(path.join(skillVerifierRoot, "bundled-skill-library.mjs")).href);
  const loadBundledSkillTemplates = bundledSkillLibrary.loadBundledSkillTemplates ?? bundledSkillLibrary.default?.loadBundledSkillTemplates;
  const bundledSkillAssetsFor = bundledSkillLibrary.bundledSkillAssetsFor ?? bundledSkillLibrary.default?.bundledSkillAssetsFor;
  if (typeof loadBundledSkillTemplates !== "function" || typeof bundledSkillAssetsFor !== "function") {
    throw new Error("Packaged bundled Skill loader did not expose its template and asset APIs.");
  }
  const bundledTemplates = loadBundledSkillTemplates();
  for (const templateId of ["rewrite-technical-tutorial", "feishu-tech-diagram"]) {
    if (!bundledTemplates.some((template) => template.id === templateId && template.sourceType === "official")) {
      throw new Error(`Packaged Automation templates did not discover ${templateId}.`);
    }
  }
  const packagedDiagramAssets = bundledSkillAssetsFor("feishu-tech-diagram");
  if (packagedDiagramAssets.filter((asset) => asset.relativePath.startsWith("assets/samples/") && asset.relativePath.endsWith(".svg")).length !== 66) {
    throw new Error("Packaged Automation loader must embed all 66 diagram SVG samples.");
  }

  const managedSkillLibraryModule = await import(pathToFileURL(path.join(skillVerifierRoot, "managed-skill-library.mjs")).href);
  const ManagedSkillLibrary = managedSkillLibraryModule.ManagedSkillLibrary ?? managedSkillLibraryModule.default?.ManagedSkillLibrary;
  if (typeof ManagedSkillLibrary !== "function") throw new Error("Packaged managed Skill library was not exported.");
  const managedLibrary = new ManagedSkillLibrary({
    libraryRoot: path.join(tempRoot, "managed-skills"),
    homeDir: path.join(tempRoot, "managed-home"),
  });
  managedLibrary.ensureBuiltinSkills(path.join(installedRoot, "assets", "bundled-skills"));
  for (const skillId of ["rewrite-technical-tutorial", "feishu-tech-diagram"]) {
    if (!managedLibrary.list().skills.some((skill) => skill.managedId === skillId)) {
      throw new Error(`Packaged managed Skill library did not import ${skillId}.`);
    }
  }
  const managedDiagram = managedLibrary.list().skills.find((skill) => skill.managedId === "feishu-tech-diagram");
  if (!managedDiagram) throw new Error("Packaged managed Skill library did not import feishu-tech-diagram.");
  const managedDiagramSpecs = JSON.parse(await readFile(path.join(managedDiagram.directoryPath, "references", "template-specs.json")));
  if (!Array.isArray(managedDiagramSpecs) || managedDiagramSpecs.length !== 66) {
    throw new Error("Managed Skill import did not retain all 66 diagram template specifications.");
  }
  const managedDiagramSamples = await readdir(path.join(managedDiagram.directoryPath, "assets", "samples"));
  if (managedDiagramSamples.filter((entry) => entry.endsWith(".svg")).length !== 66) {
    throw new Error("Managed Skill import did not retain all 66 diagram SVG samples.");
  }
  const installedRequire = createRequire(path.join(installedRoot, "package.json"));
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
  const workflowMcpEntry = path.join(installedRoot, "bin", "agent-recall-workflow-mcp.mjs");
  await access(workflowMcpEntry);
  await access(path.join(installedRoot, "bin", "agent-recall-skill-mcp.mjs"));
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).bundleDependencies?.includes("electron")) {
    throw new Error("Release package must not bundle Electron.");
  }
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  const mcpResponses = await queryWorkflowMcp(workflowMcpEntry);
  const initialize = mcpResponses.find((item) => item.id === 1);
  const tools = mcpResponses.find((item) => item.id === 2)?.result?.tools;
  if (initialize?.result?.serverInfo?.name !== "agent-recall-v2") throw new Error("Packaged Workflow MCP returned the wrong server identity.");
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "workflow_run_list")) {
    throw new Error("Packaged Workflow MCP did not advertise its read-only workflow tools.");
  }
  if (tools.some((tool) => tool.name === "workflow_create")) {
    throw new Error("Standalone packaged Workflow MCP unexpectedly advertised write tools.");
  }

  await execFileAsync(npm, ["install", "--prefix", stageRoot, archive, "--no-audit", "--no-fund"], {
    cwd: root,
    env: {
      ...environment,
      AGENT_RECALL_STAGING_INSTALL: "1",
      AGENT_RECALL_STAGE_ROOT: stageRoot,
    },
    shell: process.platform === "win32",
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stagedRoot = path.join(stageRoot, "node_modules", "agent-recall-v2");
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
  await stopWorkflowMcp(workflowMcpProcess);
  await localPostgresClient?.end().catch(() => undefined);
  await localPostgres?.stop().catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
