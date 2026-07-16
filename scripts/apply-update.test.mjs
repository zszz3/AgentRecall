import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { relaunchInstalledApp } = require("../bin/apply-update.cjs");

test("retries relaunch without surfacing install fallback after update success", async () => {
  const attempts = [];
  const messages = [];
  await relaunchInstalledApp({
    delayMs: 1,
    writeError: (message) => messages.push(message),
    launchInstalledAppImpl: () => {
      attempts.push(Date.now());
      if (attempts.length === 1) throw new Error("global command is not ready yet");
    },
  });

  assert.equal(attempts.length, 2);
  assert.match(messages.join(""), /已安装完成，但立即重启失败/);
  assert.doesNotMatch(messages.join(""), /自动更新未完成/);
});

test("keeps completed installs out of the update-failure fallback if relaunch never starts", async () => {
  const messages = [];
  await relaunchInstalledApp({
    delayMs: 1,
    writeError: (message) => messages.push(message),
    launchInstalledAppImpl: () => {
      throw new Error("spawn EACCES");
    },
  });

  assert.match(messages.join(""), /请手动运行 agent-recall/);
  assert.doesNotMatch(messages.join(""), /自动更新未完成/);
});
