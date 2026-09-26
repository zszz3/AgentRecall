import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const require = createRequire(import.meta.url);
const { BUNDLE_IDENTIFIER, findInstalledMacosApp, installMacosApp, readInstalledMacosAppVersion, uninstallMacosApp } = require("../bin/install-macos-app.cjs");
const temporaryDirectories = new Set();

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(dir);
  return dir;
}

async function makeFakePackage(directoryName = "") {
  const packagePath = path.join(await makeTempDir("agent-recall-app-pkg-"), directoryName);
  fs.mkdirSync(path.join(packagePath, "bin"), { recursive: true });
  fs.mkdirSync(path.join(packagePath, "assets"), { recursive: true });
  fs.writeFileSync(path.join(packagePath, "package.json"), JSON.stringify({ name: "agent-recall-v2", version: "1.2.3" }));
  fs.writeFileSync(path.join(packagePath, "bin", "agent-recall.cjs"), "// fake cli\n");
  fs.writeFileSync(path.join(packagePath, "assets", "app-icon.png"), "fake-png");
  return packagePath;
}

const fakeBuildIcns = (sourceIconPath, workDir) => {
  const icnsPath = path.join(workDir, "AppIcon.icns");
  fs.writeFileSync(icnsPath, "fake-icns");
  return icnsPath;
};

test("installMacosApp creates a launchable wrapper bundle", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [appsDir],
    buildIcns: fakeBuildIcns,
  });

  assert.equal(result.status, "installed");
  assert.deepEqual(result.warnings, []);
  const appPath = path.join(appsDir, "agent-recall-v2.app");
  assert.equal(result.appPath, appPath);
  const plist = fs.readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
  assert.match(plist, new RegExp(BUNDLE_IDENTIFIER));
  assert.match(plist, /<string>1\.2\.3<\/string>/);
  const launcherPath = path.join(appPath, "Contents", "MacOS", "AgentRecall");
  const launcher = fs.readFileSync(launcherPath, "utf8");
  assert.match(launcher, /command -v agent-recall-v2/);
  assert.match(launcher, /exec "\$\{resolved\}"/);
  assert.match(launcher, /exec \/bin\/zsh -lc/);
  assert.match(launcher, /agent-recall-launcher "\/fake\/node" ".*agent-recall\.cjs"/);
  // The login-shell resolution must win over the baked absolute paths.
  assert.ok(launcher.indexOf(`command -v agent-recall-v2`) < launcher.indexOf('exec "$1" "$2"'));
  assert.equal(readInstalledMacosAppVersion(appPath), "1.2.3");
  if (process.platform !== "win32") {
    // Windows has no Unix execute bits; chmod is a no-op there.
    assert.equal(fs.statSync(launcherPath).mode & 0o111, 0o111);
  }
  assert.equal(fs.readFileSync(path.join(appPath, "Contents", "Resources", "AppIcon.icns"), "utf8"), "fake-icns");
});

test("installMacosApp is idempotent and refuses foreign bundles", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const options = { platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns };
  assert.equal(installMacosApp(options).status, "installed");
  assert.equal(installMacosApp(options).status, "installed");

  const foreignDir = await makeTempDir("agent-recall-apps-foreign-");
  const foreignApp = path.join(foreignDir, "agent-recall-v2.app", "Contents");
  fs.mkdirSync(foreignApp, { recursive: true });
  fs.writeFileSync(path.join(foreignApp, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.someone-else.app</string>");
  const refused = installMacosApp({ ...options, applicationsDirs: [foreignDir] });
  assert.equal(refused.status, "error");
  assert.match(refused.detail, /not created by AgentRecall/);
  assert.equal(fs.existsSync(path.join(foreignApp, "Info.plist")), true);
});

test("installMacosApp falls back to the next writable directory", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const missingDir = path.join(appsDir, "does-not-exist");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [missingDir, appsDir],
    buildIcns: fakeBuildIcns,
  });
  assert.equal(result.status, "installed");
  assert.equal(result.appPath, path.join(appsDir, "agent-recall-v2.app"));
});

test("installMacosApp degrades to an icon-less bundle when icns generation fails", async () => {
  const packagePath = await makeFakePackage();
  const appsDir = await makeTempDir("agent-recall-apps-");
  const result = installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: "/fake/node",
    applicationsDirs: [appsDir],
    buildIcns: () => null,
  });
  assert.equal(result.status, "installed");
  assert.equal(result.warnings.length, 1);
  assert.equal(fs.existsSync(path.join(appsDir, "agent-recall-v2.app", "Contents", "Resources", "AppIcon.icns")), false);
});

test("installMacosApp reports unsupported on non-macOS platforms", async () => {
  const packagePath = await makeFakePackage();
  assert.equal(installMacosApp({ platform: "win32", packagePath }).status, "unsupported");
});

test("findInstalledMacosApp and uninstallMacosApp only touch our bundle", async () => {
  const packagePath = await makeFakePackage();
  const homeDir = await makeTempDir("agent-recall-app-home-");
  const appsDir = path.join(homeDir, "Applications");
  fs.mkdirSync(appsDir, { recursive: true });
  assert.equal(findInstalledMacosApp({ homeDir }), null);

  installMacosApp({ platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns });
  assert.equal(findInstalledMacosApp({ homeDir }), path.join(appsDir, "agent-recall-v2.app"));

  const removed = uninstallMacosApp({ homeDir });
  assert.equal(removed.status, "removed");
  assert.equal(fs.existsSync(path.join(appsDir, "agent-recall-v2.app")), false);
  assert.equal(uninstallMacosApp({ homeDir }).status, "absent");

  const foreignApp = path.join(appsDir, "agent-recall-v2.app", "Contents");
  fs.mkdirSync(foreignApp, { recursive: true });
  fs.writeFileSync(path.join(foreignApp, "Info.plist"), "<key>CFBundleIdentifier</key><string>com.someone-else.app</string>");
  assert.equal(uninstallMacosApp({ homeDir }).status, "absent");
  assert.equal(fs.existsSync(path.join(foreignApp, "Info.plist")), true);
});

test("uninstallMacosApp keeps bundles owned by another install", async () => {
  const packagePath = await makeFakePackage();
  const otherPackagePath = await makeFakePackage();
  const homeDir = await makeTempDir("agent-recall-app-owned-");
  const appsDir = path.join(homeDir, "Applications");
  fs.mkdirSync(appsDir, { recursive: true });
  const options = { platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns };
  assert.equal(installMacosApp(options).status, "installed");
  const appPath = path.join(appsDir, "agent-recall-v2.app");

  const kept = uninstallMacosApp({ homeDir, packagePath: otherPackagePath });
  assert.equal(kept.status, "kept");
  assert.equal(fs.existsSync(appPath), true);

  const removed = uninstallMacosApp({ homeDir, packagePath });
  assert.equal(removed.status, "removed");
  assert.equal(fs.existsSync(appPath), false);

  // Without package context the historical remove behavior is preserved.
  assert.equal(installMacosApp(options).status, "installed");
  assert.equal(uninstallMacosApp({ homeDir }).status, "removed");
});

for (const directoryName of ["package with spaces $`", ...(process.platform === "win32" ? [] : ['package"\\'])]) {
  for (const legacy of [false, true]) {
    test(`uninstallMacosApp recognizes ${legacy ? "legacy" : "escaped"} paths: ${JSON.stringify(directoryName)}`, async () => {
      const packagePath = await makeFakePackage(directoryName);
      const appsDir = await makeTempDir("agent-recall-app-owned-");
      const installed = installMacosApp({
        platform: "darwin", packagePath, nodePath: "/fake/node", applicationsDirs: [appsDir], buildIcns: fakeBuildIcns,
      });
      assert.equal(installed.status, "installed");
      if (legacy) {
        // Older bundles embedded the CLI path directly in the fallback body.
        const cliPath = path.join(packagePath, "bin", "agent-recall.cjs");
        fs.writeFileSync(path.join(installed.appPath, "Contents", "MacOS", "AgentRecall"),
          `#!/bin/zsh\nif [ -x "/fake/node" ] && [ -f "${cliPath}" ]; then\n  exec "/fake/node" "${cliPath}"\nfi\n`);
      }
      // On POSIX these are distinct install paths whose raw and shell-escaped
      // spellings can collide. Never match both spellings indiscriminately.
      const otherPackagePath = process.platform === "win32"
        ? `${packagePath}-other`
        : packagePath.replace(/[\\"$`]/g, "\\$&");
      assert.equal(uninstallMacosApp({ applicationsDirs: [appsDir], packagePath: otherPackagePath }).status, "kept");
      assert.equal(fs.existsSync(installed.appPath), true);
      assert.equal(uninstallMacosApp({ applicationsDirs: [appsDir], packagePath }).status, "removed");
      assert.equal(fs.existsSync(installed.appPath), false);
    });
  }
}

test("launcher prefers the current install over stale baked paths", { skip: process.platform !== "darwin" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const packagePath = await makeFakePackage();
  // The baked CLI stands in for the older install that generated the launcher.
  fs.writeFileSync(path.join(packagePath, "bin", "agent-recall.cjs"), 'console.log("stale-install");\n');
  const homeDir = await makeTempDir("agent-recall-launch-home-");
  const appsDir = path.join(homeDir, "Applications");
  fs.mkdirSync(appsDir, { recursive: true });
  assert.equal(installMacosApp({
    platform: "darwin",
    packagePath,
    nodePath: process.execPath,
    applicationsDirs: [appsDir],
    buildIcns: fakeBuildIcns,
  }).status, "installed");
  const launcherPath = path.join(appsDir, "agent-recall-v2.app", "Contents", "MacOS", "AgentRecall");

  // A current install visible on the login-shell PATH must win over the
  // baked absolute paths of the older install (#499 version drift).
  const binDir = path.join(homeDir, "node version with spaces", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const currentCli = path.join(binDir, "agent-recall-v2");
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  fs.writeFileSync(currentCli, '#!/usr/bin/env node\nconsole.log("current-install", JSON.stringify(process.argv.slice(2)));\n');
  fs.chmodSync(currentCli, 0o755);
  fs.writeFileSync(path.join(homeDir, ".zprofile"), `export PATH="${binDir}:/usr/bin:/bin"\n`);
  const env = { HOME: homeDir, ZDOTDIR: homeDir, PATH: "/usr/bin:/bin" };
  // The old launcher resolves the CLI in a child shell, then loses its Node PATH.
  const oldLauncher = spawnSync("/bin/zsh", ["-c", `resolved=$(/bin/zsh -lc 'command -v agent-recall-v2'); exec "$resolved"`], {
    encoding: "utf8", env,
  });
  assert.equal(oldLauncher.status, 127);
  assert.match(oldLauncher.stderr, /node: No such file or directory/);
  const viaPath = spawnSync(launcherPath, ["argument with spaces"], { encoding: "utf8", env });
  assert.equal(viaPath.status, 0, viaPath.stderr);
  assert.match(viaPath.stdout, /current-install/);
  assert.match(viaPath.stdout, /\["argument with spaces"\]/);

  // When the login shell cannot resolve the command, the baked absolute
  // paths still launch the app instead of failing.
  const bareHome = await makeTempDir("agent-recall-launch-bare-");
  fs.writeFileSync(path.join(bareHome, ".zprofile"), 'export PATH="/usr/bin:/bin"\n');
  const bareEnv = { HOME: bareHome, ZDOTDIR: bareHome, PATH: "/usr/bin:/bin" };
  const viaBaked = spawnSync(launcherPath, { encoding: "utf8", env: bareEnv });
  assert.equal(viaBaked.status, 0, viaBaked.stderr);
  assert.match(viaBaked.stdout, /stale-install/);
  fs.unlinkSync(path.join(packagePath, "bin", "agent-recall.cjs"));
  const missing = spawnSync(launcherPath, { encoding: "utf8", env: bareEnv });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /未找到 agent-recall-v2/);
});

test("launcher uses its baked install when the Node manager is configured only in .zshrc", { skip: process.platform !== "darwin" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const homeDir = await makeTempDir("agent-recall-launch-zshrc-");
  const binDir = path.join(homeDir, "node manager", "bin");
  const appsDir = path.join(homeDir, "Applications");
  const packagePath = await makeFakePackage('package with spaces $`"\\');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(appsDir);
  const nodePath = path.join(binDir, "node");
  const cliPath = path.join(binDir, "agent-recall-v2");
  fs.symlinkSync(process.execPath, nodePath);
  fs.writeFileSync(path.join(packagePath, "bin", "agent-recall.cjs"),
    'console.log("baked-install", JSON.stringify(process.argv.slice(2)), process.env.SYNTHETIC_NODE_MANAGER_LOADED || "noninteractive");\n');
  fs.writeFileSync(cliPath, '#!/usr/bin/env node\nconsole.log("shell-visible-install");\n');
  fs.chmodSync(cliPath, 0o755);
  // Prevent host-wide login paths from supplying Node; only the fixture's
  // interactive configuration exposes this synthetic manager installation.
  fs.writeFileSync(path.join(homeDir, ".zprofile"), 'export PATH="/usr/bin:/bin"\n');
  fs.writeFileSync(path.join(homeDir, ".zshrc"),
    `export PATH="${binDir}:/usr/bin:/bin"\nexport SYNTHETIC_NODE_MANAGER_LOADED=1\n`);
  const env = { HOME: homeDir, ZDOTDIR: homeDir, PATH: "/usr/bin:/bin" };
  const login = spawnSync("/bin/zsh", ["-lc", "command -v node; command -v agent-recall-v2"], { encoding: "utf8", env });
  assert.equal(login.status, 1);
  assert.equal(login.stdout, "");
  const interactive = spawnSync("/bin/zsh", ["-ic", "command -v node; command -v agent-recall-v2"], { encoding: "utf8", env });
  assert.equal(interactive.status, 0, interactive.stderr);
  assert.equal(interactive.stdout, `${nodePath}\n${cliPath}\n`);
  assert.equal(installMacosApp({
    platform: "darwin", packagePath, nodePath, applicationsDirs: [appsDir], buildIcns: fakeBuildIcns,
  }).status, "installed");
  const launcherPath = path.join(appsDir, "agent-recall-v2.app", "Contents", "MacOS", "AgentRecall");
  const launched = spawnSync(launcherPath, ["argument with spaces"], { encoding: "utf8", env });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, 'baked-install ["argument with spaces"] noninteractive\n');
});
