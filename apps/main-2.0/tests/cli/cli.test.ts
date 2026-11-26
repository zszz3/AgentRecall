import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { cli, fixture, launcherCli, repository } from "./fixtures.js";

test("CLI initializes without the desktop, persists bindings and gates the active team", async (t) => {
  const { root, home } = await fixture(t);
  assert.equal((await cli(home, root, ["status"])).result.ok, true);
  const preInitDoctor = await cli(home, root, ["doctor"]);
  assert.equal(preInitDoctor.code, 0, preInitDoctor.stdout);
  const preInitData = preInitDoctor.result.data as {
    initialized: boolean;
    healthy: boolean;
    checks: Array<{ name: string; status: string }>;
  };
  assert.equal(preInitData.initialized, false);
  assert.equal(preInitData.healthy, true);
  assert.ok(preInitData.checks.some((item) => item.name === "node" && item.status === "ok"));
  assert.ok(preInitData.checks.some((item) => item.name === "git" && item.status === "ok"));
  assert.ok(preInitData.checks.some((item) => item.name === "config" && item.status === "info"));

  const repo = await repository(path.join(root, "业务项目"), "git@github.com:acme/app.git");
  for (const args of [
    ["init"], ["team", "add", "acme", "--repo", "https://github.com/acme/assets", "--name", "研发"],
    ["team", "use", "acme"], ["project", "add", "app", "--path", repo],
  ]) {
    const result = await cli(home, root, args);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.stderr, "");
  }
  assert.equal((await cli(home, repo, ["team", "current"])).result.error?.code, "TEAM_DISABLED");
  assert.equal((await cli(home, root, ["team", "enable"])).code, 0);
  assert.equal((await cli(home, repo, ["team", "current"])).code, 0);
  const postInitDoctor = await cli(home, repo, ["doctor"]);
  assert.equal(postInitDoctor.code, 0, postInitDoctor.stdout);
  assert.equal((postInitDoctor.result.data as { project?: { id?: string } }).project?.id, "app");

  assert.equal((await cli(home, root, ["project", "bind", "app", "--personal"])).code, 0);
  assert.equal((await cli(home, repo, ["team", "current"])).result.error?.code, "NO_TEAM");
  assert.equal((await cli(home, root, ["team", "disable"])).code, 0);
  assert.equal((await cli(home, root, ["team", "list"])).code, 0);
  assert.equal((await cli(home, root, ["project", "list"])).code, 0);
  assert.equal((await cli(home, root, ["project", "remove", "app"])).code, 0);
  assert.equal((await cli(home, root, ["project", "remove", "app"])).result.error?.code, "PROJECT_NOT_FOUND");
});

test("directory add defaults to both targets and supports comma-separated targets", async (t) => {
  const { root, home } = await fixture(t);
  const workDirA = path.join(root, "work-a");
  const workDirB = path.join(root, "work-b");
  await fs.mkdir(workDirA, { recursive: true });
  await fs.mkdir(workDirB, { recursive: true });

  assert.equal((await cli(home, root, ["init"])).code, 0);
  assert.equal((await cli(home, root, ["team", "add", "acme", "--repo", "https://github.com/acme/assets"])).code, 0);
  const addedDefault = await cli(home, root, ["directory", "add", workDirA, "--team", "acme"]);
  assert.equal(addedDefault.code, 0, addedDefault.stdout);
  assert.deepEqual((addedDefault.result.data as { targets: string[] }).targets, ["codex", "claude"]);

  const addedExplicit = await cli(home, root, ["directory", "add", workDirB, "--team", "acme", "--target", "claude,codex"]);
  assert.equal(addedExplicit.code, 0, addedExplicit.stdout);
  assert.deepEqual((addedExplicit.result.data as { targets: string[] }).targets, ["claude", "codex"]);

  const badTarget = await cli(home, root, ["directory", "add", workDirB, "--team", "acme", "--target", "unknown"]);
  assert.equal(badTarget.code, 2);
  assert.equal(badTarget.result.error?.code, "INVALID_ARGUMENTS");
});

test("unified agent-recall entrypoint handles help, version, and rejects unknown commands without launching Electron", async (t) => {
  const { root, home } = await fixture(t);
  const helpResult = await launcherCli(home, root, ["--help"]);
  assert.equal(helpResult.code, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /agent-recall/);
  assert.match(helpResult.stdout, /agentrecall/);

  const versionResult = await launcherCli(home, root, ["--version"]);
  assert.equal(versionResult.code, 0, versionResult.stderr);
  assert.match(versionResult.stdout.trim(), /^\d+\.\d+\.\d+/);

  const versionJson = await launcherCli(home, root, ["--version", "--json"]);
  assert.equal(versionJson.code, 0, versionJson.stderr);
  assert.equal(JSON.parse(versionJson.stdout).ok, true);

  const unknownText = await launcherCli(home, root, ["not-a-real-command"]);
  assert.equal(unknownText.code, 2);
  assert.match(unknownText.stderr, /agent-recall --help/);

  const unknownJson = await launcherCli(home, root, ["--typo-flag", "--json"]);
  assert.equal(unknownJson.code, 2);
  assert.equal(JSON.parse(unknownJson.stdout).error.code, "INVALID_ARGUMENTS");

  const backendStatus = await launcherCli(home, root, ["backend", "status", "--json"], {
    AGENT_RECALL_USER_DATA_DIR: path.join(root, "user-data"),
  });
  assert.equal(backendStatus.code, 0, backendStatus.stderr);
  assert.deepEqual(JSON.parse(backendStatus.stdout), { ok: true, data: { running: false } });
});

test("rejects unknown commands, conflicting flags and missing arguments before changing configuration", async (t) => {
  const { root, home, service } = await fixture(t);
  await service.store.initialize();
  const before = await service.store.read();
  for (const args of [
    ["status", "--typo"], ["team", "add", "a"], ["project", "bind", "a"],
    ["project", "bind", "a", "--team", "b", "--personal"], ["team", "enable", "--repo", "https://github.com/a/b"],
    ["session", "upload"], ["init", "https://github.com/example/assets", "extra"], ["team", "use", "a", "--personal"],
    ["skill", "install", "review", "--target", "codex"],
    ["skill", "uninstall", "review", "--target", "unknown"], ["team", "sync", "--transport", "file"],
    ["skill", "update", "review", "--target", "codex", "--revision", "1".repeat(40)],
    ["skill", "update", "review", "--target", "codex", "--revision", "1".repeat(40), "--from-revision", "none"],
    ["skill", "rollback", "review", "--target", "claude", "--from-revision", "none"],
    ["skill", "rollback", "review", "--target", "claude", "--backup", "anything"], ["skill", "diff", "review"],
    ["work-config", "install", "backend", "--target", "codex"],
    ["work-config", "install", "backend", "--target", "codex", "--revision", "1".repeat(40), "--from-revision", "0".repeat(40)],
    ["work-config", "preview", "backend", "--target", "unknown"], ["work-config", "uninstall", "backend"],
    ["work-config", "update", "backend", "--target", "codex", "--revision", "1".repeat(40)],
    ["work-config", "update", "backend", "--target", "codex", "--from-revision", "none", "--revision", "1".repeat(40)],
    ["work-config", "diff", "backend"],
  ]) {
    const result = await cli(home, root, args);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(result.result.error?.code, "INVALID_ARGUMENTS");
  }
  assert.deepEqual(await service.store.read(), before);
  const credential = await cli(home, root, ["team", "add", "a", "--repo", "https://secret@github.com/a/b"]);
  assert.equal(credential.code, 1);
  assert.ok(!credential.stdout.includes("secret"));
});
