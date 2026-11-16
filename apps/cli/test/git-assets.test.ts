import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { GitAssetSource } from "@agentrecall/workspace-core";
import { execute, fixture } from "./fixtures.js";

async function createTeamAssetRemote(root: string) {
  const work = path.join(root, "work-assets");
  const bare = path.join(root, "remote-assets.git");
  await fs.mkdir(path.join(work, "skills", "review"), { recursive: true });
  await fs.writeFile(
    path.join(work, "agentrecall.json"),
    JSON.stringify({ schemaVersion: 1, skills: [{ id: "review", path: "skills/review" }] }),
  );
  await fs.writeFile(
    path.join(work, "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\nCheck diff.\n",
  );
  await execute("git", ["init", "-q", "-b", "main", work]);
  await execute("git", ["-C", work, "add", "."]);
  await execute("git", ["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial"]);
  await execute("git", ["clone", "--bare", "--quiet", work, bare]);
  return bare;
}

async function createFakeSsh(root: string, bareRemote: string) {
  const scriptPath = path.join(root, "fake-ssh.mjs");
  const logPath = path.join(root, "ssh-invocations.json");
  const script = [
    'import fs from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    `const logPath = ${JSON.stringify(logPath)};`,
    `const bareRemote = ${JSON.stringify(bareRemote)};`,
    'if (process.argv.includes("-G")) process.exit(0);',
    "const entries = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];",
    "entries.push({",
    "  argv: process.argv.slice(2),",
    "  env: {",
    "    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null,",
    "    GIT_SSH: process.env.GIT_SSH ?? null,",
    "    GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,",
    "    GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? null,",
    "    SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? null,",
    "  },",
    "});",
    "fs.writeFileSync(logPath, JSON.stringify(entries, null, 2));",
    "const result = spawnSync('git', ['upload-pack', bareRemote], { stdio: 'inherit', windowsHide: true });",
    "process.exit(result.status ?? 1);",
  ].join("\n");
  await fs.writeFile(scriptPath, script, "utf8");

  const wrapperPath = path.join(root, process.platform === "win32" ? "fake-ssh.cmd" : "fake-ssh.sh");
  const wrapperContent = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`;
  await fs.writeFile(wrapperPath, wrapperContent, { mode: 0o755 });
  return { scriptPath, wrapperPath, logPath };
}

function isolateEnv(t: TestContext, overrides: Record<string, string | undefined>) {
  const keys = new Set(["HOME", "USERPROFILE", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_TRACE", "PATH", ...Object.keys(overrides)]);
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("GitAssetSource honors git core.sshCommand without clobbering it with GIT_SSH_COMMAND", async (t) => {
  const { root } = await fixture(t);
  const bare = await createTeamAssetRemote(root);
  const { scriptPath, logPath } = await createFakeSsh(root, bare);
  const gitConfig = path.join(root, "gitconfig");
  const sshCommand = `"${process.execPath.replace(/\\/g, "/")}" "${scriptPath.replace(/\\/g, "/")}"`;
  await fs.writeFile(gitConfig, `[core]\n\tsshCommand = ${sshCommand}\n`, "utf8");

  isolateEnv(t, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH: undefined,
  });

  const scratch = path.join(root, "scratch-core");
  await fs.mkdir(scratch, { recursive: true });
  const snapshot = await new GitAssetSource().load("git@github.com:acme/assets.git", scratch, "ssh");
  assert.equal(snapshot.skills.length, 1);
  assert.equal(snapshot.skills[0]?.id, "review");

  const calls = JSON.parse(await fs.readFile(logPath, "utf8")) as Array<{
    argv: string[];
    env: Record<string, string | null>;
  }>;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.env.GIT_SSH_COMMAND, null);
  assert.equal(calls[0]!.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[0]!.env.GCM_INTERACTIVE, "never");
  assert.equal(calls[0]!.env.SSH_ASKPASS_REQUIRE, "never");
});

test("GitAssetSource honors GIT_SSH and explicit GIT_SSH_COMMAND while keeping non-interactive env vars", async (t) => {
  const { root } = await fixture(t);
  const bare = await createTeamAssetRemote(root);
  const { scriptPath, wrapperPath, logPath } = await createFakeSsh(root, bare);
  const emptyConfig = path.join(root, "empty-gitconfig");
  await fs.writeFile(emptyConfig, "", "utf8");

  isolateEnv(t, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH: wrapperPath,
  });

  const scratchEnvSsh = path.join(root, "scratch-git-ssh");
  await fs.mkdir(scratchEnvSsh, { recursive: true });
  const snapshotFromGitSsh = await new GitAssetSource().load("git@github.com:acme/assets.git", scratchEnvSsh, "ssh");
  assert.equal(snapshotFromGitSsh.skills[0]?.id, "review");

  const configuredConfig = path.join(root, "configured-gitconfig");
  await fs.writeFile(configuredConfig, "[core]\n\tsshCommand = should-be-overridden\n", "utf8");
  process.env.GIT_CONFIG_GLOBAL = configuredConfig;
  delete process.env.GIT_SSH;
  process.env.GIT_SSH_COMMAND = `"${process.execPath.replace(/\\/g, "/")}" "${scriptPath.replace(/\\/g, "/")}"`;

  const scratchExplicit = path.join(root, "scratch-explicit-cmd");
  await fs.mkdir(scratchExplicit, { recursive: true });
  const snapshotFromCmd = await new GitAssetSource().load("git@github.com:acme/assets.git", scratchExplicit, "ssh");
  assert.equal(snapshotFromCmd.skills[0]?.id, "review");

  const calls = JSON.parse(await fs.readFile(logPath, "utf8")) as Array<{
    env: Record<string, string | null>;
  }>;
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.env.GIT_SSH_COMMAND, null);
  assert.equal(calls[0]!.env.GIT_SSH, wrapperPath);
  assert.equal(calls[0]!.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[0]!.env.GCM_INTERACTIVE, "never");
  assert.equal(calls[0]!.env.SSH_ASKPASS_REQUIRE, "never");
  assert.equal(calls[1]!.env.GIT_SSH_COMMAND, process.env.GIT_SSH_COMMAND);
  assert.equal(calls[1]!.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(calls[1]!.env.GCM_INTERACTIVE, "never");
  assert.equal(calls[1]!.env.SSH_ASKPASS_REQUIRE, "never");
});

test("GitAssetSource falls back to ssh -oBatchMode=yes when no SSH command is configured", async (t) => {
  const { root } = await fixture(t);
  const emptyConfig = path.join(root, "empty-gitconfig");
  await fs.writeFile(emptyConfig, "", "utf8");
  const isolatedHome = path.join(root, "isolated-ssh-home");
  const sshDir = path.join(isolatedHome, ".ssh");
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  const fakeBin = path.join(root, "fake-ssh-bin");
  await fs.mkdir(fakeBin, { recursive: true });
  const envLog = path.join(root, "ssh-fallback-env.json");
  const traceFile = path.join(root, "git-trace.log");
  const proxyScript = path.join(root, "proxy-probe.mjs");
  await fs.writeFile(
    proxyScript,
    [
      'import fs from "node:fs";',
      `fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({`,
      "  argv: process.argv.slice(2),",
      "  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null,",
      "  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? null,",
      "  GCM_INTERACTIVE: process.env.GCM_INTERACTIVE ?? null,",
      "  SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE ?? null,",
      "}));",
      "process.exit(1);",
    ].join("\n"),
    "utf8",
  );
  // Intercept ssh via PATH on POSIX (where OpenSSH ignores $HOME via getpwuid) and via .ssh/config on Windows.
  await fs.writeFile(
    path.join(fakeBin, "ssh"),
    `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, "/")}" "${proxyScript.replace(/\\/g, "/")}" "$@"\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  await fs.writeFile(
    path.join(fakeBin, "ssh.cmd"),
    `@echo off\r\n"${process.execPath}" "${proxyScript}" %*\r\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(sshDir, "config"),
    `Host *\n  ProxyCommand "${process.execPath.replace(/\\/g, "/")}" "${proxyScript.replace(/\\/g, "/")}"\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  isolateEnv(t, {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH: undefined,
    GIT_TRACE: traceFile,
  });

  const scratch = path.join(root, "scratch-fallback");
  await fs.mkdir(scratch, { recursive: true });
  await assert.rejects(
    new GitAssetSource().load("git@github.com:acme/assets.git", scratch, "ssh"),
    { code: "ASSET_GIT_FAILED" },
  );

  const trace = await fs.readFile(traceFile, "utf8");
  assert.match(trace, /ssh -oBatchMode=yes/);
  const recorded = JSON.parse(await fs.readFile(envLog, "utf8")) as Record<string, unknown>;
  assert.equal(recorded.GIT_SSH_COMMAND, "ssh -oBatchMode=yes");
  assert.equal(recorded.GIT_TERMINAL_PROMPT, "0");
  assert.equal(recorded.GCM_INTERACTIVE, "never");
  assert.equal(recorded.SSH_ASKPASS_REQUIRE, "never");
});
