import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packReleaseArchive } from "./pack-release.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
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
  npm_config_cache: path.join(tempRoot, "npm-cache"),
  npm_config_prefix: prefix,
};

try {
  await Promise.all([packDir, prefix, stageRoot, home].map((directory) => mkdir(directory, { recursive: true })));
  const archive = await packReleaseArchive({ root, destination: packDir, environment });
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
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
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
  const stagedElectronRoot = path.join(stagedRoot, "node_modules", "electron");
  const stagedPackage = JSON.parse(await readFile(path.join(stagedRoot, "package.json"), "utf8"));
  const stagedElectron = JSON.parse(await readFile(path.join(stagedElectronRoot, "package.json"), "utf8"));
  const stagedBridge = JSON.parse(await readFile(
    path.join(stagedElectronRoot, ".agent-recall-staging-bridge.json"),
    "utf8",
  ));
  if (stagedBridge.electronVersion !== "42.3.0" || stagedElectron.version !== stagedBridge.bridgedVersion) {
    throw new Error("Staged package did not contain the verified Electron bridge metadata.");
  }
  if (stagedPackage.dependencies?.electron !== stagedBridge.bridgedVersion) {
    throw new Error("Staged package dependency metadata did not match its Electron bridge.");
  }
  const stagedElectronInstall = await readFile(path.join(stagedElectronRoot, "install.js"), "utf8");
  if (!stagedElectronInstall.includes("applyAgentRecallStagingBridge")) {
    throw new Error("Release package did not contain the legacy Electron update bridge.");
  }
  try {
    await access(path.join(stagedElectronRoot, "path.txt"));
    throw new Error("Release package must not contain a platform-specific Electron runtime.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  require.resolve("@electron/get", { paths: [stagedElectronRoot] });

  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
