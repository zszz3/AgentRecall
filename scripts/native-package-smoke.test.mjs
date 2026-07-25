import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("native packaging declares all 1.0 targets and keeps install side-effect free", async () => {
  const [packageJson, builderConfig, installerInclude, stagingSource] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "electron-builder.yml"), "utf8"),
    readFile(path.join(root, "build", "installer.nsh"), "utf8"),
    readFile(path.join(root, "scripts", "prepare-native-app.mjs"), "utf8"),
  ]);

  assert.equal(packageJson.scripts.postinstall, undefined);
  assert.equal(packageJson.dependencies["electron-updater"] !== undefined, true);
  assert.equal(packageJson.devDependencies["electron-builder"] !== undefined, true);
  assert.match(builderConfig, /target: dmg[\s\S]*arm64[\s\S]*x64/);
  assert.match(builderConfig, /target: zip[\s\S]*arm64[\s\S]*x64/);
  assert.match(builderConfig, /target: nsis[\s\S]*x64/);
  assert.match(builderConfig, /app: dist\/native-app/);
  assert.match(builderConfig, /deleteAppDataOnUninstall: false/);
  assert.match(installerInclude, /MB_DEFBUTTON2/);
  assert.match(installerInclude, /IDNO keep_agent_recall_data/);
  assert.match(stagingSource, /electron: _electron/);
  assert.match(packageJson.scripts["package:native:dir"], /prepare-native-app\.mjs/);
});

test("native package smoke help performs no build or installation", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, "scripts", "native-package-smoke.mjs"),
    "--help",
  ], {
    env: {
      ...process.env,
      HOME: path.join(root, ".synthetic-home-not-created"),
      USERPROFILE: path.join(root, ".synthetic-home-not-created"),
      npm_config_prefix: path.join(root, ".synthetic-prefix-not-created"),
    },
  });
  assert.match(stdout, /isolated HOME and npm prefix/);
});

test("npm fallback smoke isolates HOME, prefix, and cache", async () => {
  const source = await readFile(path.join(root, "scripts", "package-smoke.mjs"), "utf8");
  assert.match(source, /HOME: home/);
  assert.match(source, /USERPROFILE: home/);
  assert.match(source, /npm_config_prefix: prefix/);
  assert.match(source, /npm_config_cache: cache/);
});
