#!/usr/bin/env node
// Runs ONLY a mkdtemp review bundle. No launchctl/LaunchServices registration.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupSmokeProcessGroup, waitForSmokeProcessGroupExit } from "./macos-smoke-processes.mjs";
import { waitForMacosAppReadiness } from "./macos-native-readiness.mjs";
import { runMacosVerification } from "./macos-smoke-report.mjs";

if (process.argv.slice(2).includes("--ui-quality")) {
  throw new Error("--ui-quality is no longer supported; run core smoke without this option.");
}
if (process.platform !== "darwin") throw new Error("Requires macOS.");
const appPath = await fs.realpath(process.argv[2]);
const outputRoot = path.dirname(appPath);
assert.match(path.basename(outputRoot), /^agent-recall-(?:local|release)-app-/);
assert.equal(path.dirname(outputRoot), await fs.realpath(os.tmpdir()));
assert.equal(path.basename(appPath), "AgentRecall.app");
const report = await runMacosVerification(path.join(outputRoot, "smoke-result.json"), async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-gui-smoke-"));
  const realHome = os.userInfo().homedir;
  const home = path.join(testRoot, "home");
  const userData = path.join(testRoot, "user-data");
  const appData = path.join(testRoot, "app-data");
  for (const directory of [home, userData, appData, path.join(testRoot, "tmp")]) await fs.mkdir(directory);
  await fs.writeFile(path.join(home, ".zprofile"), 'export PATH=/usr/bin:/bin\n');
  const environment = {
    PATH: "/usr/bin:/bin", HOME: home, USER: os.userInfo().username, LOGNAME: os.userInfo().username,
    SHELL: "/bin/zsh", ZDOTDIR: home, LANG: "en_US.UTF-8", TMPDIR: path.join(testRoot, "tmp"),
    CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    AGENT_RECALL_HOME_DIR: home, AGENT_RECALL_APP_DATA_DIR: appData,
    AGENT_RECALL_USER_DATA_DIR: userData, AGENT_RECALL_TEST_HOME: home,
    AGENT_RECALL_TEMP_DIR: path.join(testRoot, "tmp"), AGENT_RECALL_USE_MOCK_KEYCHAIN: "1",
    AGENT_RECALL_NO_UPDATE_CHECK: "1", AGENT_RECALL_SOURCE_BUILD: "1",
  };
  // HOME is not sufficient on macOS. Also enforce a kernel sandbox denying the
  // actual home tree and non-loopback network access for this process and children.
  const sandbox = `(version 1)(allow default)
    (deny file-read* file-write* (subpath ${JSON.stringify(realHome)}))
    (deny network*)
    (allow network* (local ip "localhost:*") (remote ip "localhost:*") (local unix-socket) (remote unix-socket))`;
  const child = spawn("/usr/bin/sandbox-exec", ["-p", sandbox,
    // Chromium cannot initialize a nested seatbelt sandbox. For this test only,
    // the stricter outer sandbox owns isolation for main/GPU/renderer/children.
    path.join(outputRoot, "agent-recall-v2-local"), "--inspect=127.0.0.1:0", "--no-sandbox"], {
    env: environment, cwd: testRoot, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let socket;
  let nextId = 0;
  let quitRequested = false;
  let spawnError;
  let postgres;
  let report;
  const replies = new Map();
  const exited = new Promise(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", error => { spawnError = error; resolve({ error }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk.toString(); });
  async function evaluate(expression) {
    const id = ++nextId;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { replies.delete(id); reject(new Error("Inspector response timed out")); }, 10_000);
      replies.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    const response = await reply;
    if (response.error || response.result?.exceptionDetails) throw new Error(JSON.stringify(response));
    return response.result?.result?.value;
  }
  const electron = "process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')('electron')";
  try {
    const deadline = Date.now() + 60_000;
    while (!/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.test(output)) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode || Date.now() > deadline) throw new Error(`App did not expose inspector: ${output}`);
      await delay(100);
    }
    socket = new WebSocket(output.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);
    socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); replies.get(message.id)?.(message); replies.delete(message.id); });
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    await delay(1000);
    let state;
    while (Date.now() < deadline) {
      state = await evaluate(`globalThis.__agentRecallSmoke = (async () => {
        const { app, BrowserWindow } = ${electron};
        const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'));
        return { name: app.getName(), executable: process.execPath, packaged: app.isPackaged,
          home: app.getPath('home'), userData: app.getPath('userData'), appData: app.getPath('appData'),
          title: window?.getTitle(), text: window && !window.webContents.isLoading()
            ? (await window.webContents.executeJavaScript('document.body.innerText')).slice(0, 2000) : '' };
      })()`);
      if (state.text.length > 50) break;
      await delay(200);
    }
    assert.equal(state.home, home);
    assert.equal(state.userData, userData);
    assert.equal(state.appData, appData);
    assert.equal(state.packaged, true);
    assert.equal(await fs.realpath(state.executable), await fs.realpath(path.join(appPath, "Contents/MacOS/AgentRecall")));
    assert.equal(state.name, "agent-recall-v2");
    assert.ok(state.text.length > 50, `Renderer did not load: ${output}`);
    const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(appPath, "Contents/Info.plist")], { encoding: "utf8" }));
    assert.equal(plist.CFBundleExecutable, "AgentRecall");
    assert.equal(plist.CFBundleName, "AgentRecall");
    assert.equal(plist.CFBundleDisplayName, "AgentRecall");
    assert.equal(plist.CFBundleIdentifier, "dev.zszz3.agent-recall-v2.local-review");
    await fs.access(path.join(appPath, "Contents/Resources", plist.CFBundleIconFile));
    const menus = await evaluate(`${electron}.Menu.getApplicationMenu().items.map(item => ({label:item.label, submenu:item.submenu?.items.map(child => child.label)}))`);
    assert.equal(menus[0].label, "AgentRecall");
    assert.ok(menus[0].submenu.includes("Quit AgentRecall"));
    const postgresDirectory = path.join(userData, "postgres/data");
    const postgresPidFile = path.join(postgresDirectory, "postmaster.pid");
    const postgresDeadline = Date.now() + 60_000;
    while (Date.now() < postgresDeadline) {
      let lines;
      try { lines = (await fs.readFile(postgresPidFile, "utf8")).trim().split("\n"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      // The server writes its PID file during startup; wait for the complete
      // identity before asserting that this fresh synthetic database is running.
      if (lines && /^[1-9]\d*$/.test(lines[0]) && lines[1]) {
        const directory = await fs.realpath(postgresDirectory);
        assert.ok([postgresDirectory, directory].includes(path.resolve(lines[1])), "PostgreSQL data directory escaped the smoke fixture");
        const pid = Number(lines[0]);
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        process.kill(pid, 0);
        postgres = { pid, dataDirectory: directory, started: true };
        break;
      }
      if (child.exitCode !== null || child.signalCode) throw new Error("App exited before its synthetic PostgreSQL server started");
      await delay(100);
    }
    assert.ok(postgres, "Synthetic PostgreSQL server did not start before timeout");
    const readiness = await waitForMacosAppReadiness(evaluate, electron);
    report = { status: "PASS", state, menus, postgres, readiness, isolation: "explicit paths + sandbox real-home deny + loopback-only", manual: ["Dock label", "Finder double-click"], testRoot };
    quitRequested = true;
    await evaluate(`${electron}.app.quit(); undefined`);
    socket.close();
    const exit = await Promise.race([exited, delay(20_000, undefined, { ref: false }).then(() => { throw new Error("Graceful shutdown timed out"); })]);
    assert.equal(exit.code, 0);
    assert.ok(await waitForSmokeProcessGroupExit(child.pid), "Owned renderer/GPU/utility helpers survived ordinary quit");
    // Graceful shutdown must stop the temporary server, not just close the UI.
    await assert.rejects(fs.access(postgresPidFile), { code: "ENOENT" });
    assert.throws(() => process.kill(postgres.pid, 0), { code: "ESRCH" });
    await fs.rm(path.join(outputRoot, "smoke-error.log"), { force: true });
    report = { ...report, exit, postgresStopped: true, processGroupStopped: true };
  } catch (error) {
    await fs.writeFile(path.join(outputRoot, "smoke-error.log"), output);
    console.error(output);
    throw error;
  } finally {
    if (socket?.readyState === WebSocket.OPEN) {
      if (!quitRequested) await evaluate(`${electron}.app.quit(); undefined`).catch(() => undefined);
      socket.close();
    }
    const cleanupErrors = [];
    // Even after the main process exits, renderer/GPU/utility descendants remain
    // owned by this detached group. Never delete fixtures before confirming exit.
    try { if (child.pid) await cleanupSmokeProcessGroup(child.pid); }
    catch (error) { cleanupErrors.push(error); }
    try {
      const postgresDirectory = path.join(userData, "postgres/data");
      const pidFile = path.join(postgresDirectory, "postmaster.pid");
      let lines;
      try { lines = (await fs.readFile(pidFile, "utf8")).trim().split("\n"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      // PostgreSQL can start a separate session; stop it via its owned data dir.
      if (lines) {
        const pid = Number(lines[0]);
        assert.ok(Number.isSafeInteger(pid) && pid > 1, "Invalid fixture PostgreSQL PID");
        assert.ok([postgresDirectory, await fs.realpath(postgresDirectory)].includes(lines[1]), "Unexpected PostgreSQL data directory");
        execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox,
          path.join(appPath, `Contents/Resources/app/node_modules/@embedded-postgres/darwin-${process.arch}/native/bin/pg_ctl`),
          "-D", postgresDirectory, "-m", "fast", "-w", "stop"], { env: environment, cwd: testRoot, timeout: 20_000, stdio: "pipe" });
        await assert.rejects(fs.access(pidFile), { code: "ENOENT" });
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      if (postgres) assert.throws(() => process.kill(postgres.pid, 0), { code: "ESRCH" });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Smoke cleanup unconfirmed; fixtures retained at ${testRoot}`);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
  return report;
});
console.log(JSON.stringify(report, null, 2));
