import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Both source tests and installed-package tests must stay outside real user data.
export function isolatedEnvironment(testHome) {
  const temp = path.join(testHome, "tmp");
  fs.mkdirSync(temp, { recursive: true });
  const gitConfig = path.join(testHome, "gitconfig");
  fs.writeFileSync(gitConfig, "", { flag: "wx" });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    HOME: testHome, USERPROFILE: testHome, XDG_CONFIG_HOME: path.join(testHome, "config"),
    APPDATA: path.join(testHome, "appdata"), LOCALAPPDATA: path.join(testHome, "local"),
    AGENTRECALL_HOME: path.join(testHome, "config"), npm_config_prefix: path.join(testHome, "npm"),
    npm_config_cache: path.join(testHome, "npm-cache"), npm_config_userconfig: path.join(testHome, "npmrc"),
    TMPDIR: temp, TMP: temp, TEMP: temp, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: gitConfig,
  });
  // npm can provide both Path and PATH on Windows. Node forwards only one spelling
  // to subprocesses, so normalize it before probing Git with the isolated HOME.
  const originalPath = process.env.PATH ?? "";
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.PATH = originalPath;
  const probe = (file, candidate) => spawnSync(file, ["--version"], { env: candidate, timeout: 10_000, encoding: "utf8" });
  let attempted = probe("git", env);
  if (attempted.status === 0) return env;
  // Skip PATH wrappers that depend on the real HOME, without exposing that HOME to a test.
  for (const directory of originalPath.split(path.delimiter)) {
    if (!directory) continue;
    const resolvedDirectory = directory.replace(/^"(.*)"$/, "$1");
    const executable = path.join(resolvedDirectory, process.platform === "win32" ? "git.exe" : "git");
    if (!fs.existsSync(executable)) continue;
    const candidate = { ...env, PATH: `${resolvedDirectory}${path.delimiter}${originalPath}` };
    attempted = probe(executable, candidate);
    if (attempted.status === 0) return candidate;
  }
  throw new Error(`Git cannot run in the isolated HOME (status ${attempted.status}): ${attempted.error?.message ?? attempted.stderr?.trim() ?? "unknown startup failure"}`);
}
