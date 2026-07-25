import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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

async function relativeFiles(rootDirectory, currentDirectory = rootDirectory) {
  const files = [];
  for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
    const entryPath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) files.push(...await relativeFiles(rootDirectory, entryPath));
    else files.push(path.relative(rootDirectory, entryPath));
  }
  return files.sort();
}

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
  await access(path.join(installedRoot, "out", "main", "update-window.js"));
  await access(path.join(installedRoot, "out", "preload", "update-progress.mjs"));
  const updateProgressHtmlPath = path.join(installedRoot, "out", "renderer", "update-progress.html");
  await access(updateProgressHtmlPath);
  await access(path.join(installedRoot, "dist", "main", "index.js"));
  await access(path.join(installedRoot, "bin", "uninstall.cjs"));
  const updateProgressModulePath = path.join(installedRoot, "bin", "update-progress.cjs");
  await access(updateProgressModulePath);
  const { stdout: version } = await execFileAsync(process.execPath, [path.join(installedRoot, "bin", "agent-recall.cjs"), "--version"], { env: environment });
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  if (version.trim() !== packageVersion) throw new Error(`Packaged CLI reported ${version.trim()} instead of ${packageVersion}.`);
  const progressFixture = [
    "const { createTerminalUpdateProgress } = require(process.argv[1]);",
    "const progress = createTerminalUpdateProgress({ stream: process.stdout });",
    "progress.report({ phase: 'downloading', version: '9.9.9', downloadedBytes: 50, totalBytes: 100, percent: 50, bytesPerSecond: 1024 });",
    "progress.report({ phase: 'staging', version: '9.9.9' });",
    "progress.complete('9.9.9');",
    "progress.dispose();",
  ].join("");
  const { stdout: progressOutput } = await execFileAsync(
    process.execPath,
    ["-e", progressFixture, updateProgressModulePath],
    { env: environment },
  );
  if (
    !progressOutput.includes("50%")
    || !progressOutput.includes("正在通过 npm 安装")
    || !progressOutput.includes("v9.9.9")
  ) {
    throw new Error("Packaged terminal updater did not report synthetic update progress.");
  }
  const updateProgressHtml = await readFile(updateProgressHtmlPath, "utf8");
  const rendererAssets = [...updateProgressHtml.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => match[1]);
  if (rendererAssets.length === 0) throw new Error("Packaged update window did not reference its renderer assets.");
  await Promise.all(rendererAssets.map((asset) => access(path.join(installedRoot, "out", "renderer", asset))));

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
  if (
    stagedBridge.stagingRuntimePlatforms?.length !== 1
    || stagedBridge.stagingRuntimePlatforms[0] !== "darwin"
  ) {
    throw new Error("Release package did not identify the macOS-only staging runtime.");
  }
  const stagingExecutable = path.join(
    stagedElectronRoot,
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  const stagingDefaultApp = path.join(
    stagedElectronRoot,
    "dist",
    "Electron.app",
    "Contents",
    "Resources",
    "default_app.asar",
  );
  const stagedRuntimeFiles = await relativeFiles(path.join(stagedElectronRoot, "dist"));
  if (JSON.stringify(stagedRuntimeFiles) !== JSON.stringify([
    path.join("Electron.app", "Contents", "MacOS", "Electron"),
    path.join("Electron.app", "Contents", "Resources", "default_app.asar"),
    "version",
  ].sort())) {
    throw new Error("Release package contained files outside the minimal staging runtime.");
  }
  if (
    await readFile(path.join(stagedElectronRoot, "path.txt"), "utf8") !== "Electron.app/Contents/MacOS/Electron"
    || (await readFile(path.join(stagedElectronRoot, "dist", "version"), "utf8")).trim() !== stagedBridge.bridgedVersion
    || await readFile(stagingDefaultApp, "utf8") !== "agent-recall-staging-runtime\n"
    || await readFile(stagingExecutable, "utf8") !== `#!/bin/sh\nprintf 'v${stagedBridge.bridgedVersion}\\n'\n`
  ) {
    throw new Error("Release package staging runtime did not match its verified sentinel.");
  }
  if (process.platform !== "win32" && ((await stat(stagingExecutable)).mode & 0o111) !== 0o111) {
    throw new Error("Release package staging runtime was not executable.");
  }
  const stagedElectronIndex = await readFile(path.join(stagedElectronRoot, "index.js"), "utf8");
  if (!stagedElectronIndex.includes("getAgentRecallStagingBridgePath")) {
    throw new Error("Release package did not contain the staging runtime resolver.");
  }
  require.resolve("@electron/get", { paths: [stagedElectronRoot] });

  process.stdout.write(`Package smoke test passed for v${packageVersion} (${process.platform}).\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
