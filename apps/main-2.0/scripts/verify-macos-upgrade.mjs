#!/usr/bin/env node
// Synthetic install/replacement/reopen probe. Only generated temporary bundles
// are accepted; the actual /Applications and real HOME are never accessed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { waitForMacosAppReadiness } from "./macos-native-readiness.mjs";
import { cleanupSmokeProcessGroup, waitForSmokeProcessGroupExit } from "./macos-smoke-processes.mjs";
import { runMacosVerification } from "./macos-smoke-report.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.argv.length, 4, "Usage: verify-macos-upgrade.mjs <previous-temp-app> <candidate-temp-app>");
const apps = await Promise.all(process.argv.slice(2).map(async argument => {
  const app = await fs.realpath(argument);
  assert.equal(path.basename(app), "AgentRecall.app");
  assert.equal(path.dirname(path.dirname(app)), await fs.realpath(os.tmpdir()));
  assert.match(path.basename(path.dirname(app)), /^agent-recall-(?:local|release)-app-[A-Za-z0-9]+$/);
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")], { encoding: "utf8" }));
  assert.equal(plist.CFBundleIdentifier, "dev.zszz3.agent-recall-v2.local-review");
  return app;
}));
const result = await runMacosVerification(path.join(path.dirname(apps[1]), "upgrade-result.json"), async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recall-upgrade-"));
  const home = path.join(root, "home"), appData = path.join(root, "app-data"), temp = path.join(root, "tmp");
  const userData = path.join(appData, "agent-recall-v2");
  const install = path.join(root, "Applications/AgentRecall.app");
  for (const directory of [home, appData, temp, path.dirname(install)]) await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(home, ".zprofile"), "export PATH=/usr/bin:/bin\n");
  const who = os.userInfo();
  const environment = {
    PATH: "/usr/bin:/bin", HOME: home, ZDOTDIR: home, SHELL: "/bin/zsh", LANG: "en_US.UTF-8", USER: who.username, LOGNAME: who.username,
    TMPDIR: temp, CODEX_HOME: path.join(home, ".codex"), CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    AGENT_RECALL_HOME_DIR: home, AGENT_RECALL_APP_DATA_DIR: appData, AGENT_RECALL_TEMP_DIR: temp,
    // No USER_DATA override: this test must exercise the default persistent identity.
    AGENT_RECALL_TEST_HOME: home, AGENT_RECALL_USE_MOCK_KEYCHAIN: "1", AGENT_RECALL_NO_UPDATE_CHECK: "1", AGENT_RECALL_SOURCE_BUILD: "1",
  };
  const sandbox = `(version 1)(allow default)(deny file-read* file-write* (subpath ${JSON.stringify(who.homedir)}))
   (deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*") (local unix-socket) (remote unix-socket))`;
  const marker = "synthetic-upgrade-state";
  const postgresPid = path.join(userData, "postgres/data/postmaster.pid");
  let cleanupSafe = true;
  async function launch(seed, expectedVisibleName) {
    const executable = path.join(install, "Contents/MacOS/AgentRecall");
    const child = spawn("/usr/bin/sandbox-exec", ["-p", sandbox, executable, "--inspect=127.0.0.1:0", "--no-sandbox"], {
      cwd: root, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", socket, nextId = 0, quit = false;
    const replies = new Map();
    const exited = new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-128 * 1024); });
    async function evaluate(expression) {
      const id = ++nextId;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(Error("Inspector response timeout")); }, 10_000);
        replies.set(id, response => { clearTimeout(timer); resolve(response); });
      });
      socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
      const response = await result;
      if (response.error || response.result?.exceptionDetails) throw Error("Upgrade inspector expression failed (credentials suppressed)");
      return response.result.result.value;
    }
    const requireExpression = "process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app/package.json')";
    const electron = `${requireExpression}('electron')`;
    try {
      const deadline = Date.now() + 60_000;
      while (!/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/.test(output)) {
        if (child.exitCode !== null || child.signalCode || Date.now() > deadline) throw Error("Upgrade app failed to expose inspector");
        await delay(100);
      }
      socket = new WebSocket(output.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);
      socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); replies.get(message.id)?.(message); replies.delete(message.id); });
      await Promise.race([
        new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); }),
        delay(10_000, undefined, { ref: false }).then(() => { throw Error("Inspector connection timeout"); }),
      ]);
      let state;
      while (Date.now() < deadline) {
        state = await evaluate(`(async () => {
          const {app, BrowserWindow, Menu} = ${electron}; await app.whenReady();
          const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/renderer/index.html'));
          return {name:app.getName(), userData:app.getPath('userData'), home:app.getPath('home'), menu:Menu.getApplicationMenu()?.items[0]?.label,
            ready:w && !w.webContents.isLoading() && (await w.webContents.executeJavaScript('document.body.innerText')).length > 50};
        })()`);
        if (state.ready) break;
        await delay(200);
      }
      assert.ok(state.ready); assert.equal(state.name, "agent-recall-v2");
      assert.equal(state.userData, userData); assert.equal(state.home, home); assert.equal(state.menu, expectedVisibleName);
      const readiness = await waitForMacosAppReadiness(evaluate, electron);
      const db = await evaluate(`(async () => {
        const require=${requireExpression}; const fs=require('node:fs/promises'), path=require('node:path');
        const url=(await fs.readFile(path.join(${JSON.stringify(home)},'.agent-recall-v2/database-url'),'utf8')).trim();
        if(new URL(url).hostname!=='127.0.0.1') throw Error('Nonlocal database');
        const client=new (require('pg').Client)({connectionString:url,connectionTimeoutMillis:5000});
        try { await client.connect(); ${seed ? `await client.query("create table public.macos_upgrade_probe (value text not null)"); await client.query("insert into public.macos_upgrade_probe values ($1)", [${JSON.stringify(marker)}]);` : ""}
          return {dataDirectory:(await client.query('show data_directory')).rows[0].data_directory,
            marker:(await client.query('select value from public.macos_upgrade_probe')).rows[0].value};
        } finally { await client.end(); }
      })()`);
      assert.equal(db.marker, marker); assert.equal(await fs.realpath(db.dataDirectory), await fs.realpath(path.join(userData, "postgres/data")));
      quit = true; await evaluate(`${electron}.app.quit(); undefined`); socket.close();
      const exit = await Promise.race([exited, delay(20_000, undefined, { ref: false }).then(() => { throw Error("Upgrade graceful shutdown timeout"); })]);
      assert.equal(exit.code, 0);
      assert.ok(await waitForSmokeProcessGroupExit(child.pid), "Owned upgrade helpers survived ordinary quit");
      await assert.rejects(fs.access(postgresPid), { code: "ENOENT" });
      return { state, readiness, databasePreserved: true, postgresStopped: true, processGroupStopped: true, exit };
    } finally {
      if (socket?.readyState === WebSocket.OPEN) { if (!quit) await evaluate(`${electron}.app.quit(); undefined`).catch(() => undefined); socket.close(); }
      try {
        if (child.pid) await cleanupSmokeProcessGroup(child.pid);
      } catch (error) { cleanupSafe = false; throw error; }
      if (await fs.access(postgresPid).then(() => true, () => false)) {
        try { execFileSync("/usr/bin/sandbox-exec", ["-p", sandbox,
          path.join(install, `Contents/Resources/app/node_modules/@embedded-postgres/darwin-${process.arch}/native/bin/pg_ctl`),
          "-D", path.join(userData, "postgres/data"), "-m", "fast", "-w", "stop"], { env: environment, cwd: root, timeout: 20_000, stdio: "pipe" }); }
        catch (error) { cleanupSafe = false; throw error; }
      }
    }
  }
  let report;
  try {
    await fs.cp(apps[0], install, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const previous = await launch(true, "agent-recall-v2");
    const config = path.join(userData, "config.json");
    const settings = JSON.parse(await fs.readFile(config, "utf8"));
    settings.macosUpgradeFixture = marker;
    await fs.writeFile(config, JSON.stringify(settings, null, 2));
    await fs.rm(install, { recursive: true });
    await fs.cp(apps[1], install, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
    const upgraded = await launch(false, "AgentRecall");
    assert.equal(JSON.parse(await fs.readFile(config, "utf8")).macosUpgradeFixture, marker);
    const reopened = await launch(false, "AgentRecall");
    assert.equal(JSON.parse(await fs.readFile(config, "utf8")).macosUpgradeFixture, marker);
    await assert.rejects(fs.access(path.join(appData, "AgentRecall")), { code: "ENOENT" });
    report = { status: "PASS", previous, upgraded, reopened, settingsPreserved: true, duplicateUserDataCreated: false,
      installation: "temporary Applications-like directory", isolation: "synthetic home and database; kernel real-home deny; loopback-only", realKeychain: "NOT EXERCISED (mock)", fixturesRemoved: false };
  } finally { if (cleanupSafe) await fs.rm(root, { recursive: true, force: true }); }
  return { ...report, fixturesRemoved: true };
});
console.log(JSON.stringify(result, null, 2));
