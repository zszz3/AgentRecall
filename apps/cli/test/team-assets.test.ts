import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { GitAssetSource, TeamAssetService } from "@agentrecall/workspace-core";
import { cli, execute, fixture, repository } from "./fixtures.js";

const markdown = "---\nname: review\ndescription: Review a chosen change\n---\nRead the diff before commenting.\n";

async function commit(directory: string) {
  await execute("git", ["-C", directory, "add", "."]);
  await execute("git", ["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "asset fixture"]);
}

async function assetsFixture(t: Parameters<typeof fixture>[0]) {
  const state = await fixture(t);
  const business = await repository(path.join(state.root, "business"), "https://github.com/example/business");
  const source = await repository(path.join(state.root, "asset-source"));
  await fs.mkdir(path.join(source, "skills", "review", "scripts"), { recursive: true });
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify({ schemaVersion: 1, skills: [{ id: "review", path: "skills/review" }] }));
  await fs.writeFile(path.join(source, "skills", "review", "SKILL.md"), markdown);
  await fs.writeFile(path.join(source, "skills", "review", "scripts", "example.txt"), "supporting file\n");
  await commit(source);
  await state.service.store.initialize();
  await state.service.addTeam({ id: "engineering", repository: "https://github.com/example/assets" });
  await state.service.addProject({ id: "business", directory: business, teamId: "engineering" });
  const clone = async (_url: string, destination: string) => {
    await execute("git", ["clone", "--bare", "--no-hardlinks", "--", source, destination]);
  };
  const assets = new TeamAssetService(state.service, new GitAssetSource(clone));
  const cache = path.join(state.home, "assets", "engineering.json");
  return { ...state, business, source, clone, assets, cache };
}

test("sync is opt-in; previews pinned Skills and installs only into the selected project", async (t) => {
  const { service, assets, business, home, root, cache } = await assetsFixture(t);
  await assert.rejects(assets.sync(business), { code: "TEAM_DISABLED" });
  await assert.rejects(fs.access(path.dirname(cache)), { code: "ENOENT" });
  await service.setTeamEnabled(true);
  await assert.rejects(assets.list(business), { code: "ASSETS_NOT_SYNCED" });
  const synced = await assets.sync(business);
  assert.equal(synced.skills, 1);
  assert.match(synced.commit, /^[a-f0-9]{40}$/);
  assert.equal((await assets.list(business)).skills[0]?.id, "review");
  const preview = await assets.preview(business, "review", undefined, "codex");
  assert.equal(preview.content, markdown);
  assert.equal(preview.destination, path.join(await fs.realpath(business), ".agents", "skills", "review"));
  assert.equal((await assets.preview(business, "review", undefined, undefined, "scripts/example.txt")).content, "supporting file\n");
  await assert.rejects(assets.preview(business, "review", undefined, undefined, "../../config.json"), { code: "SKILL_FILE_NOT_FOUND" });
  await assert.rejects(assets.install(business, "review", "codex", "0".repeat(40)), { code: "SNAPSHOT_CHANGED" });
  assert.equal((await assets.install(business, "review", "codex", synced.commit)).status, "installed");
  assert.equal((await assets.install(business, "review", "codex", synced.commit)).status, "existing");
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => cli(home, business, ["skill", "install", "review", "--target", "claude", "--revision", synced.commit])));
  assert.ok(concurrent.every((result) => result.code === 0), JSON.stringify(concurrent));
  assert.equal((await assets.install(root, "review", "claude", synced.commit, "business")).status, "existing");
  assert.equal(await fs.readFile(path.join(business, ".claude", "skills", "review", "SKILL.md"), "utf8"), markdown);
  await assert.rejects(fs.access(path.join(home, ".claude")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(path.dirname(cache))).sort(), ["engineering.json"]);
  const other = await repository(path.join(root, "other"), "https://github.com/example/other");
  await service.addTeam({ id: "research", repository: "https://github.com/example/research-assets" });
  await service.addProject({ id: "other", directory: other, teamId: "research" });
  await assert.rejects(assets.list(other), { code: "ASSETS_NOT_SYNCED" });
  const fromCli = await cli(home, business, ["skill", "preview", "review", "--target", "codex"]);
  assert.equal(fromCli.code, 0, fromCli.stdout);
  assert.equal((await cli(home, business, ["skill", "install", "review", "--target", "codex", "--revision", synced.commit])).code, 0);
  await service.setTeamEnabled(false);
  await assert.rejects(assets.list(business), { code: "TEAM_DISABLED" });
  await assert.rejects(assets.install(business, "review", "claude", synced.commit), { code: "TEAM_DISABLED" });
  const removed = await assets.uninstall(business, "review", "codex");
  assert.equal(await fs.readFile(path.join(removed.backupPath, "SKILL.md"), "utf8"), markdown);
  await assert.rejects(fs.access(removed.path), { code: "ENOENT" });
});

test("failed or cancelled sync preserves the last snapshot and disabling a team blocks an in-flight download commit", async (t) => {
  const { service, assets, business, source, cache, clone } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  await assets.sync(business);
  const original = await fs.readFile(cache, "utf8");
  await fs.writeFile(path.join(source, "agentrecall.json"), '{"schemaVersion":2,"skills":[]}');
  await commit(source);
  await assert.rejects(assets.sync(business), { code: "INVALID_MANIFEST" });
  assert.equal(await fs.readFile(cache, "utf8"), original);
  await fs.writeFile(path.join(source, "agentrecall.json"), '{"schemaVersion":1,"skills":[]}');
  await commit(source);
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pause = new Promise<void>((resolve) => { resume = resolve; });
  const delayed = new TeamAssetService(service, new GitAssetSource(async (url, destination) => {
    entered(); await pause; await clone(url, destination);
  }));
  const rejected = assert.rejects(delayed.sync(business), { code: "TEAM_DISABLED" });
  await started;
  await service.setTeamEnabled(false);
  resume();
  await rejected;
  assert.equal(await fs.readFile(cache, "utf8"), original);
  await service.setTeamEnabled(true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(assets.sync(business, undefined, "https", controller.signal), { code: "CANCELLED" });
  assert.equal(await fs.readFile(cache, "utf8"), original);
  assert.deepEqual((await fs.readdir(path.dirname(cache))).sort(), ["engineering.json"]);
});

test("new asset versions, unmanaged destinations, and locally edited installs are never overwritten", async (t) => {
  const { service, assets, business, source } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const first = await assets.sync(business);
  const installed = await assets.install(business, "review", "codex", first.commit);
  await fs.appendFile(path.join(installed.path, "SKILL.md"), "Local edit\n");
  await assert.rejects(assets.install(business, "review", "codex", first.commit), { code: "SKILL_CONFLICT" });
  await assert.rejects(assets.uninstall(business, "review", "codex"), { code: "SKILL_CONFLICT" });
  assert.match(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), /Local edit/);
  const unmanaged = path.join(business, ".claude", "skills", "review");
  await fs.mkdir(unmanaged, { recursive: true });
  await fs.writeFile(path.join(unmanaged, "SKILL.md"), "Personal content");
  await assert.rejects(assets.install(business, "review", "claude", first.commit), { code: "SKILL_CONFLICT" });
  await fs.appendFile(path.join(source, "skills", "review", "SKILL.md"), "Remote update\n");
  await commit(source);
  const second = await assets.sync(business);
  assert.notEqual(second.commit, first.commit);
  await assert.rejects(assets.install(business, "review", "codex", first.commit), { code: "SNAPSHOT_CHANGED" });
  await assert.rejects(assets.install(business, "review", "codex", second.commit), { code: "SKILL_CONFLICT" });
  assert.equal(await fs.readFile(path.join(unmanaged, "SKILL.md"), "utf8"), "Personal content");
});

test("worktree installs stay in that worktree and target parent symlinks cannot redirect writes", async (t) => {
  const { service, assets, business, root } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const synced = await assets.sync(business);
  const worktree = path.join(root, "linked worktree");
  await execute("git", ["-C", business, "worktree", "add", "--detach", worktree]);
  const installed = await assets.install(worktree, "review", "codex", synced.commit);
  assert.equal(installed.path, path.join(await fs.realpath(worktree), ".agents", "skills", "review"));
  await assert.rejects(fs.access(path.join(business, ".agents")), { code: "ENOENT" });
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(worktree, ".claude"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assets.install(worktree, "review", "claude", synced.commit), { code: "SKILL_CONFLICT" });
  assert.deepEqual(await fs.readdir(outside), []);
});

test("rejects links, traversal, invalid frontmatter, future manifests, and oversized raw assets", async (t) => {
  const { service, assets, business, source } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const skillFile = path.join(source, "skills", "review", "SKILL.md");
  for (const invalid of ["No frontmatter", "---\nname: another\ndescription: Wrong ID\n---\n", "---\nname: review\ndescription: &alias description\nextra: *alias\n---\n"]) {
    await fs.writeFile(skillFile, invalid);
    await commit(source);
    await assert.rejects(assets.sync(business), { code: "INVALID_ASSET" });
  }
  await fs.writeFile(skillFile, markdown);
  const large = path.join(source, "skills", "review", "large.txt");
  await fs.writeFile(large, Buffer.alloc(1024 * 1024, "a"));
  await commit(source);
  await assets.sync(business);
  await fs.appendFile(large, "中");
  await commit(source);
  await assert.rejects(assets.sync(business), { code: "INVALID_ASSET" });
  await fs.rm(large);
  const bulk = Array.from({ length: 9 }, (_, index) => path.join(source, "skills", "review", "bulk-" + index));
  for (const file of bulk) await fs.writeFile(file, Buffer.alloc(1024 * 1024, "a"));
  await commit(source);
  await assert.rejects(assets.sync(business), { code: "ASSETS_TOO_LARGE" });
  for (const file of bulk) await fs.rm(file);
  await fs.writeFile(path.join(source, "agentrecall.json"), '{"schemaVersion":1,"skills":[{"id":"review","path":"../outside"}]}');
  await commit(source);
  await assert.rejects(assets.sync(business), { code: "INVALID_MANIFEST" });
  await fs.writeFile(path.join(source, "agentrecall.json"), '{"schemaVersion":1,"skills":[{"id":"review","path":"skills/review"}]}');
  await commit(source);
  const linkContent = path.join(source, "link-content");
  await fs.writeFile(linkContent, "../../outside");
  const oid = (await execute("git", ["-C", source, "hash-object", "-w", linkContent])).stdout.trim();
  await execute("git", ["-C", source, "update-index", "--add", "--cacheinfo", "120000," + oid + ",skills/review/escape"]);
  await execute("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "symlink fixture"]);
  await assert.rejects(assets.sync(business), { code: "INVALID_ASSET" });
});

test("complete cache byte limits and repository identity are enforced before returning team assets", async (t) => {
  const { service, assets, business, cache } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  await assets.sync(business);
  const original = await fs.readFile(cache, "utf8");
  await fs.writeFile(cache, JSON.stringify({ ...JSON.parse(original), skills: [] }));
  assert.deepEqual((await assets.list(business)).skills, []);
  await fs.writeFile(cache, original + " ".repeat(16 * 1024 * 1024 - Buffer.byteLength(original)));
  assert.equal((await assets.list(business)).skills.length, 1);
  await fs.appendFile(cache, "中");
  await assert.rejects(assets.list(business), { code: "ASSETS_TOO_LARGE" });
  await fs.writeFile(cache, JSON.stringify({ ...JSON.parse(original), repository: "https://github.com/another/team" }));
  await assert.rejects(assets.list(business), { code: "INVALID_ASSET" });
});
