import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { packReleaseArchive } from "./pack-release.mjs";

const execFile = promisify(execFileCallback);
const temporaryDirectories = new Set();

async function temporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

after(async () => {
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
});

test("packs a staging-only legacy Electron bridge and restores the source dependency", async () => {
  const root = await temporaryDirectory("agent-recall-pack-release-");
  const destination = path.join(root, "archives");
  const installRoot = path.join(root, "installed");
  const electronRoot = path.join(root, "node_modules", "electron");
  const bridgeDependencyRoot = path.join(root, "node_modules", "bridge-dependency");
  const installSource = [
    "#!/usr/bin/env node",
    "const childProcess = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const { version } = require('./package');",
    "const platformPath = path.basename(process.execPath);",
    "Promise.resolve()",
    "  .then(extractFile)",
    "  .catch((error) => { console.error(error); process.exitCode = 1; });",
    "function extractFile() {",
    "  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });",
    "  fs.writeFileSync(path.join(__dirname, 'dist', 'version'), version);",
    "}",
  ].join("\n");
  await mkdir(electronRoot, { recursive: true });
  await mkdir(bridgeDependencyRoot, { recursive: true });
  await writeFile(path.join(root, "index.js"), "module.exports = true;\n", "utf8");
  const rootPackage = {
    name: "agent-recall-pack-fixture",
    version: "1.0.0",
    files: ["index.js"],
    dependencies: { electron: "42.3.0" },
    bundleDependencies: ["electron"],
    scripts: {
      prepare: "node scripts/source-only-build.mjs",
      postinstall: "node index.js",
    },
  };
  await writeFile(path.join(root, "package.json"), `${JSON.stringify(rootPackage, null, 2)}\n`, "utf8");
  await writeFile(path.join(electronRoot, "package.json"), `${JSON.stringify({
    name: "electron",
    version: "42.3.0",
    files: ["install.js"],
    dependencies: { "bridge-dependency": "1.0.0" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(electronRoot, "install.js"), installSource, "utf8");
  await writeFile(path.join(bridgeDependencyRoot, "package.json"), `${JSON.stringify({
    name: "bridge-dependency",
    version: "1.0.0",
    main: "index.js",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(bridgeDependencyRoot, "index.js"), "module.exports = true;\n", "utf8");
  const environment = {
    ...process.env,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_prefix: path.join(root, "npm-prefix"),
  };
  await Promise.all([
    environment.HOME,
    environment.npm_config_cache,
    environment.npm_config_prefix,
  ].map((directory) => mkdir(directory, { recursive: true })));

  const archive = await packReleaseArchive({ root, destination, environment });

  assert.equal(await readFile(path.join(electronRoot, "install.js"), "utf8"), installSource);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")), rootPackage);
  assert.equal(JSON.parse(await readFile(path.join(electronRoot, "package.json"), "utf8")).version, "42.3.0");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFile(npmCommand, [
    "install",
    "--prefix",
    installRoot,
    archive,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], {
    shell: process.platform === "win32",
    env: environment,
  });
  const packedElectronRoot = path.join(installRoot, "node_modules", "agent-recall-pack-fixture", "node_modules", "electron");
  const packedInstallPath = path.join(packedElectronRoot, "install.js");
  const packedInstallSource = await readFile(packedInstallPath, "utf8");
  const packedRootPackage = JSON.parse(await readFile(
    path.join(installRoot, "node_modules", "agent-recall-pack-fixture", "package.json"),
    "utf8",
  ));
  const packedElectronPackage = JSON.parse(await readFile(path.join(packedElectronRoot, "package.json"), "utf8"));
  const marker = JSON.parse(await readFile(path.join(packedElectronRoot, ".agent-recall-staging-bridge.json"), "utf8"));
  assert.equal(
    JSON.parse(await readFile(path.join(packedElectronRoot, "node_modules", "bridge-dependency", "package.json"), "utf8")).version,
    "1.0.0",
  );
  assert.equal(packedRootPackage.dependencies.electron, "24.15.0");
  assert.deepEqual(packedRootPackage.scripts, { postinstall: "node index.js" });
  assert.equal(packedElectronPackage.version, "24.15.0");
  assert.deepEqual(marker, {
    schemaVersion: 1,
    electronVersion: "42.3.0",
    bridgedVersion: "24.15.0",
  });
  assert.match(packedInstallSource, /AGENT_RECALL_STAGING_INSTALL/);
  assert.match(packedInstallSource, /AGENT_RECALL_SKIP_LEGACY_ELECTRON_BRIDGE/);
  assert.match(packedInstallSource, /\.agent-recall-staging-bridge\.json/);
  assert.match(packedInstallSource, /\.then\(applyAgentRecallStagingBridge\)/);
  assert.match(packedInstallSource, /execFileSync\(electronExecutable, \['--version'\]/);
  assert.match(packedInstallSource, /const version = '42\.3\.0'/);
  assert.match(packedInstallSource, /const bridgedVersion = '24\.15\.0'/);
});
