#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  acquireUpdateLock,
  clearInstallStatus,
  formatManualUpdateFallback,
  installUpdate,
  launchInstalledApp,
  showNativeUpdateFailure,
  stopRunningApp,
  waitForProcessExit,
} = require("./update-client.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function relaunchInstalledApp(options = {}) {
  const launch = options.launchInstalledAppImpl || launchInstalledApp;
  const writeError = options.writeError || ((message) => process.stderr.write(message));
  try {
    launch();
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`AgentRecall 已安装完成，但立即重启失败：${message}\n正在重试启动。\n`);
  }

  await delay(options.delayMs ?? 1_000);
  try {
    launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`AgentRecall 已安装完成，但自动重启失败：${message}\n请手动运行 agent-recall 启动已安装的新版本。\n`);
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function applyStagedUpdate(staged) {
  let backedUp = false;
  await fs.rm(staged.backupPath, { recursive: true, force: true });
  try {
    try {
      await fs.rename(staged.livePackagePath, staged.backupPath);
      backedUp = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staged.stagedPackagePath, staged.livePackagePath);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      await fs.cp(staged.stagedPackagePath, staged.livePackagePath, { recursive: true, force: true });
      await fs.rm(staged.stagedPackagePath, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(staged.statusPath), { recursive: true });
    await fs.writeFile(staged.statusPath, `${JSON.stringify({
      status: "installed",
      version: staged.version,
      updatedAt: Date.now(),
      error: null,
    }, null, 2)}\n`, "utf8");
    await fs.rm(staged.backupPath, { recursive: true, force: true });
    await fs.rm(staged.stageRoot, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staged.livePackagePath, { recursive: true, force: true }).catch(() => undefined);
    if (backedUp) {
      await fs.rename(staged.backupPath, staged.livePackagePath).catch((rollbackError) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      });
    }
    throw error;
  }
}

async function main() {
  const manifestPath = argumentValue("--manifest");
  const stagedPath = argumentValue("--staged");
  const waitPid = Number(argumentValue("--wait-pid"));
  if (!manifestPath && !stagedPath) throw new Error("--manifest or --staged is required.");
  let lock = null;
  try {
    lock = await acquireUpdateLock();
    if (Number.isInteger(waitPid) && waitPid > 0 && waitPid !== process.pid) await waitForProcessExit(waitPid, 30_000);
    if (process.argv.includes("--stop-app")) await stopRunningApp();
    let version;
    if (stagedPath) {
      const staged = JSON.parse(await fs.readFile(stagedPath, "utf8"));
      version = staged.version;
      process.stdout.write(`正在应用 AgentRecall v${version}...\n`);
      await applyStagedUpdate(staged);
    } else {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      version = manifest.version;
      process.stdout.write(`正在安装 AgentRecall v${version}...\n`);
      await installUpdate(manifest, {
        nodePath: process.env.AGENT_RECALL_NODE_PATH,
      });
      await clearInstallStatus().catch(() => undefined);
    }
    process.stdout.write(`AgentRecall v${version} 安装完成，正在重新启动。\n`);
    await relaunchInstalledApp();
  } finally {
    await lock?.release().catch(() => undefined);
    const controlPath = stagedPath || manifestPath;
    await fs.rm(path.dirname(controlPath), { recursive: true, force: true }).catch(() => undefined);
  }
}

if (require.main === module) main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const updateInProgress = error?.code === "UPDATE_IN_PROGRESS";
  process.stderr.write(
    `AgentRecall 更新失败：${message}${updateInProgress ? "" : `\n\n${formatManualUpdateFallback()}`}\n`,
  );
  if (!updateInProgress) {
    const fallbackShown = showNativeUpdateFailure(message);
    if (fallbackShown) await clearInstallStatus().catch(() => undefined);
    try { launchInstalledApp(); } catch { /* Keep the recorded error for the next manual launch. */ }
  }
  process.exitCode = 1;
});

module.exports = { applyStagedUpdate, relaunchInstalledApp };
