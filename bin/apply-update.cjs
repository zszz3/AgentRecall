#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  acquireUpdateLock,
  installUpdate,
  launchInstalledApp,
  stopRunningApp,
  waitForProcessExit,
} = require("./update-client.cjs");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const manifestPath = argumentValue("--manifest");
  const waitPid = Number(argumentValue("--wait-pid"));
  if (!manifestPath) throw new Error("--manifest is required.");
  let lock = null;
  try {
    lock = await acquireUpdateLock();
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (Number.isInteger(waitPid) && waitPid > 0 && waitPid !== process.pid) await waitForProcessExit(waitPid, 30_000);
    if (process.argv.includes("--stop-app")) await stopRunningApp();
    process.stdout.write(`正在安装 Agent-Session-Search v${manifest.version}...\n`);
    await installUpdate(manifest);
    process.stdout.write(`Agent-Session-Search v${manifest.version} 安装完成，正在重新启动。\n`);
    launchInstalledApp();
  } finally {
    await lock?.release().catch(() => undefined);
    await fs.rm(path.dirname(manifestPath), { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`Agent-Session-Search 更新失败：${error instanceof Error ? error.message : String(error)}\n`);
  if (error?.code !== "UPDATE_IN_PROGRESS") {
    try { launchInstalledApp(); } catch { /* Keep the recorded error for the next manual launch. */ }
  }
  process.exitCode = 1;
});
