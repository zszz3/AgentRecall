import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { applyStagedUpdate, relaunchInstalledApp, createTerminalUpdateProgress } = require("../bin/apply-update.cjs");

async function installPlatformRuntimeFixture(packagePath) {
  const platformPackageName = process.platform === "win32"
    ? "windows-x64"
    : `${process.platform}-${process.arch}`;
  const runtimeRoot = path.join(packagePath, "node_modules", "@embedded-postgres", platformPackageName);
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  await mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
  await mkdir(path.join(runtimeRoot, "native", "bin"), { recursive: true });
  await writeFile(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify({
      name: `@embedded-postgres/${platformPackageName}`,
      version: "18.4.0-beta.17",
      exports: "./dist/index.js",
    }),
  );
  await writeFile(path.join(runtimeRoot, "dist", "index.js"), "export {};\n");
  await Promise.all(["initdb", "pg_ctl", "postgres"].map((name) =>
    writeFile(
      path.join(runtimeRoot, "native", "bin", `${name}${executableSuffix}`),
      "fixture\n",
      { mode: 0o755 },
    ),
  ));
}

test("swaps a validated staged package into place and removes the backup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-apply-stage-"));
  try {
    const livePackagePath = path.join(directory, "agent-recall-v2");
    const stageRoot = path.join(directory, "stage");
    const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall-v2");
    const backupPath = path.join(directory, "backup");
    const statusPath = path.join(directory, "status.json");
    await mkdir(livePackagePath, { recursive: true });
    await mkdir(stagedPackagePath, { recursive: true });
    await writeFile(path.join(livePackagePath, "marker.txt"), "old", "utf8");
    await writeFile(path.join(stagedPackagePath, "marker.txt"), "new", "utf8");
    await installPlatformRuntimeFixture(stagedPackagePath);

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

test("preserves relative PostgreSQL library links after removing the stage", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-apply-symlink-"));
  try {
    const livePackagePath = path.join(directory, "agent-recall-v2");
    const stageRoot = path.join(directory, "stage");
    const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall-v2");
    const backupPath = path.join(directory, "backup");
    const statusPath = path.join(directory, "status.json");
    const platformPackageName = `${process.platform}-${process.arch}`;
    const stagedLibraryRoot = path.join(
      stagedPackagePath,
      "node_modules",
      "@embedded-postgres",
      platformPackageName,
      "native",
      "lib",
    );
    await mkdir(livePackagePath, { recursive: true });
    await installPlatformRuntimeFixture(stagedPackagePath);
    await mkdir(stagedLibraryRoot, { recursive: true });
    await writeFile(path.join(stagedLibraryRoot, "libfixture-real.so"), "fixture\n");
    await symlink("libfixture-real.so", path.join(stagedLibraryRoot, "libfixture.so"));

    await applyStagedUpdate({
      version: "0.2.0",
      stageRoot,
      stagedPackagePath,
      livePackagePath,
      backupPath,
      statusPath,
    });

    const liveLink = path.join(
      livePackagePath,
      "node_modules",
      "@embedded-postgres",
      platformPackageName,
      "native",
      "lib",
      "libfixture.so",
    );
    assert.equal(await readlink(liveLink), "libfixture-real.so");
    assert.equal(await readFile(liveLink, "utf8"), "fixture\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps the live package available while a staged promotion fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-apply-stage-failure-"));
  try {
    const livePackagePath = path.join(directory, "agent-recall-v2");
    const stageRoot = path.join(directory, "stage");
    const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall-v2");
    const backupPath = path.join(directory, ".agent-recall-backup-test");
    const statusPath = path.join(directory, "status.json");
    await mkdir(livePackagePath, { recursive: true });
    await mkdir(stagedPackagePath, { recursive: true });
    await writeFile(path.join(livePackagePath, "marker.txt"), "old", "utf8");
    await writeFile(path.join(stagedPackagePath, "marker.txt"), "new", "utf8");
    await installPlatformRuntimeFixture(stagedPackagePath);
    let promotionAttempted = false;

    await assert.rejects(applyStagedUpdate({
      version: "0.2.0",
      stageRoot,
      archivePath: path.join(stageRoot, "agent-recall.tgz"),
      stagedPackagePath,
      livePackagePath,
      backupPath,
      statusPath,
    }, {
      copyDirectoryImpl: async (source, destination, options) => {
        if (source === stagedPackagePath) {
          promotionAttempted = true;
          assert.equal(await readFile(path.join(livePackagePath, "marker.txt"), "utf8"), "old");
          throw new Error("simulated interrupted promotion");
        }
        return cp(source, destination, options);
      },
    }), /simulated interrupted promotion/);

    assert.equal(promotionAttempted, true);
    assert.equal(await readFile(path.join(livePackagePath, "marker.txt"), "utf8"), "old");
    assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restores the live package when staged PostgreSQL validation fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-recall-apply-runtime-failure-"));
  try {
    const livePackagePath = path.join(directory, "agent-recall-v2");
    const stageRoot = path.join(directory, "stage");
    const stagedPackagePath = path.join(stageRoot, "node_modules", "agent-recall-v2");
    const backupPath = path.join(directory, "backup");
    const statusPath = path.join(directory, "status.json");
    await mkdir(livePackagePath, { recursive: true });
    await mkdir(stagedPackagePath, { recursive: true });
    await writeFile(path.join(livePackagePath, "marker.txt"), "old", "utf8");
    await writeFile(path.join(stagedPackagePath, "marker.txt"), "new", "utf8");

    await assert.rejects(applyStagedUpdate({
      version: "0.2.0",
      stageRoot,
      stagedPackagePath,
      livePackagePath,
      backupPath,
      statusPath,
    }), /AgentRecall V2 安装不完整/);

    assert.equal(await readFile(path.join(livePackagePath, "marker.txt"), "utf8"), "old");
    assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "error");
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


test("terminal updates display download progress, stage changes and a waiting heartbeat", async () => {
  const lines = [];
  const progress = createTerminalUpdateProgress({ write: (line) => lines.push(line), heartbeatMs: 10 });
  try {
    progress.onProgress({ phase: "downloading", downloadedBytes: 1048576, totalBytes: 2097152, percent: 50, bytesPerSecond: 1024 });
    progress.onProgress({ phase: "downloading", downloadedBytes: 1048577, totalBytes: 2097152, percent: 50, bytesPerSecond: 1024 });
    assert.equal(lines.length, 2); // One connecting notice and one download line, not one per chunk.
    progress.onProgress({ phase: "staging", message: "正在安装应用依赖…" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(lines.join(""), /1\.0 \/ 2\.0 MB（50%）/);
    assert.match(lines.join(""), /1 KB\/s/);
    assert.ok(lines.filter((line) => line.includes("正在安装应用依赖")).length >= 2);
  } finally {
    progress.close();
  }
  const count = lines.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(lines.length, count);
});
