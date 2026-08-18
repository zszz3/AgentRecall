import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packReleaseArchive } from "./pack-release.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-package-smoke-"));
const packDir = path.join(tempRoot, "pack");
const prefix = path.join(tempRoot, "prefix");
const stageRoot = path.join(tempRoot, "stage");
const home = path.join(tempRoot, "home");
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
};
delete environment.npm_config_allow_scripts;

try {
  await Promise.all([packDir, prefix, stageRoot, home].map((directory) => mkdir(directory, { recursive: true })));
  const archive = await packReleaseArchive({ root, destination: packDir, environment });
  const archiveSize = (await stat(archive)).size;
  if (archiveSize >= 3 * 1024 * 1024) {
    throw new Error(`Release package is ${archiveSize} bytes; expected a package smaller than 3MB.`);
  }
  await execFileAsync(npm, ["install", "--global", archive, "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund"], {
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
  await access(path.join(installedRoot, "dist", "main", "index.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  await access(path.join(installedRoot, "THIRD_PARTY_NOTICES.md"));
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).bundleDependencies?.includes("electron")) {
    throw new Error("Release package must not bundle Electron.");
  }
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);

  await execFileAsync(npm, ["install", "--prefix", stageRoot, archive, "--ignore-scripts", "--no-audit", "--no-fund"], {
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
  try {
    await access(path.join(home, ".claude", "settings.json"));
    throw new Error("Staging postinstall must not write Claude settings.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
