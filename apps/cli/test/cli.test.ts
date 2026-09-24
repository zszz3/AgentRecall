import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { cli, fixture, repository } from "./fixtures.js";

test("CLI initializes without the desktop, persists bindings and gates the active team", async (t) => {
  const { root, home } = await fixture(t);
  assert.equal((await cli(home, root, ["status"])).result.ok, true);
  assert.equal((await cli(home, root, ["doctor"])).result.error?.code, "NOT_INITIALIZED");
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
  assert.equal((await cli(home, repo, ["project", "bind", "app", "--personal"])).code, 0);
  assert.equal((await cli(home, repo, ["team", "current"])).result.error?.code, "NO_TEAM");
  assert.equal((await cli(home, root, ["team", "disable"])).code, 0);
  assert.equal((await cli(home, root, ["team", "list"])).code, 0);
  assert.equal((await cli(home, root, ["project", "list"])).code, 0);
  assert.equal((await cli(home, root, ["project", "remove", "app"])).code, 0);
  assert.equal((await cli(home, root, ["project", "remove", "app"])).result.error?.code, "PROJECT_NOT_FOUND");
});

test("rejects unknown commands, conflicting flags and missing arguments before changing configuration", async (t) => {
  const { root, home, service } = await fixture(t);
  await service.store.initialize();
  const before = await service.store.read();
  for (const args of [
    ["status", "--typo"], ["team", "add", "a"], ["project", "bind", "a"],
    ["project", "bind", "a", "--team", "b", "--personal"], ["team", "enable", "--repo", "https://github.com/a/b"],
    ["session", "upload"], ["init", "extra"], ["team", "use", "a", "--personal"],
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
