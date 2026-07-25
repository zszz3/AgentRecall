import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: node scripts/native-package-smoke.mjs\n" +
      "Builds and verifies an unsigned unpacked native app using isolated HOME and npm prefix.\n",
  );
  process.exit(0);
}
if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error("Native package smoke tests must run on macOS or Windows.");
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-recall-native-package-"));
const home = path.join(tempRoot, "home");
const prefix = path.join(tempRoot, "npm-prefix");
const cache = path.join(tempRoot, "npm-cache");
const packDirectory = path.join(tempRoot, "npm-pack");
const nativeOutput = path.join(tempRoot, "native-output");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  npm_config_prefix: prefix,
  npm_config_cache: cache,
  AGENT_RECALL_TEST_HOME: home,
  AGENT_RECALL_NO_UPDATE_CHECK: "1",
  AGENT_RECALL_NOTARIZE: "false",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
};
delete environment.CSC_LINK;
delete environment.CSC_KEY_PASSWORD;
delete environment.APPLE_ID;
delete environment.APPLE_APP_SPECIFIC_PASSWORD;
delete environment.APPLE_TEAM_ID;

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: root,
    env: environment,
    shell: process.platform === "win32",
    timeout: 15 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

async function findFile(directory, basename) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, basename);
      if (nested) return nested;
    } else if (entry.name === basename) {
      return candidate;
    }
  }
  return null;
}

try {
  await Promise.all(
    [home, prefix, cache, packDirectory, nativeOutput].map((directory) =>
      mkdir(directory, { recursive: true })),
  );

  await run(npm, ["run", "build"]);

  const { stdout } = await run(npm, [
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDirectory,
  ]);
  const result = JSON.parse(stdout.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/)?.[1] ?? "[]");
  if (!result[0]?.filename) throw new Error("npm pack did not return an archive.");
  const archive = path.join(packDirectory, result[0].filename);
  await run(npm, [
    "install",
    "--global",
    archive,
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);

  const packageRoots = process.platform === "win32"
    ? [path.join(prefix, "node_modules", "agent-recall")]
    : [
        path.join(prefix, "lib", "node_modules", "agent-recall"),
        path.join(prefix, "node_modules", "agent-recall"),
      ];
  let installedRoot = null;
  for (const candidate of packageRoots) {
    try {
      await access(path.join(candidate, "package.json"));
      installedRoot = candidate;
      break;
    } catch {
      // Try the other supported npm prefix layout.
    }
  }
  if (!installedRoot) throw new Error("The npm fallback was not installed into the temporary prefix.");
  const packageVersion = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")).version;
  const cli = path.join(installedRoot, "bin", "agent-recall.cjs");
  const { stdout: versionOutput } = await execFileAsync(process.execPath, [cli, "--version"], {
    env: environment,
  });
  if (versionOutput.trim() !== packageVersion) {
    throw new Error(`Temporary npm fallback reported ${versionOutput.trim()} instead of ${packageVersion}.`);
  }

  await run(process.execPath, [path.join(root, "scripts", "prepare-native-app.mjs")]);
  const platformArguments = process.platform === "darwin"
    ? ["--mac", `--${process.arch === "arm64" ? "arm64" : "x64"}`]
    : ["--win", "--x64"];
  await run(npx, [
    "--no-install",
    "electron-builder",
    "--config",
    "electron-builder.yml",
    "--dir",
    "--publish",
    "never",
    `--config.directories.output=${nativeOutput}`,
    ...platformArguments,
  ]);

  if (!await findFile(nativeOutput, "app.asar")) {
    throw new Error("The unpacked native application does not contain resources/app.asar.");
  }
  const stagedPackage = JSON.parse(
    await readFile(path.join(root, "dist", "native-app", "package.json"), "utf8"),
  );
  if (stagedPackage.dependencies?.["electron-updater"] === undefined) {
    throw new Error("The native application staging manifest is missing electron-updater.");
  }
  if (stagedPackage.dependencies?.electron !== undefined) {
    throw new Error("The native application staging manifest must not package Electron as an app dependency.");
  }
  process.stdout.write(
    `Unsigned native package smoke test passed for AgentRecall v${packageVersion} (${process.platform}/${process.arch}).\n`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
