import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
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

function platformRuntimePackageName() {
  return process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
}

async function installPlatformRuntimeFixture(nodeModulesRoot) {
  const platformPackageName = platformRuntimePackageName();
  const platformPackage = path.join(nodeModulesRoot, "@embedded-postgres", platformPackageName);
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  await mkdir(path.join(platformPackage, "dist"), { recursive: true });
  await mkdir(path.join(platformPackage, "native", "bin"), { recursive: true });
  await writeFile(
    path.join(platformPackage, "package.json"),
    JSON.stringify({
      name: `@embedded-postgres/${platformPackageName}`,
      version: "18.4.0-beta.17",
      exports: "./dist/index.js",
    }),
    "utf8",
  );
  await writeFile(path.join(platformPackage, "dist", "index.js"), "export {};\n", "utf8");
  await Promise.all(["initdb", "pg_ctl", "postgres"].map((name) =>
    writeFile(
      path.join(platformPackage, "native", "bin", `${name}${executableSuffix}`),
      "fixture\n",
      { mode: 0o755 },
    ),
  ));
}

async function installStagedPackageFixture(stageRoot, packageName, version, options = {}) {
  const installed = path.join(stageRoot, "node_modules", packageName);
  await mkdir(path.join(installed, "out", "main"), { recursive: true });
  await mkdir(path.join(installed, "bin"), { recursive: true });
  await mkdir(path.join(stageRoot, "node_modules", "electron"), { recursive: true });
  await writeFile(path.join(installed, "package.json"), JSON.stringify({ name: packageName, version }), "utf8");
  await writeFile(path.join(installed, "out", "main", "index.js"), "", "utf8");
  await writeFile(path.join(installed, "bin", "agent-recall.cjs"), "", "utf8");
  await writeFile(
    path.join(stageRoot, "node_modules", "electron", "package.json"),
    JSON.stringify({ version: "42.3.0" }),
    "utf8",
  );
  if (options.includeRuntime === false) return;
  await installPlatformRuntimeFixture(path.join(stageRoot, "node_modules"));
}

const require = createRequire(import.meta.url);
const mutableFsPromises = require("node:fs/promises");
const launcherSource = await readFile(new URL("../bin/agent-recall.cjs", import.meta.url), "utf8");
const updateClientSource = await readFile(new URL("../bin/update-client.cjs", import.meta.url), "utf8");
const {
  DEFAULT_NPM_REGISTRY,
  UPDATE_REQUEST_TIMEOUT_MS,
  acquireUpdateLock,
  checkForUpdate,
  compareVersions,
  currentVersion,
  ensureElectronRuntimeForLaunch,
  ensureInstalledElectron,
  electronRuntimeLockPath,
  formatUpdateError,
  formatManualUpdateFallback,
  formatUpdateNotice,
  globalCommandPath,
  installUpdate,
  isElectronRuntimeReady,
  launchInstalledApp,
  manualInstallCommand,
  parseUpdateManifest,
  recoverInterruptedUpdate,
  showNativeUpdateFailure,
  skipUpdateVersion,
  snoozeUpdatePrompt,
  stageUpdate,
  stopRunningApp,
  waitForUpdateCompletion,
  updateLockPath,
} = require("../bin/update-client.cjs");

test("streams package bytes and reports monotonic download progress while staging", async () => {
  const bytes = Buffer.from("0123456789");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-recall-update-stage-");
  const stageRoot = path.join(directory, "stage");
  const packagePath = path.join(directory, "live", "agent-recall-v2");
  const binDirectory = path.join(directory, "Program Files", "nodejs");
  const nodePath = path.join(binDirectory, process.platform === "win32" ? "node.exe" : "node");
  const npmPath = path.join(binDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
  await mkdir(binDirectory, { recursive: true });
  await writeFile(nodePath, "", "utf8");
  await writeFile(npmPath, "", "utf8");
  const progress = [];
  let npmInvocation = null;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 5));
      controller.enqueue(bytes.subarray(5));
      controller.close();
    },
  });

  const staged = await stageUpdate(value, {
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
    stageRoot,
    packagePath,
    nodePath,
    statusPath: path.join(directory, "status.json"),
    execFileImpl: async (command, args, options) => {
      npmInvocation = { command, args, options };
      await installStagedPackageFixture(options.env.AGENT_RECALL_STAGE_ROOT, "agent-recall-v2", value.version);
      return { stdout: "", stderr: "" };
    },
    ensureElectronImpl: async ({ packagePath: installed, runtimeSourcePath }) => {
      assert.equal(runtimeSourcePath, packagePath);
      assert.equal(
        JSON.parse(await readFile(path.join(installed, "node_modules", "electron", "package.json"), "utf8")).version,
        "42.3.0",
      );
    },
    onProgress: (event) => progress.push(event),
  });

  assert.equal(staged.stagedPackagePath, path.join(stageRoot, "node_modules", "agent-recall-v2"));
  assert.equal(staged.livePackagePath, packagePath);
  assert.equal(npmInvocation.command, process.platform === "win32" ? "npm.cmd" : npmPath);
  assert.equal(npmInvocation.options.shell, process.platform === "win32");
  const npmPathKey = Object.keys(npmInvocation.options.env).find((key) => key.toLowerCase() === "path");
  assert.ok(npmPathKey);
  assert.equal(npmInvocation.options.env[npmPathKey].split(path.delimiter)[0], binDirectory);
  assert.deepEqual(
    progress.filter((event) => event.phase === "downloading").map((event) => event.percent),
    [50, 100],
  );
  assert.deepEqual(
    progress.map((event) => event.phase),
    ["downloading", "downloading", "verifying", "staging", "validating"],
  );
});

test("resolves the live V2 package without running npm root -g", async () => {
  const bytes = Buffer.from("synthetic update package");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-recall-update-live-root-");
  const stageRoot = path.join(directory, "stage");
  const packagePath = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const npmCommand = path.join(directory, "missing", process.platform === "win32" ? "npm.cmd" : "npm");
  let installInvoked = false;

  const staged = await stageUpdate(value, {
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.length) },
    }),
    stageRoot,
    npmCommand,
    statusPath: path.join(directory, "status.json"),
    execFileImpl: async (command, _args, options) => {
      installInvoked = true;
      assert.equal(command, npmCommand);
      await installStagedPackageFixture(options.env.AGENT_RECALL_STAGE_ROOT, "agent-recall-v2", value.version);
      return { stdout: "", stderr: "" };
    },
    ensureElectronImpl: async ({ runtimeSourcePath }) => {
      assert.equal(runtimeSourcePath, packagePath);
    },
  });

  assert.equal(installInvoked, true);
  assert.equal(staged.livePackagePath, packagePath);
});

test("formats a missing npm executable as an actionable update error", () => {
  assert.equal(
    formatUpdateError(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT", path: "npm" })),
    "应用进程找不到 npm。请在终端中手动运行更新命令。",
  );
});

test("resolves the installed V2 launcher through npm next to the stable Node executable", async () => {
  const directory = await temporaryDirectory("agent-recall-update-global-command-");
  const binDirectory = path.join(directory, "Program Files", "nodejs");
  const nodePath = path.join(binDirectory, process.platform === "win32" ? "node.exe" : "node");
  const npmPath = path.join(binDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
  const prefix = path.join(directory, "prefix");
  const inputPathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  let npmInvocation = null;
  await mkdir(binDirectory, { recursive: true });
  await writeFile(nodePath, "", "utf8");
  await writeFile(npmPath, "", "utf8");

  const originalPath = process.env[inputPathKey];
  let command;
  process.env[inputPathKey] = "";
  try {
    command = globalCommandPath({
      env: {
        [inputPathKey]: "",
        AGENT_RECALL_NODE_PATH: nodePath,
        ELECTRON_RUN_AS_NODE: "1",
      },
      execFileSyncImpl: (executable, args, options) => {
        npmInvocation = { executable, args, options };
        return `${prefix}\n`;
      },
    });
  } finally {
    if (originalPath === undefined) delete process.env[inputPathKey];
    else process.env[inputPathKey] = originalPath;
  }

  assert.equal(npmInvocation.executable, process.platform === "win32" ? "npm.cmd" : npmPath);
  assert.deepEqual(npmInvocation.args, ["prefix", "-g"]);
  assert.equal(npmInvocation.options.shell, process.platform === "win32");
  assert.equal(npmInvocation.options.env[inputPathKey].split(path.delimiter)[0], binDirectory);
  assert.equal(npmInvocation.options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(
    command,
    process.platform === "win32"
      ? path.join(prefix, "agent-recall-v2.cmd")
      : path.join(prefix, "bin", "agent-recall-v2"),
  );
});

test("allows enough time for a normal GitHub release check", () => {
  assert.equal(UPDATE_REQUEST_TIMEOUT_MS, 5_000);
});

async function versionFixture(prefix, { withGit = true, gitType = "dir", version = "0.1.0" } = {}) {
  const directory = await temporaryDirectory(prefix);
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ version })}\n`, "utf8");
  if (withGit) {
    if (gitType === "dir") await mkdir(path.join(directory, ".git"), { recursive: true });
    else await writeFile(path.join(directory, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");
  }
  return directory;
}

test("currentVersion prefers the git tag in a checkout", async () => {
  const directory = await versionFixture("agent-recall-version-tag-");
  const calls = [];
  const result = currentVersion({
    packageRoot: directory,
    execFileSyncImpl: (command, args) => {
      calls.push([command, ...args]);
      return "v2-0.20.2\n";
    },
  });
  assert.equal(result, "0.20.2");
  assert.deepEqual(calls, [["git", "describe", "--tags", "--abbrev=0", "--match", "v2-[0-9]*"]]);
});

test("currentVersion falls back to package.json when there is no .git", async () => {
  const directory = await versionFixture("agent-recall-version-nogit-", { withGit: false });
  let gitRan = false;
  const result = currentVersion({
    packageRoot: directory,
    execFileSyncImpl: () => {
      gitRan = true;
      throw new Error("git must not run without a .git entry");
    },
  });
  assert.equal(result, "0.1.0");
  assert.equal(gitRan, false);
});

test("currentVersion falls back to package.json when git fails", async () => {
  const directory = await versionFixture("agent-recall-version-gitfail-");
  const result = currentVersion({
    packageRoot: directory,
    execFileSyncImpl: () => {
      throw new Error("fatal: no names found, cannot describe anything");
    },
  });
  assert.equal(result, "0.1.0");
});

test("currentVersion rejects a non-semver tag and falls back", async () => {
  const directory = await versionFixture("agent-recall-version-nonsemver-");
  assert.equal(
    currentVersion({ packageRoot: directory, execFileSyncImpl: () => "nightly-build\n" }),
    "0.1.0",
  );
  assert.equal(
    currentVersion({ packageRoot: directory, execFileSyncImpl: () => "v1.2\n" }),
    "0.1.0",
  );
});

test("currentVersion reads the tag when .git is a worktree file", async () => {
  const directory = await versionFixture("agent-recall-version-worktree-", { gitType: "file" });
  const result = currentVersion({
    packageRoot: directory,
    execFileSyncImpl: () => "v2-0.20.2\n",
  });
  assert.equal(result, "0.20.2");
});


function manifest(version = "0.2.0") {
  return {
    schemaVersion: 1,
    version,
    tag: `v2-${version}`,
    title: "自动更新",
    publishedAt: "2026-07-14T00:00:00.000Z",
    releaseUrl: `https://github.com/zszz3/AgentRecall/releases/tag/v2-${version}`,
    notes: { features: ["终端显示更新。"], fixes: ["修复重启失败。"] },
    package: {
      name: `agent-recall-v2-${version}.tgz`,
      url: `https://github.com/zszz3/AgentRecall/releases/download/v2-${version}/agent-recall-v2-${version}.tgz`,
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
      ? new Response(JSON.stringify([{ tag_name: "v2-0.2.0", draft: false, prerelease: false, assets: [{ name: "update-v2.json", browser_download_url: "https://download.example/update-v2.json" }] }]), { status: 200 })
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
    ? new Response(JSON.stringify([{ tag_name: `v2-${value.version}`, draft: false, prerelease: false, assets: [{ name: "update-v2.json", browser_download_url: "https://download.example/update-v2.json" }] }]), { status: 200 })
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

test("terminal launcher marks npm-installed launches as release builds", () => {
  assert.match(launcherSource, /environment\.AGENT_RECALL_RELEASE_BUILD = "1"/);
  assert.match(launcherSource, /environment\.AGENT_RECALL_SOURCE_BUILD !== "1"/);
  assert.match(launcherSource, /const appPath = path\.join\(__dirname, "\.\."\)/);
  assert.match(launcherSource, /spawn\(electronPath, \[appPath\]/);
  assert.doesNotMatch(launcherSource, /spawn\(electronPath, \[appEntry\]/);
});

test("terminal launcher continues with a validated Electron runtime after repair errors", () => {
  assert.match(launcherSource, /isElectronRuntimeReady/);
  assert.match(launcherSource, /try \{\s*await ensureElectronRuntimeForLaunch\(/);
  assert.match(launcherSource, /if \(!isElectronRuntimeReady\(packagePath\)\) throw error;/);
  assert.match(launcherSource, /继续启动应用/);
});

test("terminal launcher validates embedded PostgreSQL before starting Electron", () => {
  assert.match(launcherSource, /restoreEmbeddedPostgresNativeLinks/);
  assert.match(
    launcherSource,
    /await restoreEmbeddedPostgresNativeLinks\(path\.join\(packagePath, "node_modules"\)\);\s*assertEmbeddedPostgresRuntime\(\{ packagePath \}\);\s*try \{\s*await ensureElectronRuntimeForLaunch/,
  );
});

test("rejects an update missing its platform PostgreSQL runtime before promotion", async () => {
  const bytes = Buffer.from("runtime-missing update package");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-recall-update-postgres-runtime-");
  const stageRoot = path.join(directory, "stage");
  const packagePath = path.join(directory, "live", "agent-recall-v2");
  const statusPath = path.join(directory, "status.json");
  await mkdir(packagePath, { recursive: true });
  await writeFile(path.join(packagePath, "marker.txt"), "live package\n");

  await assert.rejects(
    stageUpdate(value, {
      fetchImpl: async () => new Response(bytes, { status: 200 }),
      stageRoot,
      packagePath,
      statusPath,
      execFileImpl: async (_command, _args, options) => {
        await installStagedPackageFixture(
          options.env.AGENT_RECALL_STAGE_ROOT,
          "agent-recall-v2",
          value.version,
          { includeRuntime: false },
        );
        return { stdout: "", stderr: "" };
      },
      ensureElectronImpl: async () => {
        assert.fail("Electron validation must not run after PostgreSQL runtime validation fails.");
      },
    }),
    /AgentRecall V2 安装不完整/,
  );

  assert.equal(await readFile(path.join(packagePath, "marker.txt"), "utf8"), "live package\n");
  assert.equal(JSON.parse(await readFile(statusPath, "utf8")).status, "error");
});

test("terminal launcher does not prompt again for a skipped update version", () => {
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
      packagePath: path.join(statusDirectory, "prefix", "lib", "node_modules", "agent-recall-v2"),
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
  value.releaseUrl = "https://github.com/zszz3/AgentRecall/releases/tag/v2-0.5.0";
  value.package.url = "https://github.com/zszz3/AgentRecall/releases/download/v2-0.5.0/agent-recall-v2-0.5.0.tgz";
  assert.equal(parseUpdateManifest(value).package.url, value.package.url);
});

test("checks the newest V2 release without selecting a newer V1 release", async () => {
  const value = manifest();
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-cache-");
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify([
        { tag_name: "v0.40.0", draft: false, prerelease: false, assets: [{ name: "update.json", browser_download_url: "https://download.example/update.json" }] },
        { tag_name: "v2-0.2.0", draft: false, prerelease: false, assets: [{ name: "update-v2.json", browser_download_url: "https://download.example/update-v2.json" }] },
      ]), {
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
  assert.equal(requests[0], "https://api.github.com/repos/zszz3/AgentRecall/releases?per_page=100");
});

test("follows GitHub pagination until it finds the newest V2 release", async () => {
  const value = manifest();
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-pagination-");
  const secondPage = "https://api.github.com/repositories/123/releases?per_page=100&page=2";
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (requests.length === 1) {
      return new Response(JSON.stringify([
        { tag_name: "v0.40.0", draft: false, prerelease: false, assets: [{ name: "update.json", browser_download_url: "https://download.example/update.json" }] },
      ]), {
        status: 200,
        headers: {
          etag: '"release-etag"',
          link: `<${secondPage}>; rel="next", <${secondPage}>; rel="last"`,
        },
      });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify([
        { tag_name: "v2-0.2.0", draft: false, prerelease: false, assets: [{ name: "update-v2.json", browser_download_url: "https://download.example/update-v2.json" }] },
      ]), { status: 200 });
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
  assert.deepEqual(requests, [
    "https://api.github.com/repos/zszz3/AgentRecall/releases?per_page=100",
    secondPage,
    "https://download.example/update-v2.json",
  ]);
});

test("falls back to the rolling V2 manifest when the release API fails", async () => {
  const value = manifest("0.10.0");
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-stable-fallback-");
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes("api.github.com")) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
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
  assert.equal(result.manifest.version, "0.10.0");
  assert.equal(result.error, null);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/zszz3/AgentRecall/releases?per_page=100",
    "https://github.com/zszz3/AgentRecall/releases/download/v2-latest/update-v2.json",
  ]);
});

test("falls back to published Git refs when the release API is rate limited", async () => {
  const value = manifest("0.10.0");
  const requests = [];
  const cacheDirectory = await temporaryDirectory("agent-session-update-refs-fallback-");
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes("api.github.com")) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
    }
    if (String(url).includes("/v2-latest/")) return new Response("", { status: 404 });
    if (String(url).includes("info/refs?service=git-upload-pack")) {
      return new Response(
        [
          "001e# service=git-upload-pack\n0000",
          `${"a".repeat(40)} refs/tags/v2-0.9.0`,
          `${"b".repeat(40)} refs/tags/v0.40.0`,
          `${"c".repeat(40)} refs/tags/v2-0.10.0`,
          `${"d".repeat(40)} refs/tags/v2-0.11.0`,
        ].join("\n"),
        { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" } },
      );
    }
    if (String(url).includes("/v2-0.11.0/")) return new Response("", { status: 404 });
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
  assert.equal(result.manifest.version, "0.10.0");
  assert.equal(result.error, null);
  assert.deepEqual(requests, [
    "https://api.github.com/repos/zszz3/AgentRecall/releases?per_page=100",
    "https://github.com/zszz3/AgentRecall/releases/download/v2-latest/update-v2.json",
    "https://github.com/zszz3/AgentRecall.git/info/refs?service=git-upload-pack",
    "https://github.com/zszz3/AgentRecall/releases/download/v2-0.11.0/update-v2.json",
    "https://github.com/zszz3/AgentRecall/releases/download/v2-0.10.0/update-v2.json",
  ]);
});

test("keeps the original release error when every V2 manifest fallback is missing", async () => {
  const cacheDirectory = await temporaryDirectory("agent-session-update-missing-fallback-");
  const fetchImpl = async (url) => {
    if (String(url).includes("api.github.com")) {
      return new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
    }
    if (String(url).includes("info/refs?service=git-upload-pack")) {
      return new Response(`${"a".repeat(40)} refs/tags/v2-0.11.0\n`, { status: 200 });
    }
    return new Response("", { status: 404 });
  };

  const result = await checkForUpdate({
    currentVersion: "0.10.0",
    cachePath: path.join(cacheDirectory, "update-check.json"),
    fetchImpl,
    force: true,
    now: 123,
  });

  assert.equal(result.updateAvailable, false);
  assert.equal(result.error, "GitHub release check failed (403).");
});

test("keeps a cached V2 manifest when the release API is unavailable", async () => {
  const value = manifest("0.2.0");
  const cacheDirectory = await temporaryDirectory("agent-session-update-fallback-");
  const cachePath = path.join(cacheDirectory, "update-check.json");
  await writeFile(cachePath, JSON.stringify({ checkedAt: 100, etag: '"old"', manifest: value }), "utf8");

  const result = await checkForUpdate({
    currentVersion: "0.1.0",
    cachePath,
    fetchImpl: async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 }),
    force: true,
    now: 123,
  });

  assert.equal(result.updateAvailable, true);
  assert.match(result.error, /GitHub release check failed \(403\)/);
  assert.equal(result.manifest.version, "0.2.0");
});

// GitHub's repository-wide "Latest" release belongs to V1, so the manual install
// command must point at the rolling v2-latest tag rather than a version that goes
// stale the moment the next release ships.
test("provides an actionable manual fallback when automatic installation fails", () => {
  assert.equal(
    manualInstallCommand(),
    "npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2-latest/agent-recall-v2.tgz",
  );
  const message = formatManualUpdateFallback("0.2.0");
  assert.match(message, /自动更新未完成/);
  assert.match(message, /npm install -g https:\/\/github\.com\/zszz3\/AgentRecall\/releases\/download\/v2-latest\/agent-recall-v2\.tgz/);
  assert.match(message, /https:\/\/github\.com\/zszz3\/AgentRecall\/releases\/tag\/v2-0\.2\.0/);
});

test("falls back to the releases index when no version is known", () => {
  const message = formatManualUpdateFallback();
  assert.match(message, /npm install -g https:\/\/github\.com\/zszz3\/AgentRecall\/releases\/download\/v2-latest\/agent-recall-v2\.tgz/);
  assert.match(message, /https:\/\/github\.com\/zszz3\/AgentRecall\/releases$/m);
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
    version: "0.2.0",
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
  assert.match(calls[1].options.input, /npm install -g .*agent-recall-v2\.tgz/);
});

test("shows a Windows-native fallback without requiring Electron", () => {
  let invocation = null;
  const shown = showNativeUpdateFailure("npm install failed", {
    version: "0.2.0",
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

// The dialog offers "复制安装命令" unconditionally, so the command must be usable
// even when the failure happened before a target version was known.
test("still offers a usable install command when no version was determined", () => {
  let invocation = null;
  const shown = showNativeUpdateFailure("npm install failed", {
    platform: "win32",
    execFileSyncImpl: (command, args, options) => {
      invocation = { command, args, options };
      return "";
    },
  });
  assert.equal(shown, true);
  assert.equal(
    invocation.options.env.AGENT_RECALL_UPDATE_COMMAND,
    "npm install -g https://github.com/zszz3/AgentRecall/releases/download/v2-latest/agent-recall-v2.tgz",
  );
  assert.equal(invocation.options.env.AGENT_RECALL_UPDATE_RELEASE_URL, "https://github.com/zszz3/AgentRecall/releases");
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
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall-v2");
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

test("recovers the previous package after an interrupted staged promotion", async () => {
  const directory = await temporaryDirectory("agent-session-update-recovery-");
  const packageParent = path.join(directory, "node_modules");
  const packagePath = path.join(packageParent, "agent-recall-v2");
  const backupPath = path.join(packageParent, ".agent-recall-backup-test");
  const stageRoot = path.join(packageParent, ".agent-recall-stage-test");
  const statusPath = path.join(directory, "status.json");
  await mkdir(packagePath, { recursive: true });
  await mkdir(backupPath, { recursive: true });
  await mkdir(stageRoot, { recursive: true });
  await writeFile(path.join(packagePath, "marker.txt"), "partial update", "utf8");
  await writeFile(path.join(backupPath, "marker.txt"), "previous version", "utf8");
  await writeFile(statusPath, JSON.stringify({
    status: "installing",
    version: "0.2.0",
    recovery: { livePackagePath: packagePath, backupPath, stageRoot },
  }), "utf8");

  assert.equal(await recoverInterruptedUpdate({ packagePath, statusPath }), true);
  assert.equal(await readFile(path.join(packagePath, "marker.txt"), "utf8"), "previous version");
  assert.match(JSON.parse(await readFile(statusPath, "utf8")).error, /已恢复到更新前的版本/);
  await assert.rejects(readFile(path.join(backupPath, "marker.txt"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readdir(stageRoot), { code: "ENOENT" });
});

test("installs through the public registry and records a completed status", async () => {
  const bytes = Buffer.from("verified update archive");
  const value = manifest();
  value.package.sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = await temporaryDirectory("agent-session-update-install-");
  const statusPath = path.join(directory, "status.json");
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall-v2");
  await mkdir(packagePath, { recursive: true });
  let invocation = null;
  let electronChecked = false;
  await installUpdate(value, {
    fetchImpl: async () => new Response(bytes, { status: 200 }),
    statusPath,
    packagePath,
    execFileImpl: async (command, args, options) => {
      invocation = { command, args, options };
      await rm(packagePath, { recursive: true, force: true });
      await mkdir(packagePath, { recursive: true });
      await writeFile(
        path.join(packagePath, "package.json"),
        JSON.stringify({ dependencies: { "embedded-postgres": "18.4.0-beta.17" } }),
      );
      await installPlatformRuntimeFixture(path.join(packagePath, "node_modules"));
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
  const packagePath = path.join(directory, "prefix", "lib", "node_modules", "agent-recall-v2");
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
    ensureElectronImpl: async () => {
      assert.fail("Electron validation must not run when PostgreSQL validation fails.");
    },
  }), /AgentRecall V2 安装不完整/);

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

test("uses Node mode only for Node probes when launched by Electron", async () => {
  const directory = await temporaryDirectory("agent-session-electron-node-mode-");
  const packagePath = path.join(directory, "agent-recall-v2");
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
        if (command === process.execPath) {
          assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
          assert.equal(options.env.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE, "1");
          assert.equal(args[0], "-e");
          return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
        }
        assert.equal("ELECTRON_RUN_AS_NODE" in options.env, false);
        return { stdout: "v42.3.0\n", stderr: "" };
      },
    });
  } finally {
    delete process.versions.electron;
  }

  assert.ok(invocation);
});

test("restores real Electron metadata left by the legacy staging bridge", async () => {
  const directory = await temporaryDirectory("agent-session-electron-staging-bridge-");
  const packagePath = path.join(directory, "agent-recall-v2");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  const markerPath = path.join(electronPath, ".agent-recall-staging-bridge.json");
  const bridgedVersion = process.versions.node;
  await mkdir(packagePath, { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "agent-recall-v2",
    dependencies: { electron: bridgedVersion },
  }), "utf8");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ name: "electron", version: bridgedVersion }), "utf8");
  await writeFile(path.join(electronPath, "install.js"), "throw new Error('install script should not run');\n", "utf8");
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), bridgedVersion, "utf8");
  await writeFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    electronVersion: "42.3.0",
    bridgedVersion,
  }), "utf8");

  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    execFileImpl: async (command, args) => {
      if (command === process.execPath) {
        assert.equal(args[0], "-e");
        return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
      }
      return { stdout: "v42.3.0\n", stderr: "" };
    },
  });

  const restoredPackage = JSON.parse(await readFile(path.join(electronPath, "package.json"), "utf8"));
  const restoredAgentRecallPackage = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8"));
  assert.equal(restoredPackage.version, "42.3.0");
  assert.equal(restoredAgentRecallPackage.dependencies.electron, "42.3.0");
  assert.equal(await readFile(path.join(electronPath, "dist", "version"), "utf8"), "42.3.0");
  await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
});

test("resumes a partially restored legacy Electron staging bridge", async () => {
  const directory = await temporaryDirectory("agent-session-electron-partial-staging-bridge-");
  const packagePath = path.join(directory, "agent-recall-v2");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  const markerPath = path.join(electronPath, ".agent-recall-staging-bridge.json");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "agent-recall-v2",
    dependencies: { electron: "42.3.0" },
  }), "utf8");
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({
    name: "electron",
    version: "24.15.0",
    files: [".agent-recall-staging-bridge.json"],
  }), "utf8");
  await writeFile(path.join(electronPath, "install.js"), "throw new Error('install script should not run');\n", "utf8");
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
  await writeFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    electronVersion: "42.3.0",
    bridgedVersion: "24.15.0",
  }), "utf8");

  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    execFileImpl: async (command, args) => {
      if (command === process.execPath) {
        assert.equal(args[0], "-e");
        return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
      }
      return { stdout: "v42.3.0\n", stderr: "" };
    },
  });

  assert.equal(JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")).dependencies.electron, "42.3.0");
  assert.deepEqual(JSON.parse(await readFile(path.join(electronPath, "package.json"), "utf8")), {
    name: "electron",
    version: "42.3.0",
    files: [],
  });
  assert.equal(await readFile(path.join(electronPath, "dist", "version"), "utf8"), "42.3.0");
  await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
});

test("rejects a non-object legacy Electron staging bridge marker", async () => {
  const directory = await temporaryDirectory("agent-session-electron-invalid-staging-bridge-");
  const packagePath = path.join(directory, "agent-recall-v2");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  await mkdir(electronPath, { recursive: true });
  await writeFile(path.join(electronPath, ".agent-recall-staging-bridge.json"), "null\n", "utf8");

  await assert.rejects(
    ensureInstalledElectron({ packagePath, timeoutMs: 5_000 }),
    /Electron staging bridge metadata is invalid/,
  );
});

test("repairs a blocked Electron install after restoring packaged bridge metadata", async () => {
  const directory = await temporaryDirectory("agent-session-electron-blocked-staging-install-");
  const packagePath = path.join(directory, "agent-recall-v2");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  const executablePath = path.join(electronPath, "dist", relativeExecutable);
  const installScript = path.join(electronPath, "install.js");
  const markerPath = path.join(electronPath, ".agent-recall-staging-bridge.json");
  await mkdir(electronPath, { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "agent-recall-v2",
    dependencies: { electron: "24.15.0" },
  }), "utf8");
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({
    name: "electron",
    version: "24.15.0",
    files: [".agent-recall-staging-bridge.json"],
  }), "utf8");
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(installScript, "throw new Error('test executor handles this script');\n", "utf8");
  await writeFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    electronVersion: "42.3.0",
    bridgedVersion: "24.15.0",
  }), "utf8");

  let installRuns = 0;
  await ensureInstalledElectron({
    packagePath,
    env: { AGENT_RECALL_STAGING_INSTALL: "1" },
    timeoutMs: 5_000,
    execFileImpl: async (command, args, options) => {
      if (command === process.execPath && args[0] === installScript) {
        installRuns += 1;
        assert.equal(options.env.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE, "1");
        await mkdir(path.dirname(executablePath), { recursive: true });
        await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
        await writeFile(executablePath, "ok", "utf8");
        await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
        await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
        await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
        return { stdout: "", stderr: "" };
      }
      if (command === process.execPath && args[0] === "-e") {
        if (!await readFile(executablePath, "utf8").catch(() => null)) throw new Error("runtime is missing");
        return { stdout: executablePath, stderr: "" };
      }
      if (command === executablePath) {
        assert.equal("ELECTRON_RUN_AS_NODE" in options.env, false);
        return { stdout: "v42.3.0\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(installRuns, 1);
  assert.equal(JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")).dependencies.electron, "42.3.0");
  assert.equal(JSON.parse(await readFile(path.join(electronPath, "package.json"), "utf8")).version, "42.3.0");
  await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
});

test("replaces the macOS staging runtime after a legacy updater swaps the package", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = await temporaryDirectory("agent-session-electron-macos-staging-runtime-");
  const packagePath = path.join(directory, "agent-recall-v2");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = path.join("Electron.app", "Contents", "MacOS", "Electron");
  const relativeDefaultApp = path.join("Electron.app", "Contents", "Resources", "default_app.asar");
  const executablePath = path.join(electronPath, "dist", relativeExecutable);
  const defaultAppPath = path.join(electronPath, "dist", relativeDefaultApp);
  const installScript = path.join(electronPath, "install.js");
  const markerPath = path.join(electronPath, ".agent-recall-staging-bridge.json");
  await mkdir(path.dirname(executablePath), { recursive: true });
  await mkdir(path.dirname(defaultAppPath), { recursive: true });
  await writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "agent-recall-v2",
    dependencies: { electron: "24.15.0" },
  }), "utf8");
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({
    name: "electron",
    version: "24.15.0",
    files: [".agent-recall-staging-bridge.json", "dist", "path.txt"],
  }), "utf8");
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(installScript, "throw new Error('test executor handles this script');\n", "utf8");
  await writeFile(path.join(electronPath, "path.txt"), "Electron.app/Contents/MacOS/Electron", "utf8");
  await writeFile(executablePath, "staging runtime", "utf8");
  await writeFile(defaultAppPath, "agent-recall-staging-runtime\n", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "24.15.0", "utf8");
  await writeFile(markerPath, JSON.stringify({
    schemaVersion: 1,
    electronVersion: "42.3.0",
    bridgedVersion: "24.15.0",
    stagingRuntimePlatforms: ["darwin"],
  }), "utf8");

  let installRuns = 0;
  await ensureInstalledElectron({
    packagePath,
    platform: "darwin",
    homeDir: directory,
    findCachedArchiveImpl: async () => null,
    timeoutMs: 5_000,
    execFileImpl: async (command, args, options) => {
      if (command === process.execPath && args[0] === installScript) {
        installRuns += 1;
        assert.equal(options.env.AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE, "1");
        await mkdir(path.dirname(executablePath), { recursive: true });
        await mkdir(path.dirname(defaultAppPath), { recursive: true });
        await writeFile(executablePath, "real runtime", "utf8");
        await writeFile(defaultAppPath, "real default app", "utf8");
        await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
        await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
        return { stdout: "", stderr: "" };
      }
      if (command === process.execPath && args[0] === "-e") {
        return { stdout: executablePath, stderr: "" };
      }
      if (command === executablePath) {
        const runtime = await readFile(executablePath, "utf8");
        return { stdout: runtime === "staging runtime" ? "v24.15.0\n" : "v42.3.0\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(installRuns, 1);
  assert.equal(await readFile(executablePath, "utf8"), "real runtime");
  assert.equal(await readFile(defaultAppPath, "utf8"), "real default app");
  assert.equal(JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf8")).dependencies.electron, "42.3.0");
  assert.equal(JSON.parse(await readFile(path.join(electronPath, "package.json"), "utf8")).version, "42.3.0");
  await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
});

test("uses a stable Node executable for Electron runtime checks after npm replaces Electron", async () => {
  const directory = await temporaryDirectory("agent-session-electron-stable-node-");
  const packagePath = path.join(directory, "agent-recall-v2");
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
  assert.equal("ELECTRON_RUN_AS_NODE" in commands[1].options.env, false);
});

test("accepts a ready Electron runtime when the version probe has no output", async () => {
  const directory = await temporaryDirectory("agent-session-electron-blank-version-");
  const packagePath = path.join(directory, "agent-recall-v2");
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
  await writeFile(path.join(electronPath, "install.js"), 'throw new Error("install script should not run");\n', "utf8");
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "ok", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");

  const calls = [];
  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === process.execPath) {
        assert.equal(args[0], "-e");
        return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });

  assert.equal(calls.some((call) => call.args[0] === path.join(electronPath, "install.js")), false);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("repairs a missing path.txt after install.js populates a complete runtime", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-missing-path-");
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
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(
    path.join(electronPath, "install.js"),
    [
      'const fs = require("node:fs"); const path = require("node:path");',
      `const executable = path.join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});`,
      `const defaultApp = path.join(__dirname, "dist", ${JSON.stringify(relativeDefaultApp)});`,
      'fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "#!/bin/sh\\necho v42.3.0\\n"); fs.chmodSync(executable, 0o755);',
      'fs.mkdirSync(path.dirname(defaultApp), { recursive: true }); fs.writeFileSync(defaultApp, "ok");',
      'fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");',
    ].join(" "),
    "utf8",
  );

  await ensureInstalledElectron({ packagePath, timeoutMs: 5_000, execFileImpl: electronFixtureExec });
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("retries transient ENOTEMPTY failures while removing the previous Electron runtime", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-backup-cleanup-");
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
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "corrupt-runtime", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "old-default", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
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

  const originalRm = mutableFsPromises.rm;
  let backupRemovalAttempts = 0;
  let installRuns = 0;
  mutableFsPromises.rm = async (target, options) => {
    if (String(target).includes(".agent-recall-electron-cleanup-")) {
      backupRemovalAttempts += 1;
      if (backupRemovalAttempts <= 2) {
        const error = new Error("directory not empty");
        error.code = "ENOTEMPTY";
        throw error;
      }
    }
    return originalRm(target, options);
  };
  try {
    await ensureInstalledElectron({
      packagePath,
      timeoutMs: 5_000,
      findCachedArchiveImpl: async () => null,
      execFileImpl: async (command, args, options) => {
        if (command === process.execPath && args[0] === path.join(electronPath, "install.js")) {
          installRuns += 1;
        }
        return electronFixtureExec(command, args, options);
      },
    });
  } finally {
    mutableFsPromises.rm = originalRm;
  }

  assert.equal(backupRemovalAttempts, 3);
  assert.equal(installRuns, 1);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("keeps a validated Electron repair when backup cleanup stays blocked", async () => {
  const directory = await temporaryDirectory("agent-session-electron-blocked-backup-cleanup-");
  const packagePath = path.join(directory, "agent-recall-v2");
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
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "corrupt-runtime", "utf8");
  await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "old-default", "utf8");
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
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

  const originalRm = mutableFsPromises.rm;
  mutableFsPromises.rm = async (target, options) => {
    const value = String(target);
    if (
      (value.includes(".agent-recall-dist-") && value.endsWith(".backup"))
      || value.includes(".agent-recall-electron-cleanup-")
    ) {
      const error = new Error("directory not empty");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return originalRm(target, options);
  };
  try {
    await ensureInstalledElectron({
      packagePath,
      timeoutMs: 5_000,
      findCachedArchiveImpl: async () => null,
      execFileImpl: electronFixtureExec,
    });
  } finally {
    mutableFsPromises.rm = originalRm;
  }

  assert.equal(isElectronRuntimeReady(packagePath), true);
  assert.deepEqual(
    (await readdir(electronPath)).filter((name) => name.endsWith(".backup")),
    [],
  );
});

test("restores Electron runtime files from a cached archive when install.js leaves dist incomplete", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-cache-repair-");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  const archivePath = path.join(packagePath, "electron-cache.zip");
  await mkdir(electronPath, { recursive: true });
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(
    path.join(electronPath, "install.js"),
    'const fs = require("node:fs"); const path = require("node:path"); fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");\n',
    "utf8",
  );
  await writeFile(archivePath, "fake-archive", "utf8");

  let extracted = false;
  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    execFileImpl: electronFixtureExec,
    findCachedArchiveImpl: async () => archivePath,
    extractArchiveImpl: async ({ archivePath: actualArchivePath, distPath }) => {
      extracted = true;
      assert.equal(actualArchivePath, archivePath);
      await mkdir(path.join(distPath, path.dirname(relativeExecutable)), { recursive: true });
      await mkdir(path.join(distPath, path.dirname(relativeDefaultApp)), { recursive: true });
      await writeFile(path.join(distPath, relativeExecutable), "#!/bin/sh\necho v42.3.0\n", "utf8");
      await writeFile(path.join(distPath, relativeDefaultApp), "ok", "utf8");
      await writeFile(path.join(distPath, "version"), "42.3.0", "utf8");
    },
  });

  assert.equal(extracted, true);
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("copies a same-version live Electron runtime before install.js or cache extract", async () => {
  const directory = await temporaryDirectory("agent-session-electron-runtime-source-");
  const packagePath = path.join(directory, "staged", "agent-recall-v2");
  const runtimeSourcePath = path.join(directory, "live", "agent-recall-v2");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");

  async function writeElectronPackage(root, { ready }) {
    const electronPath = path.join(root, "node_modules", "electron");
    await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
    await mkdir(path.join(electronPath, "dist", path.dirname(relativeDefaultApp)), { recursive: true });
    await writeFile(
      path.join(electronPath, "index.js"),
      `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
      "utf8",
    );
    await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
    await writeFile(path.join(electronPath, "install.js"), 'throw new Error("install script should not run");\n', "utf8");
    if (ready) {
      await writeFile(path.join(electronPath, "path.txt"), relativeExecutable, "utf8");
      await writeFile(path.join(electronPath, "dist", relativeExecutable), "#!/bin/sh\necho v42.3.0\n", "utf8");
      await writeFile(path.join(electronPath, "dist", relativeDefaultApp), "live-default-app", "utf8");
      await writeFile(path.join(electronPath, "dist", "version"), "42.3.0", "utf8");
    }
  }

  await writeElectronPackage(packagePath, { ready: false });
  await writeElectronPackage(runtimeSourcePath, { ready: true });

  let installScriptRuns = 0;
  let extractRuns = 0;
  await ensureInstalledElectron({
    packagePath,
    runtimeSourcePath,
    timeoutMs: 5_000,
    findCachedArchiveImpl: async () => {
      throw new Error("cache lookup should not run");
    },
    extractArchiveImpl: async () => {
      extractRuns += 1;
    },
    execFileImpl: async (command, args, options) => {
      if (command === process.execPath && args[0]?.endsWith(`${path.sep}install.js`)) {
        installScriptRuns += 1;
      }
      return electronFixtureExec(command, args, options);
    },
  });

  assert.equal(installScriptRuns, 0);
  assert.equal(extractRuns, 0);
  assert.equal(
    await readFile(path.join(packagePath, "node_modules", "electron", "dist", relativeDefaultApp), "utf8"),
    "live-default-app",
  );
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("extracts cached Electron archives through a Node subprocess", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-subprocess-extract-");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const extractorPath = path.join(packagePath, "node_modules", "@electron-internal", "extract-zip");
  const relativeExecutable = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
  const relativeDefaultApp = process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "Resources", "default_app.asar")
    : path.join("resources", "default_app.asar");
  const archivePath = path.join(packagePath, "electron-cache.zip");
  await mkdir(electronPath, { recursive: true });
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(
    path.join(electronPath, "install.js"),
    'const fs = require("node:fs"); const path = require("node:path"); fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");\n',
    "utf8",
  );
  await mkdir(extractorPath, { recursive: true });
  await writeFile(
    path.join(extractorPath, "package.json"),
    JSON.stringify({ name: "@electron-internal/extract-zip", version: "1.0.5", main: "index.cjs" }),
    "utf8",
  );
  await writeFile(
    path.join(extractorPath, "index.cjs"),
    [
      'const fs = require("node:fs/promises"); const path = require("node:path");',
      "exports.extract = async (_archivePath, { dir }) => {",
      `  const executable = path.join(dir, ${JSON.stringify(relativeExecutable)});`,
      `  const defaultApp = path.join(dir, ${JSON.stringify(relativeDefaultApp)});`,
      '  await fs.mkdir(path.dirname(executable), { recursive: true });',
      '  await fs.mkdir(path.dirname(defaultApp), { recursive: true });',
      '  await fs.writeFile(executable, "#!/bin/sh\\necho v42.3.0\\n", { mode: 0o755 });',
      '  await fs.writeFile(defaultApp, "ok");',
      '  await fs.writeFile(path.join(dir, "version"), "42.3.0");',
      "};",
    ].join("\n"),
    "utf8",
  );
  await writeFile(archivePath, "fake-archive", "utf8");

  const extractCommands = [];
  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    findCachedArchiveImpl: async () => archivePath,
    execFileImpl: async (command, args, options) => {
      if (command === process.execPath && args[0] === "-e" && String(args[1] || "").includes("@electron-internal/extract-zip")) {
        extractCommands.push({ command, args, options });
        return execFileAsync(command, args, options);
      }
      return electronFixtureExec(command, args, options);
    },
  });

  assert.equal(extractCommands.length, 1);
  assert.match(extractCommands[0].args[1], /createRequire/);
  assert.match(extractCommands[0].args[1], /@electron-internal\/extract-zip/);
  assert.equal(extractCommands[0].options.timeout, 5_000);
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
  assert.equal(isElectronRuntimeReady(packagePath), true);
});

test("forces an uncached Electron reinstall after normal repair and cache recovery fail", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-force-download-");
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
  await writeFile(
    path.join(electronPath, "index.js"),
    `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`,
    "utf8",
  );
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }), "utf8");
  await writeFile(
    path.join(electronPath, "install.js"),
    [
      'const fs = require("node:fs"); const path = require("node:path");',
      'fs.rmSync(path.join(__dirname, "dist"), { recursive: true, force: true });',
      'fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });',
      'if (process.env.force_no_cache === "true" && process.env.ELECTRON_MIRROR === "https://npmmirror.com/mirrors/electron/" && process.env.ELECTRON_CUSTOM_DIR === "{{ version }}") {',
      `  const executable = path.join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});`,
      `  const defaultApp = path.join(__dirname, "dist", ${JSON.stringify(relativeDefaultApp)});`,
      '  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "#!/bin/sh\\necho v42.3.0\\n"); fs.chmodSync(executable, 0o755);',
      '  fs.mkdirSync(path.dirname(defaultApp), { recursive: true }); fs.writeFileSync(defaultApp, "ok");',
      '  fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");',
      '} else {',
      '  fs.writeFileSync(path.join(__dirname, "dist", "version"), "42.3.0");',
      '}',
    ].join(" "),
    "utf8",
  );

  const installRuns = [];
  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    env: { force_no_cache: "", ELECTRON_MIRROR: "", ELECTRON_CUSTOM_DIR: "" },
    findCachedArchiveImpl: async () => null,
    execFileImpl: async (command, args, options) => {
      if (command === process.execPath && args[0] === path.join(electronPath, "install.js")) {
        installRuns.push({
          forceNoCache: options.env.force_no_cache || "",
          mirror: options.env.ELECTRON_MIRROR || "",
          customDir: options.env.ELECTRON_CUSTOM_DIR || "",
        });
      }
      return electronFixtureExec(command, args, options);
    },
  });

  assert.deepEqual(installRuns, [
    { forceNoCache: "", mirror: "", customDir: "" },
    { forceNoCache: "true", mirror: "", customDir: "" },
    {
      forceNoCache: "true",
      mirror: "https://npmmirror.com/mirrors/electron/",
      customDir: "{{ version }}",
    },
  ]);
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
  assert.equal(isElectronRuntimeReady(packagePath), true);
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

test("accepts the restored Electron runtime when a repair fails after a transient probe error", async () => {
  const packagePath = await temporaryDirectory("agent-session-electron-restored-runtime-");
  const electronPath = path.join(packagePath, "node_modules", "electron");
  const relativeExecutable = process.platform === "darwin" ? path.join("Electron.app", "Contents", "MacOS", "Electron") : process.platform === "win32" ? "electron.exe" : "electron";
  const defaultApp = process.platform === "darwin" ? path.join("Electron.app", "Contents", "Resources", "default_app.asar") : path.join("resources", "default_app.asar");
  await mkdir(path.join(electronPath, "dist", path.dirname(relativeExecutable)), { recursive: true });
  await mkdir(path.join(electronPath, "dist", path.dirname(defaultApp)), { recursive: true });
  await writeFile(path.join(electronPath, "index.js"), `module.exports = require("node:path").join(__dirname, "dist", ${JSON.stringify(relativeExecutable)});\n`);
  await writeFile(path.join(electronPath, "package.json"), JSON.stringify({ version: "42.3.0" }));
  await writeFile(path.join(electronPath, "path.txt"), relativeExecutable);
  await writeFile(path.join(electronPath, "dist", "version"), "42.3.0");
  await writeFile(path.join(electronPath, "dist", defaultApp), "ready-default");
  await writeFile(path.join(electronPath, "dist", relativeExecutable), "ready-runtime");
  await writeFile(path.join(electronPath, "install.js"), 'throw new Error("download failed");\n');

  let versionProbeCount = 0;
  await ensureInstalledElectron({
    packagePath,
    timeoutMs: 5_000,
    execFileImpl: async (command, args) => {
      if (command === process.execPath && args[0] === "-e") {
        return { stdout: path.join(electronPath, "dist", relativeExecutable), stderr: "" };
      }
      if (command === process.execPath && args[0] === path.join(electronPath, "install.js")) {
        throw new Error("download failed");
      }
      if (command === path.join(electronPath, "dist", relativeExecutable)) {
        versionProbeCount += 1;
        if (versionProbeCount === 1) throw new Error("transient probe failure");
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  });

  assert.equal(versionProbeCount, 2);
  assert.equal(await readFile(path.join(electronPath, "path.txt"), "utf8"), relativeExecutable);
  assert.equal(isElectronRuntimeReady(packagePath), true);
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
  assert.match(launcher, /waitForProcessExit\(waitPid, 30_000\)/);
  assert.match(launcher, /ensureElectronRuntimeForLaunch/);
});

test("pins the Electron runtime used by CI and global installs", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.dependencies.electron, "42.9.2");
  const electronRequire = createRequire(require.resolve("electron/package.json"));
  assert.equal(typeof electronRequire("@electron-internal/extract-zip").extract, "function");
});
