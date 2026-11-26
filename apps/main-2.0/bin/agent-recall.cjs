#!/usr/bin/env node
"use strict";

// Launches the built Electron app from a global npm install. Running through
// Node (rather than a double-clicked .app bundle) means macOS Gatekeeper does
// not require code signing or notarization.
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { pathToFileURL } = require("node:url");

const CLI_SUBCOMMANDS = new Set([
  "init",
  "status",
  "doctor",
  "session",
  "resource",
  "team",
  "directory",
  "skill",
  "work-config",
  "project",
]);

async function runUnifiedCli(argv, version) {
  const packagePath = path.resolve(__dirname, "..");
  const bundlePath = path.join(packagePath, "out", "cli", "index.js");
  try {
    await fs.access(bundlePath);
  } catch {
    const message = "未找到已构建的 CLI 模块（out/cli/index.js），请先运行 npm run build。";
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "CLI_NOT_BUILT", message } })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }
  const { runCli } = await import(pathToFileURL(bundlePath).href);
  return runCli(argv, { version, packagePath });
}

function parseDesktopFlags(argv) {
  let waitPid = NaN;
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--wait-pid") {
      const value = argv[index + 1];
      if (!value || !/^\d+$/.test(value)) return null;
      waitPid = Number(value);
      index += 1;
      continue;
    }
    if (arg === "--check-update" || arg === "--update" || arg === "--no-update-check") {
      flags.add(arg);
      continue;
    }
    if (process.platform === "darwin" && arg.startsWith("-psn_")) {
      continue;
    }
    return null;
  }
  return { flags, waitPid };
}

const {
  checkForUpdate,
  currentVersion,
  ensureElectronRuntimeForLaunch,
  formatUpdateNotice,
  isElectronRuntimeReady,
  readUpdatePreference,
  recoverInterruptedUpdate,
  skipUpdateVersion,
  snoozeUpdatePrompt,
  waitForUpdateCompletion,
  waitForProcessExit,
} = require("./update-client.cjs");
const {
  restoreEmbeddedPostgresNativeLinks,
} = require("./staged-package-dependencies.cjs");
const { assertEmbeddedPostgresRuntime } = require("./embedded-postgres-runtime.cjs");

async function scheduleUpdate(manifest, { stopApp }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-apply-"));
  const manifestPath = path.join(directory, "update.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const args = [path.join(__dirname, "apply-update.cjs"), "--manifest", manifestPath];
  if (stopApp) args.push("--stop-app");
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, AGENT_RECALL_NODE_PATH: process.execPath },
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`更新进程被信号 ${signal} 中止。`));
      else resolve(code ?? 1);
    });
  }).catch(async (error) => {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  });
  if (exitCode !== 0) throw new Error("更新未完成，请查看上方错误信息。");
}

function launchApp() {
  // The `electron` dependency resolves to the path of the Electron executable.
  const electronPath = require("electron");
  const appPath = path.join(__dirname, "..");
  const environment = { ...process.env };
  environment.AGENT_RECALL_NODE_PATH = process.execPath;
  if (environment.AGENT_RECALL_SOURCE_BUILD !== "1") {
    environment.AGENT_RECALL_RELEASE_BUILD = "1";
  } else {
    delete environment.AGENT_RECALL_RELEASE_BUILD;
  }
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [appPath], { detached: true, stdio: "ignore", env: environment });
  child.on("error", (error) => {
    console.error("Failed to launch AgentRecall:", error.message);
    process.exitCode = 1;
  });
  child.unref();
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];
  const version = currentVersion();

  if (first === "backend") {
    process.exitCode = await require("./session-backend-cli.cjs").runSessionBackendCommand(argv);
    return;
  }
  if (first === "help" || argv.includes("--help") || argv.includes("-h") || CLI_SUBCOMMANDS.has(first)) {
    const normalized = first === "help" ? ["--help", ...argv.slice(1)] : argv;
    process.exitCode = await runUnifiedCli(normalized, version);
    return;
  }
  if (
    argv.length >= 1
    && argv.length <= 2
    && argv.every((arg) => arg === "--version" || arg === "-v" || arg === "--json")
    && argv.some((arg) => arg === "--version" || arg === "-v")
  ) {
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { version } })}\n`);
    } else {
      process.stdout.write(`${version}\n`);
    }
    return;
  }
  if (argv.length === 1 && first === "uninstall") {
    const { uninstall } = require("./uninstall.cjs");
    const result = await uninstall();
    for (const message of result.messages) process.stdout.write(`${message}\n`);
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    if (result.errors.length > 0) process.exitCode = 1;
    return;
  }
  if (argv.length === 1 && first === "install-app") {
    const { installMacosApp } = require("./install-macos-app.cjs");
    const result = installMacosApp();
    if (result.status === "installed") {
      process.stdout.write(`已生成 ${result.appPath}，现在可以从 Launchpad / Spotlight / Dock 打开 AgentRecall。\n`);
      for (const warning of result.warnings) process.stdout.write(`${warning}\n`);
    } else if (result.status === "unsupported") {
      process.stdout.write("install-app 目前仅支持 macOS。\n");
    } else {
      process.stderr.write(`生成 AgentRecall.app 失败：${result.detail}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const parsedDesktop = parseDesktopFlags(argv);
  if (!parsedDesktop) {
    const message = "未知命令或选项，请运行 agent-recall --help 查看用法。";
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "INVALID_ARGUMENTS", message } })}\n`);
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 2;
    return;
  }
  const args = parsedDesktop.flags;
  const waitPid = parsedDesktop.waitPid;

  const explicitCheck = args.has("--check-update") || args.has("--update");
  const preferenceEnabled = await readUpdatePreference();
  const checkDisabled = args.has("--no-update-check") || process.env.AGENT_RECALL_NO_UPDATE_CHECK === "1" || !preferenceEnabled;
  let result = null;
  if (!checkDisabled || explicitCheck) {
    result = await checkForUpdate({ currentVersion: version, force: explicitCheck });
  }

  if (args.has("--check-update")) {
    if (result?.error) process.stderr.write(`检查更新失败：${result.error}\n`);
    else if (result?.updateAvailable) process.stdout.write(`${formatUpdateNotice(result)}\n`);
    else process.stdout.write(`AgentRecall v${version} 已是最新版本。\n`);
    return;
  }

  if (args.has("--update")) {
    if (!result?.updateAvailable || !result.manifest) {
      if (result?.error) throw new Error(`检查更新失败：${result.error}`);
      process.stdout.write(`AgentRecall v${version} 已是最新版本。\n`);
      return;
    }
    process.stdout.write(`${formatUpdateNotice(result)}\n\n正在准备更新，完成后会自动启动应用。\n`);
    await scheduleUpdate(result.manifest, { stopApp: true });
    return;
  }

  if (result?.updateAvailable && result.manifest && !result.updateSkipped && !result.promptSnoozed && process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write(`${formatUpdateNotice(result)}\n\n`);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("请选择：[1] 更新  [2] 跳过  [3] 跳过，直至下个版本  (默认 2): ");
    prompt.close();
    const choice = answer.trim().toLowerCase();
    if (choice === "1" || choice === "u" || choice === "update" || /^y(?:es)?$/i.test(choice)) {
      process.stdout.write("正在准备更新，完成后会自动启动应用。\n");
      await scheduleUpdate(result.manifest, { stopApp: true });
      return;
    }
    if (choice === "3" || choice === "s" || choice === "skip-version") {
      await skipUpdateVersion(result.manifest.version);
      process.stdout.write(`已跳过 v${result.manifest.version}，下个版本发布前不再提示。\n`);
    } else {
      await snoozeUpdatePrompt(result.manifest.version);
      process.stdout.write("本次已跳过，之后仍会提示该版本。\n");
    }
  }

  if (Number.isInteger(waitPid) && waitPid > 0 && waitPid !== process.pid) {
    await waitForProcessExit(waitPid, 30_000);
  }
  await waitForUpdateCompletion({
    onWait: () => {
      if (process.stdout.isTTY) process.stdout.write("正在等待自动更新完成...\n");
    },
  });
  await recoverInterruptedUpdate();
  const packagePath = path.resolve(__dirname, "..");
  await restoreEmbeddedPostgresNativeLinks(path.join(packagePath, "node_modules"));
  assertEmbeddedPostgresRuntime({ packagePath });
  try {
    await ensureElectronRuntimeForLaunch({
      packagePath,
      nodePath: process.execPath,
      onWait: () => {
        if (process.stdout.isTTY) process.stdout.write("正在等待 Electron 运行时准备完成...\n");
      },
    });
  } catch (error) {
    if (!isElectronRuntimeReady(packagePath)) throw error;
    if (process.stdout.isTTY) process.stdout.write("Electron 运行时校验失败，已检测到可用运行时，继续启动应用。\n");
  }
  if (process.platform === "darwin") {
    const { findInstalledMacosApp, installMacosApp, readInstalledMacosAppVersion } = require("./install-macos-app.cjs");
    const installedApp = findInstalledMacosApp();
    if (installedApp) {
      // The app bundle only regenerates on install-app, so its baked paths and
      // plist version go stale across upgrades; refresh it whenever the
      // recorded version drifts from the running install (#499).
      if (readInstalledMacosAppVersion(installedApp) !== version) installMacosApp();
    } else if (process.stdout.isTTY) {
      process.stdout.write("提示：运行 `agent-recall install-app` 后，可以像普通 App 一样从 Launchpad / Spotlight 打开。\n");
    }
  }
  launchApp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
