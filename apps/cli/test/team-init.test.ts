import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitAssetSource, TeamAssetService, WorkspaceError } from "@agentrecall/workspace-core";
import { cli, execute, fixture, repository } from "./fixtures.js";

const url = "https://github.com/example/init-assets";
async function initFixture(t: Parameters<typeof fixture>[0], bare = true) {
  const state = await fixture(t);
  const remote = path.join(state.root, "remote");
  await execute("git", ["init", "-q", "--initial-branch=main", ...(bare ? ["--bare"] : []), remote]);
  const source = new GitAssetSource(async (_repository, destination) => {
    await execute("git", ["clone", "--bare", "--no-local", "--", remote, destination]);
  });
  return { ...state, remote, source, assets: new TeamAssetService(state.service, source) };
}
async function head(remote: string) {
  return (await execute("git", ["-C", remote, "rev-parse", "HEAD"])).stdout.trim();
}

test("initializes an empty team repository once, preserves personal defaults and supports normal sync", async (t) => {
  const { root, home, service, remote, source, assets } = await initFixture(t);
  const emptyRead = await fs.mkdtemp(path.join(root, "empty-read-"));
  await assert.rejects(source.load(url, emptyRead, "https"), { code: "EMPTY_ASSET_REPOSITORY" });
  const result = await assets.initialize(url, "研发团队");
  assert.equal(result.created, true);
  assert.equal(result.commit, await head(remote));
  assert.equal(result.team.name, "研发团队");
  assert.equal(result.teamEnabled, false);
  const manifest = JSON.parse((await execute("git", ["-C", remote, "show", "HEAD:agentrecall.json"])).stdout);
  assert.deepEqual(manifest, { schemaVersion: 2, skills: [], workConfigs: [] });
  const files = (await execute("git", ["-C", remote, "ls-tree", "-r", "--name-only", "HEAD"])).stdout.trim().split("\n");
  assert.deepEqual(files.sort(), ["README.md", "agentrecall.json", "docs/.gitkeep", "env/.gitkeep", "members/.gitkeep", "rules/.gitkeep", "skills/.gitkeep"].sort());
  assert.equal((await execute("git", ["-C", remote, "log", "-1", "--format=%ae"])).stdout.trim(), "agentrecall@users.noreply.github.com");
  const repeated = await assets.initialize(url);
  assert.equal(repeated.created, false);
  assert.equal(repeated.commit, result.commit);
  assert.equal(repeated.team.id, result.team.id);
  const config = (await service.store.read())!;
  assert.equal(config.teams.length, 1);
  assert.equal(config.defaultTeamId, null);
  assert.deepEqual(config.projects, []);
  assert.deepEqual(await fs.readdir(path.join(home, "initialization")), []);
  const business = await repository(path.join(root, "business"));
  await service.addProject({ id: "business", directory: business, teamId: result.team.id });
  await service.setTeamEnabled(true);
  assert.equal((await assets.sync(business)).commit, result.commit);
  assert.deepEqual((await assets.list(business)).skills, []);
});

test("refuses nonempty repositories without a compatible manifest instead of adding or replacing files", async (t) => {
  const { root, remote, service, assets } = await initFixture(t);
  const seed = await repository(path.join(root, "seed"));
  for (const invalid of [null, { schemaVersion: 99, skills: [] }]) {
    await fs.writeFile(path.join(seed, "README.md"), "Existing repository content\n");
    if (invalid) await fs.writeFile(path.join(seed, "agentrecall.json"), JSON.stringify(invalid));
    await execute("git", ["-C", seed, "add", "."]);
    await execute("git", ["-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Existing content"]);
    await execute("git", ["-C", seed, "push", remote, "HEAD:refs/heads/main"]);
    const before = await head(remote);
    await assert.rejects(assets.initialize(url), { code: invalid ? "INVALID_MANIFEST" : "MISSING_MANIFEST" });
    assert.equal(await head(remote), before);
    assert.equal((await service.store.read())?.teams.length, 0);
    assert.equal((await execute("git", ["-C", remote, "show", "HEAD:README.md"])).stdout, "Existing repository content\n");
  }
});

test("reports an unsuccessful push without registering the team and retries safely", async (t) => {
  const { remote, home, service, assets } = await initFixture(t, false);
  await execute("git", ["-C", remote, "config", "receive.denyCurrentBranch", "refuse"]);
  await assert.rejects(assets.initialize(url), { code: "INIT_PUSH_UNCONFIRMED" });
  assert.equal((await service.store.read())?.teams.length, 0);
  assert.equal((await execute("git", ["-C", remote, "for-each-ref"])).stdout, "");
  assert.deepEqual(await fs.readdir(path.join(home, "initialization")), []);
  await execute("git", ["-C", remote, "config", "receive.denyCurrentBranch", "ignore"]);
  assert.equal((await assets.initialize(url)).created, true);
});

test("a local save failure reports completed remote initialization and retry reuses its commit", async (t) => {
  const { remote, service, assets } = await initFixture(t);
  const update = t.mock.method(service.store, "update", async () => { throw new Error("Synthetic disk failure"); });
  await assert.rejects(assets.initialize(url), (error) => error instanceof WorkspaceError && error.code === "INIT_LOCAL_CONFIG_FAILED" && error.details?.repository === url && error.details?.remoteCreated === true);
  const commit = await head(remote);
  assert.equal((await service.store.read())?.teams.length, 0);
  update.mock.restore();
  const result = await assets.initialize(url);
  assert.equal(result.created, false);
  assert.equal(result.commit, commit);
  assert.equal((await service.store.read())?.teams.length, 1);
});

test("cancellation, invalid URLs and corrupt local config cannot publish a repository", async (t) => {
  const { root, home, remote, service, assets } = await initFixture(t);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(assets.initialize(url, undefined, "https", abort.signal), { code: "CANCELLED" });
  await assert.rejects(fs.access(service.store.filePath), { code: "ENOENT" });
  const invalid = await cli(home, root, ["init", "https://secret@github.com/example/assets"]);
  assert.equal(invalid.result.error?.code, "INVALID_REPOSITORY");
  assert.ok(!invalid.stdout.includes("secret"));
  await service.store.initialize();
  await fs.writeFile(service.store.filePath, "invalid");
  await assert.rejects(assets.initialize(url), { code: "INVALID_CONFIG" });
  assert.equal((await execute("git", ["-C", remote, "for-each-ref"])).stdout, "");
});


test("a lost initialization lock prevents remote publication", async (t) => {
  const { root, remote, source } = await initFixture(t);
  const scratch = await fs.mkdtemp(path.join(root, "lost-lock-"));
  await assert.rejects(source.initialize(url, scratch, "https", () => { throw new WorkspaceError("ASSETS_BUSY", "Synthetic compromised lock"); }), { code: "ASSETS_BUSY" });
  assert.equal((await execute("git", ["-C", remote, "for-each-ref"])).stdout, "");
});
