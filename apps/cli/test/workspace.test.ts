import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { WorkspaceConfigStore, WorkspaceService } from "@agentrecall/workspace-core";
import { cli, execute, fixture, repository } from "./fixtures.js";

test("normalizes GitHub transports while keeping forks distinct and credentials out of errors", async (t) => {
  const { service } = await fixture(t);
  await service.store.initialize();
  const canonical = "https://github.com/acme/app";
  for (const [i, value] of ["git@github.com:Acme/App.git", "ssh://git@github.com:22/Acme/App.git", "https://github.com/Acme/App.git/"].entries()) {
    assert.equal((await service.addTeam({ id: `team-${i}`, repository: value })).repository, canonical);
  }
  assert.notEqual((await service.addTeam({ id: "fork", repository: "git@github.com:fork/app.git" })).repository, canonical);
  for (const value of ["https://secret@github.com/acme/app", "https://github.com/acme/app?token=secret", "https://example.com/acme/app", "git@github.com:acme/app/extra"]) {
    await assert.rejects(service.addTeam({ id: "invalid", repository: value }), { code: "INVALID_REPOSITORY" });
  }
});

test("defaults to personal, keeps init idempotent, and refuses corrupt or future configs without rewriting them", async (t) => {
  const { home, service } = await fixture(t);
  const initial = await service.store.initialize();
  assert.equal(initial.teamEnabled, false);
  await service.addTeam({ id: "engineering", repository: "git@github.com:acme/assets.git" });
  await service.setTeamEnabled(true);
  assert.deepEqual(await service.store.initialize(), await service.store.read());
  for (const content of ["{", JSON.stringify({ ...initial, schemaVersion: 99 }), JSON.stringify({ ...initial, unexpected: true })]) {
    await fs.writeFile(service.store.filePath, content);
    await assert.rejects(service.store.initialize(), { code: "INVALID_CONFIG" });
    assert.equal(await fs.readFile(service.store.filePath, "utf8"), content);
    assert.deepEqual((await fs.readdir(home)).sort(), ["config.json"]);
  }
  await fs.writeFile(service.store.filePath, JSON.stringify({ ...initial, defaultTeamId: "missing" }));
  await assert.rejects(service.store.read(), { code: "INVALID_CONFIG" });
});

test("enforces whole-config byte limits for empty, exact and oversized multibyte input and oversized writes", async (t) => {
  const { service } = await fixture(t);
  const config = await service.store.initialize();
  const json = JSON.stringify(config);
  await fs.writeFile(service.store.filePath, "");
  await assert.rejects(service.store.read(), { code: "INVALID_CONFIG" });
  const exact = json + " ".repeat(1024 * 1024 - Buffer.byteLength(json));
  await fs.writeFile(service.store.filePath, exact);
  assert.deepEqual(await service.store.read(), config);
  await fs.appendFile(service.store.filePath, "中");
  await assert.rejects(service.store.read(), { code: "CONFIG_TOO_LARGE" });
  await fs.writeFile(service.store.filePath, json);
  await assert.rejects(service.store.update((current) => ({ ...current, teams: Array.from({ length: 2200 }, (_, i) => ({ id: `team-${i}`, name: "中".repeat(200), repository: "https://github.com/acme/assets" })) })), { code: "CONFIG_TOO_LARGE" });
  assert.equal(await fs.readFile(service.store.filePath, "utf8"), json);
});

test("two teams and three projects resolve explicit, inherited and personal assignments without enabling sharing", async (t) => {
  const { root, service } = await fixture(t);
  await service.store.initialize();
  await service.addTeam({ id: "red", repository: "https://github.com/acme/red-assets" });
  await service.addTeam({ id: "blue", repository: "https://github.com/acme/blue-assets" });
  await service.setDefaultTeam("red");
  const a = await repository(path.join(root, "a"), "git@github.com:acme/a.git");
  const b = await repository(path.join(root, "b"), "https://github.com/acme/b.git");
  const c = await repository(path.join(root, "c"));
  await service.addProject({ id: "a", directory: a });
  await service.addProject({ id: "b", directory: b, teamId: "blue" });
  await service.addProject({ id: "c", directory: c, teamId: null });
  await assert.rejects(service.currentTeam(a), { code: "TEAM_DISABLED" });
  await service.setTeamEnabled(true);
  assert.equal((await service.currentTeam(a)).team.id, "red");
  assert.equal((await service.currentTeam(b)).team.id, "blue");
  await assert.rejects(service.currentTeam(c), { code: "NO_TEAM" });
  await assert.rejects(service.currentTeam(root), { code: "NO_PROJECT" });
  assert.equal((await service.currentTeam(root, "b")).team.id, "blue");
  await assert.rejects(service.currentTeam(a, "b"), { code: "PROJECT_MISMATCH" });
  await service.bindProject("b", undefined);
  assert.equal((await service.currentTeam(b)).team.id, "red");
  await service.setTeamEnabled(false);
  await assert.rejects(service.currentTeam(b), { code: "TEAM_DISABLED" });
  assert.equal((await service.store.read())?.projects.length, 3);
});

test("recognizes worktrees and new clones, rejects ambiguous clones, changed remotes and unrelated nested repositories", async (t) => {
  const { root, service } = await fixture(t);
  await service.store.initialize();
  const original = await repository(path.join(root, "original"), "git@github.com:acme/app.git");
  await service.addProject({ id: "original", directory: original });
  const worktree = path.join(root, "worktree");
  await execute("git", ["-C", original, "worktree", "add", "--detach", worktree]);
  assert.equal((await service.status(worktree)).project?.id, "original");
  const clone = await repository(path.join(root, "clone"), "https://github.com/acme/app.git");
  assert.equal((await service.status(clone)).project?.id, "original");
  await service.addProject({ id: "clone", directory: clone });
  const third = await repository(path.join(root, "third"), "ssh://git@github.com/acme/app.git");
  await assert.rejects(service.status(third), { code: "AMBIGUOUS_PROJECT" });
  assert.equal((await service.status(third, "clone")).project?.id, "clone");
  const nested = await repository(path.join(original, "nested"), "https://github.com/fork/app");
  assert.equal((await service.status(nested)).project, null);
  await execute("git", ["-C", original, "remote", "set-url", "origin", "https://github.com/fork/app"]);
  await assert.rejects(service.status(original), { code: "REPOSITORY_CHANGED" });
  await service.removeProject("original");
  await assert.rejects(service.removeProject("original"), { code: "PROJECT_NOT_FOUND" });
  await service.addProject({ id: "original", directory: original });
  assert.equal((await service.status(original)).project?.repository, "https://github.com/fork/app");
});

test("requires explicit choice among remotes and does not overwrite existing project or invalid team bindings", async (t) => {
  const { root, service } = await fixture(t);
  await service.store.initialize();
  const directory = await repository(path.join(root, "repo"));
  await execute("git", ["-C", directory, "remote", "add", "upstream", "https://github.com/acme/app"]);
  await execute("git", ["-C", directory, "remote", "add", "fork", "https://github.com/fork/app"]);
  await assert.rejects(service.addProject({ id: "app", directory }), { code: "AMBIGUOUS_REMOTE" });
  await service.addProject({ id: "app", directory, remote: "fork" });
  const before = await service.store.read();
  await assert.rejects(service.addProject({ id: "other", directory, remote: "upstream" }), { code: "PROJECT_EXISTS" });
  await assert.rejects(service.bindProject("app", "missing"), { code: "INVALID_CONFIG" });
  assert.deepEqual(await service.store.read(), before);
});

test("concurrent CLI processes preserve all edits and release the config lock after failures", async (t) => {
  const { root, home, service } = await fixture(t);
  await service.store.initialize();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => cli(home, root, ["team", "add", `team-${i}`, "--repo", `https://github.com/acme/assets-${i}`])));
  assert.ok(results.some((result) => result.code === 0), JSON.stringify(results));
  assert.deepEqual((await service.store.read())?.teams.map((team) => team.id).sort(),
    results.flatMap((result, i) => result.code === 0 ? [`team-${i}`] : []).sort());
  // Lock acquisition has a bounded wait; a busy process must fail without writing
  // and be retryable after the competing writers have finished.
  for (const [i, result] of results.entries()) {
    if (result.code === 0) continue;
    assert.equal(result.result.error?.code, "CONFIG_BUSY", JSON.stringify(result));
    const retried = await cli(home, root, ["team", "add", `team-${i}`, "--repo", `https://github.com/acme/assets-${i}`]);
    assert.equal(retried.code, 0, JSON.stringify(retried));
  }
  assert.equal((await service.store.read())?.teams.length, 8);
  await assert.rejects(service.store.update(() => { throw new Error("cancelled"); }), /cancelled/);
  await new WorkspaceConfigStore(home).update((current) => ({ ...current, teamEnabled: true }));
  assert.deepEqual((await fs.readdir(home)).sort(), ["config.json"]);
});


test("logical projects need only a name, migrate on write and keep identities independent from directories", async (t) => {
  const { service, root } = await fixture(t);
  await service.store.initialize();
  await service.addTeam({ id: "team", repository: "https://github.com/example/assets" });
  const local = await repository(path.join(root, "local"), "https://github.com/example/code");
  const legacy = await service.addProject({ id: "legacy", directory: local, teamId: "team" });
  assert.equal((await service.store.read())?.schemaVersion, 1);
  const space = await service.createProject({ name: "Agent 研究", teamId: "team" });
  const saved = (await service.store.read())!;
  assert.equal(saved.schemaVersion, 2);
  assert.deepEqual(saved.projects.find((item) => item.id === legacy.id), legacy);
  assert.equal(space.root, null); assert.equal(space.repository, null);
  await service.setTeamEnabled(true);
  assert.equal((await service.currentTeam(local, space.id)).project.id, space.id);
  await assert.rejects(service.createProject({ name: " Agent 研究 ", teamId: "team" }), { code: "PROJECT_EXISTS" });
  const other = new WorkspaceService(path.join(root, "other-device"));
  await other.store.initialize(); await other.addTeam({ id: "different-local-id", repository: "https://github.com/example/assets" });
  const sameSpace = await other.createProject({ name: "Agent 研究", teamId: "different-local-id" });
  assert.equal(sameSpace.sharingKey, space.sharingKey);
  const created = await cli(path.dirname(service.store.filePath), root, ["project", "create", "CLI Research", "--team", "team"]);
  assert.equal(created.code, 0, created.stdout);
  const before = await fs.readFile(service.store.filePath, "utf8");
  await fs.writeFile(service.store.filePath, JSON.stringify({ ...saved, schemaVersion: 1 }));
  await assert.rejects(service.store.read(), { code: "INVALID_CONFIG" });
  await fs.writeFile(service.store.filePath, before);
  assert.equal((await service.currentTeam(local, space.id)).project.sharingKey, space.sharingKey);
});

test("directory connections preserve legacy projects, work without Git and reject stale or disabled selections", async (t) => {
  const { service, root, home } = await fixture(t);
  await service.store.initialize(); await service.addTeam({ id: "team", repository: "https://github.com/example/assets" });
  const old = await repository(path.join(root, "legacy")); await service.addProject({ id: "old", directory: old, teamId: "team" });
  const before = (await service.store.read())!;
  assert.equal(service.directoryConnections(before).length, 1);
  assert.equal((await service.store.read())!.schemaVersion, 1);
  const plain = path.join(root, "plain"); await fs.mkdir(plain);
  assert.equal((await cli(home, root, ["directory", "add", plain, "--team", "team", "--target", "claude"])).code, 0);
  const saved = (await service.store.read())!;
  assert.equal(saved.schemaVersion, 3); assert.deepEqual(saved.projects, before.projects);
  const connection = saved.directories!.find((entry) => entry.id !== "old")!;
  assert.deepEqual(connection.targets, ["claude"]);
  await service.setTeamEnabled(true);
  assert.equal((await service.teamContext("team", connection.id, connection.path)).directory?.path, await fs.realpath(plain));
  await assert.rejects(service.teamContext("team", connection.id, old), { code: "PROJECT_MISMATCH" });
  await service.updateDirectory("team", connection.id, connection.path, { enabled: false, targets: ["claude"] });
  await assert.rejects(service.teamContext("team", connection.id, connection.path), { code: "DIRECTORY_DISABLED" });
  await fs.writeFile(path.join(plain, "keep.md"), "keep");
  await service.updateDirectory("team", connection.id, connection.path, null);
  assert.equal(await fs.readFile(path.join(plain, "keep.md"), "utf8"), "keep");
  assert.deepEqual((await service.store.read())!.projects, before.projects);
});
