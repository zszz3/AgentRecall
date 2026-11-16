import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";
import { resolveNpmInvocation } from "./npm-command.mjs";

const appDirectory = process.argv[2];
const supportedDirectories = new Set(["apps/main-1.0", "apps/main-2.0"]);
const require = createRequire(import.meta.url);

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      env: options.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${options.label} stopped by ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`${options.label} exited with code ${code ?? 1}.`));
      } else {
        resolve();
      }
    });
  });
}

async function setupApplication() {
  const normalizedDirectory = path.normalize(appDirectory);
  const setupEnvironment = {
    ...process.env,
    AGENT_RECALL_SKIP_STATUSLINE_INSTALL: "1",
  };
  const npm = resolveNpmInvocation(["ci", "--prefix", normalizedDirectory], setupEnvironment);
  await runCommand(npm.command, npm.args, {
    label: "npm ci",
    windowsVerbatimArguments: npm.windowsVerbatimArguments,
    env: setupEnvironment,
  });

  if (appDirectory === "apps/main-2.0") {
    const dependencyTools = require(path.resolve(normalizedDirectory, "bin", "staged-package-dependencies.cjs"));
    await dependencyTools.restoreEmbeddedPostgresNativeLinks(path.resolve(normalizedDirectory, "node_modules"));
  }

  await ensureElectronRuntime(normalizedDirectory);

  const electronCli = path.join(normalizedDirectory, "node_modules", "electron", "cli.js");
  const electronArguments = process.platform === "linux"
    ? [electronCli, "--no-sandbox", "--version"]
    : [electronCli, "--version"];
  await runCommand(process.execPath, electronArguments, {
    label: "Electron runtime validation",
    shell: false,
    env: process.env,
  });
}

if (!supportedDirectories.has(appDirectory)) {
  process.stderr.write("Usage: node scripts/setup-app.mjs apps/main-1.0|apps/main-2.0\n");
  process.exitCode = 1;
} else {
  setupApplication().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
