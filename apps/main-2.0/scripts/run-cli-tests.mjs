#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Normalizes PATH (including Windows Path/PATH casing) and ensures `git` works
// with an isolated HOME even when the host has a $HOME-dependent git wrapper first in PATH.
export function ensureIsolatedGitPath(env, originalPath = process.env.PATH ?? "") {
  const normalized = { ...env };
  for (const key of Object.keys(normalized)) {
    if (key.toUpperCase() === "PATH") delete normalized[key];
  }
  normalized.PATH = originalPath;
  const probe = (file, candidate) => spawnSync(file, ["--version"], { env: candidate, timeout: 10_000, encoding: "utf8" });
  let attempted = probe("git", normalized);
  if (attempted.status === 0) return normalized;
  for (const directory of originalPath.split(path.delimiter)) {
    if (!directory) continue;
    const resolvedDirectory = directory.replace(/^"(.*)"$/, "$1");
    const executable = path.join(resolvedDirectory, process.platform === "win32" ? "git.exe" : "git");
    if (!fs.existsSync(executable)) continue;
    const candidate = { ...normalized, PATH: `${resolvedDirectory}${path.delimiter}${originalPath}` };
    attempted = probe(executable, candidate);
    if (attempted.status === 0) return candidate;
  }
  throw new Error(
    `Git cannot run in the isolated HOME (status ${attempted.status}): ${attempted.error?.message ?? attempted.stderr?.trim() ?? "unknown startup failure"}`,
  );
}

export function createIsolatedCliEnvironment(testHome, extraEnv = {}) {
  const home = path.join(testHome, "home");
  const temp = path.join(testHome, "tmp");
  const userData = path.join(testHome, "user-data");
  const gitConfig = path.join(testHome, "gitconfig");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  if (!fs.existsSync(gitConfig)) fs.writeFileSync(gitConfig, "", { flag: "wx" });

  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  delete env.AGENT_RECALL_MCP_BRIDGE;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    AGENTRECALL_HOME: path.join(home, ".agentrecall-cli"),
    AGENT_RECALL_HOME_DIR: home,
    AGENT_RECALL_USER_DATA_DIR: userData,
    AGENT_RECALL_TEST_HOME: home,
    AGENT_RECALL_NO_UPDATE_CHECK: "1",
    npm_config_prefix: path.join(testHome, "prefix"),
    npm_config_cache: path.join(testHome, "npm-cache"),
    npm_config_userconfig: path.join(testHome, "npmrc"),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    ...extraEnv,
  });
  return ensureIsolatedGitPath(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const testDir = path.join(appRoot, "tests", "cli");
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cli-tests-"));
  try {
    const env = createIsolatedCliEnvironment(testHome, {
      TSX_TSCONFIG_PATH: path.join(testDir, "tsconfig.json"),
    });
    const files = fs.readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => path.join(testDir, name));
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
      cwd: appRoot,
      env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(testHome, { recursive: true, force: true });
  }
}
