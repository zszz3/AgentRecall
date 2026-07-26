import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { applyStagedUpdate, relaunchInstalledApp } = require("../bin/apply-update.cjs");

test("swaps a validated staged package into place and removes the backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-apply-stage-"));
  try {
    const livePackagePath = path.join(directory, "agent-recall");
    const stageRoot = path.join(directory, "stage");
    const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall");
    const backupPath = path.join(directory, "backup");
    const statusPath = path.join(directory, "status.json");
    await mkdir(livePackagePath, { recursive: true });
    await mkdir(stagedPackagePath, { recursive: true });
    await writeFile(path.join(livePackagePath, "marker.txt"), "old", "utf8");
    await writeFile(path.join(stagedPackagePath, "marker.txt"), "new", "utf8");

    await applyStagedUpdate({
      version: "0.2.0",
      stageRoot,
      archivePath: path.join(stageRoot, "agent-recall.tgz"),
      stagedPackagePath,
      livePackagePath,
      backupPath,
      statusPath,
    });

    assert.equal(await readFile(path.join(livePackagePath, "marker.txt"), "utf8"), "new");
    assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "installed");
    await assert.rejects(readFile(path.join(backupPath, "marker.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
