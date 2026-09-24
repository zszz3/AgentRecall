import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Both source tests and installed-package tests must stay outside real user data.
export function isolatedEnvironment(testHome) {
  const temp = path.join(testHome, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    HOME: testHome, USERPROFILE: testHome, XDG_CONFIG_HOME: path.join(testHome, "config"),
    APPDATA: path.join(testHome, "appdata"), LOCALAPPDATA: path.join(testHome, "local"),
    AGENTRECALL_HOME: path.join(testHome, "config"), npm_config_prefix: path.join(testHome, "npm"),
    npm_config_cache: path.join(testHome, "npm-cache"), npm_config_userconfig: path.join(testHome, "npmrc"),
    TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
  });
  // Skip PATH wrappers that depend on the real HOME, without exposing that HOME to a test.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  const originalPath = env[pathKey] ?? "";
  for (const directory of originalPath.split(path.delimiter)) {
    if (!directory) continue;
    const executable = path.join(directory, process.platform === "win32" ? "git.exe" : "git");
    if (!fs.existsSync(executable)) continue;
    const candidate = { ...env, [pathKey]: `${directory}${path.delimiter}${originalPath}` };
    if (spawnSync(executable, ["--version"], { env: candidate, timeout: 10_000 }).status === 0) return candidate;
  }
  throw new Error("No Git installation works with an isolated HOME. Install Git before running CLI checks.");
}
