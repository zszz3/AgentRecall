#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const userData = process.env.AGENT_RECALL_TEST_USER_DATA;
if (!userData) {
  throw new Error("AGENT_RECALL_TEST_USER_DATA must point to a temporary directory.");
}

const expectedApiKeys = [
  "getAppUpdateStatus",
  "getIndexStatus",
  "getLiveSessions",
  "getMessages",
  "getSession",
  "getSettings",
  "getTraceEvents",
  "installAppUpdate",
  "listEnvironments",
  "listProjects",
  "listTags",
  "listTagsByProject",
  "onAppUpdateStatus",
  "onFocusSearch",
  "onIndexStatus",
  "onOpenSettings",
  "platform",
  "productProfile",
  "refreshIndex",
  "resumeSession",
  "searchSessionPage",
  "setCustomTitle",
  "setFavorited",
  "setSettings",
  "skipAppUpdate",
].sort();

app.setPath("userData", userData);
app.enableSandbox();
app.commandLine.appendSwitch("disable-gpu");

const timeout = setTimeout(() => {
  process.stderr.write("Sandbox preload smoke timed out.\n");
  app.exit(1);
}, 15_000);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.resolve(__dirname, "..", "out", "preload", "index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let preloadError = null;
  window.webContents.once("preload-error", (_event, _preloadPath, error) => {
    preloadError = error;
  });
  await window.loadURL("data:text/html;charset=utf-8,<title>Core preload smoke</title>");
  assert.equal(preloadError, null);
  const result = await window.webContents.executeJavaScript(`({
    apiKeys: Object.keys(window.sessionSearch ?? {}).sort(),
    profileId: window.sessionSearch?.productProfile?.id,
    sessionSources: [...(window.sessionSearch?.productProfile?.sessionSources ?? [])],
    nodeProcessType: typeof window.process,
    nodeRequireType: typeof window.require
  })`);
  assert.deepEqual(result.apiKeys, expectedApiKeys);
  assert.equal(result.profileId, "core-v1");
  assert.deepEqual(result.sessionSources, [
    "claude-cli",
    "claude-app",
    "codex-cli",
    "codex-app",
  ]);
  assert.equal(result.nodeProcessType, "undefined");
  assert.equal(result.nodeRequireType, "undefined");
  window.destroy();
  clearTimeout(timeout);
  // This is a standalone smoke process. Exit directly so Electron helper
  // handles cannot keep the test command alive after window teardown.
  process.stdout.write("Sandboxed Core preload smoke passed.\n");
  process.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
