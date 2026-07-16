import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
const temporaryDirectories = new Set();

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function electronFixtureExec(command, args, options) {
  if (command === process.execPath) return execFileAsync(command, args, options);
  const contents = await readFile(command, "utf8");
  if (!contents.includes("v42.3.0")) throw new Error("Electron executable is corrupt");
  return { stdout: "v42.3.0\n", stderr: "" };
}

const require = createRequire(import.meta.url);
const updateClientSource = await readFile(new URL("../bin/update-client.cjs", import.meta.url), "utf8");
const {
  DEFAULT_NPM_REGISTRY,
  UPDATE_REQUEST_TIMEOUT_MS,
  acquireUpdateLock,
  checkForUpdate,
  compareVersions,
  ensureElectronRuntimeForLaunch,
  ensureInstalledElectron,
  electronRuntimeLockPath,
  formatUpdateError,
  formatManualUpdateFallback,
  formatUpdateNotice,
  installUpdate,
  isElectronRuntimeReady,
  launchInstalledApp,
  manualInstallCommand,
  parseUpdateManifest,
  showNativeUpdateFailure,
  skipUpdateVersion,
  snoozeUpdatePrompt,
  stopRunningApp,
  waitForUpdateCompletion,
  updateLockPath,
} = require("../bin/update-client.cjs");

test("allows enough time for a normal GitHub release check", () => {
  assert.equal(UPDATE_REQUEST_TIMEOUT_MS, 5_000);
});

function manifest(version = "0.2.0") {
  return {
    schemaVersion: 1,
    version,
    tag: `v${version}`,
    title: "自动更新",
    publishedAt: "2026-07-14T00:00:00.000Z",
    releaseUrl: `https://github.com/zszz3/AgentRecall/releases/tag/v${version}`,
    notes: { features: ["终端显示更新。"], fixes: ["修复重启失败。"] },
    package: {
      name: `agent-recall-${version}.tgz`,
      url: `https://github.com/zszz3/AgentRecall/releases/download/v${version}/agent-recall-${version}.tgz`,
      sha256: "a".repeat(64),
      checksumUrl: "",
    },
  };
}

test("compares stable application versions", () => {
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("snoozes the terminal prompt for the same cached version", async () => {
  const value = manifest();
  const cacheDirectory = await temporaryDirectory("agent-session-update-snooze-");
  const cachePath = path.join(cacheDirectory, "update-check.json");
  const now = Date.now();
  let request = 0;
  const fetchImpl = async () => {
    request += 1;
    return request === 1
      ? new Response(JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "update.json", browser_download_url: "https://download.example/update.json" }] }), { status: 200 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
  await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, force: true, now });
  await snoozeUpdatePrompt("0.2.0", { cachePath, now, durationMs: 60_000 });
  const cached = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, now: now + 1 });
  assert.equal(cached.updateAvailable, true);
  assert.equal(cached.promptSnoozed, true);
});

test("skips the same update version until a newer version is released", async () => {
  const cacheDirectory = await temporaryDirectory("agent-session-update-skip-version-");
  const cachePath = path.join(cacheDirectory, "update-check.json");
  const firstManifest = manifest("0.2.0");
  const nextManifest = manifest("0.3.0");
  let value = firstManifest;
  const fetchImpl = async (url) => String(url).includes("api.github.com")
    ? new Response(JSON.stringify({ tag_name: `v${value.version}`, assets: [{ name: "update.json", browser_download_url: "https://download.example/update.json" }] }), { status: 200 })
    : new Response(JSON.stringify(value), { status: 200 });

  await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, force: true, now: 1 });
  await skipUpdateVersion("0.2.0", { cachePath });
  const skipped = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, now: 2 });
  assert.equal(skipped.updateAvailable, true);
  assert.equal(skipped.updateSkipped, true);

  const forced = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, force: true, now: 2 });
  assert.equal(forced.updateAvailable, true);
  assert.equal(forced.updateSkipped, false);

  value = nextManifest;
  const newer = await checkForUpdate({ currentVersion: "0.1.0", cachePath, fetchImpl, force: true, now: 3 });
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.updateSkipped, false);
  assert.equal(newer.manifest.version, "0.3.0");
});

test("terminal launcher does not prompt again for a skipped update version", async () => {
  const launcherSource = await readFile(new URL("../bin/agent-recall.cjs", import.meta.url), "utf8");
  assert.match(launcherSource, /!result\.updateSkipped && !result\.promptSnoozed/);
  assert.match(launcherSource, /\[1\] 更新\s+\[2\] 跳过\s+\[3\] 跳过，直至下个版本/);
});

test("refuses to install an update whose package checksum does not match", async () => {
  const value = manifest();
  const statusDirectory = await temporaryDirectory("agent-session-update-status-");
  await assert.rejects(
    installUpdate(value, {
      fetchImpl: async () => new Response("tampered package", { status: 200 }),
      statusPath: path.join(statusDirectory, "status.json"),
      packagePath: path.join(statusDirectory, "prefix", "lib", "node_modules", "agent-recall"),
    }),
    /checksum mismatch/,
  );
});

test("rejects untrusted release package URLs", () => {
  const value = manifest();
  value.package.url = "https://example.com/update.tgz";
  assert.throws(() => parseUpdateManifest(value), /not trusted/);
});

test("accepts release package URLs from the renamed GitHub repository", () => {
  const value = manifest("0.5.0");
  value.releaseUrl = "https://github.com/zszz3/AgentRecall/releases/tag/v0.5.0";
  value.package.url = "https://github.com/zszz3/AgentRecall/releases/download/v0.5.0/agent-recall-0.5.0.tgz";
  assert.equal(parseUpdateManifest(value).package.url, value.package.url);
});

test("checks GitHub latest release and formats the same notes for terminal output", async () => {
  const value = manifest();
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-cache-");
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ tag_name: "v0.2.0", assets: [{ name: "update.json", browser_download_url: "https://download.example/update.json" }] }), {
        status: 200,
        headers: { etag: '"release-etag"' },
      });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  };
  const result = await checkForUpdate({
    currentVersion: "0.1.0",
    cachePath: path.join(cacheDirectory, "update-check.json"),
    fetchImpl,
    force: true,
    now: 123,
  });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.manifest.version, "0.2.0");
  assert.match(formatUpdateNotice(result), /新增功能：[\s\S]*Bug 修复：/);
  assert.equal(requests.length, 2);
});

test("falls back to the direct latest manifest when the GitHub release API fails", async () => {
  const value = manifest();
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-fallback-");
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
    }
    return new Response(JSON.stringify(value), { status: 200, headers: { etag: '"manifest-etag"' } });
  };

  const result = await checkForUpdate({
    currentVersion: "0.1.0",
    cachePath: path.join(cacheDirectory, "update-check.json"),
    fetchImpl,
    force: true,
    now: 123,
  });

  assert.equal(result.updateAvailable, true);
  assert.equal(result.error, null);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/zszz3/AgentRecall/releases/latest",
    "https://github.com/zszz3/AgentRecall/releases/latest/download/update.json",
  ]);
});

test("provides an actionable manual fallback when automatic installation fails", () => {
  const command = manualInstallCommand();
  assert.equal(
    command,
    "npm install -g https://github.com/zszz3/AgentRecall/releases/latest/download/agent-recall.tgz",
  );
  const message = formatManualUpdateFallback();
  assert.match(message, /自动更新未完成/);
  assert.match(message, /npm install -g https:\/\/github\.com\/zszz3\/AgentRecall\/releases\/latest\/download\/agent-recall\.tgz/);
  assert.match(message, /https:\/\/github\.com\/zszz3\/AgentRecall\/releases\/latest/);
});

test("converts subprocess update failures into readable text", () => {
  assert.equal(formatUpdateError({ stderr: Buffer.from("npm 权限不足\n", "utf8") }), "npm 权限不足");
  const binaryOutput = formatUpdateError({ stderr: Buffer.from([0x45, 0x72, 0x72, 0x6f, 0x72, 0, 0xff, 0x0b]) });
  assert.match(binaryOutput, /^Error/);
  assert.doesNotMatch(binaryOutput, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/);
});

test("shows a macOS-native fallback without requiring Electron", () => {
  const calls = [];
  const shown = showNativeUpdateFailure("Electron download failed", {
    platform: "darwin",
    execFileSyncImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return command === "osascript" ? "button returned:复制安装命令\n" : "";
    },
  });
  assert.equal(shown, true);
  assert.equal(calls[0].command, "osascript");
  assert.equal(calls[0].options.env.AGENT_RECALL_UPDATE_ERROR, "Electron download failed");
  assert.equal(calls[1].command, "pbcopy");
  assert.match(calls[1].options.input, /npm install -g .*agent-recall\.tgz/);
});

test("shows a Windows-native fallback without requiring Electron", () => {
  let invocation = null;
  const shown = showNativeUpdateFailure("npm install failed", {
    platform: "win32",
    execFileSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return "";
    },
  });
  assert.equal(shown, true);
  assert.equal(invocation.command, "powershell.exe");
  assert.ok(invocation.args.includes("-NonInteractive"));
  assert.match(invocation.args.at(-1), /Set-Clipboard/);
  assert.match(invocation.args.at(-1), /Start-Process/);
  assert.equal(invocation.options.env.AGENT_RECALL_UPDATE_ERROR, "npm install failed");
});

test("reports a clear error when the GitHub release check times out", async () => {
  const cacheDirectory = await temporaryDirectory("agent-session-update-timeout-");
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const result = await checkForUpdate({
    currentVersion: "0.1.0",
    cachePath: path.join(cacheDirectory, "update-check.json"),
    fetchImpl,
    force: true,
    timeoutMs: 5,
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, "The GitHub request timed out after 5 ms.");
});

test("serializes update installers with a recoverable process lock", async () => {
  const directory = await temporaryDirectory("agent-session-update-lock-");
  const lockPath = path.join(directory, "install.lock");
  const first = await acquireUpdateLock({ lockPath });
  await assert.rejects(acquireUpdateLock({ lockPath }), /另一个更新正在安装/);
  await first.release();
  const second = await acquireUpdateLock({ lockPath });
  await second.release();
});

test("uses one atomic lock for application updates and Electron runtime repair", () => {
  const homeDir = path.join(tmpdir(), "agent-session-common-lock");
  assert.equal(electronRuntimeLockPath(homeDir), updateLockPath(homeDir));
});

test("force-stops the installed application on Windows before replacing files", () => {
  assert.match(updateClientSource, /"taskkill", \["\/PID", String\(appPid\), "\/T", "\/F"\]/);
});

test("stops a running npm-installed app when the saved process state is missing", async () => {
  const directory = await temporaryDirectory("agent-session-update-stop-app-");
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall");
  const appEntry = path.join(packagePath, "out", "main", "index.js");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    const stopped = await stopRunningApp({
      processPath: path.join(directory, "missing-process.json"),
      packagePath,
      execFileImpl: async () => ({
        stdout: `  101 /usr/bin/unrelated\n  ${child.pid} /path/Electron ${appEntry}\n`,
        stderr: "",
      }),
      waitTimeoutMs: 5_000,
    });
    assert.equal(stopped, true);
    assert.throws(() => process.kill(child.pid, 0));
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});

test("waits for an active update lock before launching the application", async () => {
  const directory = await temporaryDirectory("agent-session-update-wait-");
  const lockPath = path.join(directory, "install.lock");
  const lock = await acquireUpdateLock({ lockPath });
  setTimeout(() => void lock.release(), 20);
  assert.equal(await waitForUpdateCompletion({ lockPath, currentPid: -1, pollMs: 5, timeoutMs: 1_000 }), true);
});

test("installs through the public registry and records a completed status", async () => {
  const bytes = Buffer.from("verified update archive");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-session-update-install-");
  const statusPath = path.join(directory, "status.json");
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall");
  await mkdir(packagePath, { recursive: true });
  let invocation = null;
  let electronChecked = false;
  await installUpdate(value, {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
    statusPath,
    packagePath,
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      return { stdout: "", stderr: "" };
    },
    nodePath: "/stable/node",
    ensureElectronImpl: async ({ env, nodePath }) => {
      electronChecked = true;
      assert.equal("ELECTRON_RUN_AS_NODE" in env, false);
      assert.equal(nodePath, "/stable/node");
    },
  });
  assert.equal(invocation.args[invocation.args.indexOf("--registry") + 1], DEFAULT_NPM_REGISTRY);
  assert.equal("ELECTRON_RUN_AS_NODE" in invocation.options.env, false);
  assert.equal(electronChecked, true);
  assert.deepEqual(JSON.parse(await readFile(statusPath, "utf8")), {
    status: "installed",
    version: "0.2.0",
    updatedAt: JSON.parse(await readFile(statusPath, "utf8")).updatedAt,
    error: null,
  });
});

test("restores the previous global package when post-install validation fails", async () => {
  const bytes = Buffer.from("verified update archive");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-session-update-package-rollback-");
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall");
  const statusPath = path.join(directory, "status.json");
  await mkdir(packagePath, { recursive: true });
  await writeFile(path.join(packagePath, "marker.txt"), "old package", "utf8");

  await assert.rejects(installUpdate(value, {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
    packagePath,
    statusPath,
    execFileImpl: async () => {
      await rm(packagePath, { recursive: true, force: true });
      await mkdir(packagePath, { recursive: true });
      await writeFile(path.join(packagePath, "marker.txt"), "new package", "utf8");
      return { stdout: "", stderr: "" };
    },
    ensureElectronImpl: async () => { throw new Error("runtime validation failed"); },
  }), /runtime validation failed/);

  assert.equal(await readFile(path.join(packagePath, "marker.txt"), "utf8"), "old package");
  assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "error");
});

test("repairs an incomplete Electron runtime before reporting update success", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-repair-");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  await mkdir(electronPath, { recursive: true });
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }));
  await writeFile(
    path.join(electronPath, "index.js"),
    `const path = require("node:path"); module.exports = path.join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(
    path.join(electronPath, "install.js"),
    [
      'const fs = require("node:fs"); const path = require("node:path");',
      `const executable = path.join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});`,
      `const defaultApp = path.join(__dirname, "dist", ${JSON.stringify(relativeDefaultApp)});`,
      'fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "#!/bin/sh\\necho v42.3.0\\n"); fs.chmodSync(executable, 0o755);',
      'fs.mkdirSync(path.dirname(defaultApp), { recursive: true }); fs.writeFileSync(defaultApp, "ok");',
      'fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");',
      `fs.writeFileSync(path.join(__dirname, "path.txt"), ${JSON.stringify(relativeExecutable)});`,
    ].join(" "),
    "utf8",
  );

  await ensureInstalledElectron({ packagePath, timeoutMs: 5_000, execFileImpl: electronFixtureExec });
  assert.match(await readFile(path.join(electronPath, "dist", relativeExecutable), "utf8"), /v42\.3\.0/);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("validates Electron runtime with Node semantics when launched by Electron", async () => {
  const directory = await temporaryDirectory("agent-session-electron-node-mode-");
  const packagePath = path.join(directory, "agent-recall");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(path.join(electronPath, "install.js"), "throw new Error('install script should not run');\n", "utf8");
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "v42.3.0", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");

  let invocation = null;
  Object.defineProperty(process.versions, "electron", { value: "42.3.0", configurable: true });
  try {
    await ensureInstalledElectron({
      packagePath,
      nodePath: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      execFileImpl: async (command, args, options) => {
        invocation = { command, args, options };
        assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
        if (command === process.execPath) {
          assert.equal(args[0], "-e");
          return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
        }
        return { stdout: "v42.3.0\n", stderr: "" };
      },
    });
  } finally {
    delete process.versions.electron;
  }

  assert.ok(invocation);
});

test("uses a stable Node executable for Electron runtime checks after npm replaces Electron", async () => {
  const directory = await temporaryDirectory("agent-session-electron-stable-node-");
  const packagePath = path.join(directory, "agent-recall");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(path.join(electronPath, "install.js"), "throw new Error('install script should not run');\n", "utf8");
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
  const stableNodePath = path.join(directory, "node");
  await writeFile(stableNodePath, "ok", "utf8");

  const commands = [];
  Object.defineProperty(process.versions, "electron", { value: "42.3.0", configurable: true });
  try {
    await ensureInstalledElectron({
      packagePath,
      nodePath: stableNodePath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      execFileImpl: async (command, args, options) => {
        commands.push({ command, args, options });
        if (command === stableNodePath) {
          return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
        }
        return { stdout: "v42.3.0\n", stderr: "" };
      },
    });
  } finally {
    delete process.versions.electron;
  }

  assert.deepEqual(commands.map((call) => call.command), [
    stableNodePath,
    path.join(electronPath, "dist", relativeExecutable),
  ]);
  assert.equal(commands[0].options.env.ELECTRON_RUN_AS_NODE, "1");
});

test("restores the previous Electron runtime when repair fails", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-rollback-");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin" ? path.join("Electron.app", "Contents", "MacOS", "Electron") : process.platform === "win32" ? "electron.exe" : "electron";
  const defaultApp = process.platform === "darwin" ? path.join("Electron.app", "Contents", "Resources", "default_app.asar") : path.join("resources", "default_app.asar");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(defaultApp)), { recursive: true });
  await writeFile(path.join(electronPath, "index.js"), `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`);
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }));
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable);
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0");
  await writeFile(path.join(electronPath, "dist", defaultApp), "old-default");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "corrupt-old-runtime");
  await writeFile(path.join(electronPath, "install.js"), 'throw new Error("download failed");\n');

  await assert.rejects(ensureInstalledElectron({ packagePath, timeoutMs: 5_000, execFileImpl: electronFixtureExec }), /download failed/);
  assert.equal(await readFile(path.join(electronPath, "dist", relativeExecutable), "utf8"), "corrupt-old-runtime");
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
});

test("serializes concurrent first-launch Electron preparation", async () => {
  const directory = await temporaryDirectory("agent-session-electron-lock-");
  const lockPath = path.join(directory, "electron.lock");
  let active = 0;
  let maxActive = 0;
  const ensureElectronImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  };
  await Promise.all([
    ensureElectronRuntimeForLaunch({ lockPath, packagePath: directory, ensureElectronImpl, pollMs: 5, timeoutMs: 1_000, currentPid: -1 }),
    ensureElectronRuntimeForLaunch({ lockPath, packagePath: directory, ensureElectronImpl, pollMs: 5, timeoutMs: 1_000, currentPid: -1 }),
  ]);
  assert.equal(maxActive, 1);
});

test("relaunches without Electron's Node-mode environment", () => {
  let launchOptions = null;
  launchInstalledApp({
    command: "/tmp/agent-recall",
    env: { ELECTRON_RUN_AS_NODE: "1" },
    spawnImpl: (_command, _args, options) => {
      launchOptions = options;
      return { unref() {} };
    },
  });
  assert.equal("ELECTRON_RUN_AS_NODE" in launchOptions.env, false);
  assert.equal(launchOptions.env.AGENT_RECALL_NO_UPDATE_CHECK, "1");
});

test("keeps the terminal attached until the updater reports an exit status", async () => {
  const launcher = await readFile(new URL("../bin/agent-recall.cjs", import.meta.url), "utf8");
  assert.match(launcher, /child\.once\("exit"/);
  assert.doesNotMatch(launcher, /detached:\s*true,\s*stdio:\s*"inherit"/);
  assert.doesNotMatch(launcher, /"--wait-pid",\s*String\(process\.pid\)/);
  assert.match(launcher, /delete environment\.ELECTRON_RUN_AS_NODE/);
  assert.match(launcher, /waitForUpdateCompletion/);
  assert.match(launcher, /ensureElectronRuntimeForLaunch/);
});

test("pins the Electron runtime used by CI and global installs", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies.electron, "42.3.0");
});
