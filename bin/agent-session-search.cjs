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

const {
  checkForUpdate,
  currentVersion,
  formatUpdateNotice,
  readUpdatePreference,
  snoozeUpdatePrompt,
} = require("./update-client.cjs");

async function scheduleUpdate(manifest, { stopApp }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-search-apply-"));
  const manifestPath = path.join(directory, "update.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const args = [path.join(__dirname, "apply-update.cjs"), "--manifest", manifestPath];
  if (stopApp) args.push("--stop-app");
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
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
  const appEntry = path.join(__dirname, "..", "out", "main", "index.js");
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, [appEntry], { detached: true, stdio: "ignore", env: environment });
  child.on("error", (error) => {
    console.error("Failed to launch Agent-Session-Search:", error.message);
    process.exitCode = 1;
  });
  child.unref();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const version = currentVersion();
  if (args.has("--version") || args.has("-v")) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const explicitCheck = args.has("--check-update") || args.has("--update");
  const preferenceEnabled = await readUpdatePreference();
  const checkDisabled = args.has("--no-update-check") || process.env.AGENT_SESSION_SEARCH_NO_UPDATE_CHECK === "1" || !preferenceEnabled;
  let result = null;
  if (!checkDisabled || explicitCheck) {
    result = await checkForUpdate({ currentVersion: version, force: explicitCheck });
  }

  if (args.has("--check-update")) {
    if (result?.error) process.stderr.write(`检查更新失败：${result.error}\n`);
    else if (result?.updateAvailable) process.stdout.write(`${formatUpdateNotice(result)}\n`);
    else process.stdout.write(`Agent-Session-Search v${version} 已是最新版本。\n`);
    return;
  }

  if (args.has("--update")) {
    if (!result?.updateAvailable || !result.manifest) {
      if (result?.error) throw new Error(`检查更新失败：${result.error}`);
      process.stdout.write(`Agent-Session-Search v${version} 已是最新版本。\n`);
      return;
    }
    process.stdout.write(`${formatUpdateNotice(result)}\n\n正在准备更新，完成后会自动启动应用。\n`);
    await scheduleUpdate(result.manifest, { stopApp: true });
    return;
  }

  if (result?.updateAvailable && result.manifest && !result.promptSnoozed && process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write(`${formatUpdateNotice(result)}\n\n`);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question("是否立即更新？[y/N] ");
    prompt.close();
    if (/^y(?:es)?$/i.test(answer.trim())) {
      process.stdout.write("正在准备更新，完成后会自动启动应用。\n");
      await scheduleUpdate(result.manifest, { stopApp: true });
      return;
    }
    await snoozeUpdatePrompt(result.manifest.version);
  }

  launchApp();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
