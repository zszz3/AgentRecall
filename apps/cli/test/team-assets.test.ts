import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GitAssetSource, TeamAssetService, WorkspaceError } from "@agentrecall/workspace-core";
import { cli, execute, fixture, repository } from "./fixtures.js";

const markdown = "---\nname: review\ndescription: Review a chosen change\n---\nRead the diff before commenting.\n";

async function updateFixture(t: Parameters<typeof fixture>[0]) {
  const state = await assetsFixture(t);
  await state.service.setTeamEnabled(true);
  const first = await state.assets.sync(state.business);
  const installed = await state.assets.install(state.business, "review", "codex", first.commit);
  await fs.appendFile(path.join(state.source, "skills", "review", "SKILL.md"), "New review instructions.\n");
  await fs.rm(path.join(state.source, "skills", "review", "scripts", "example.txt"));
  await fs.writeFile(path.join(state.source, "skills", "review", "new.txt"), "新内容\n");
  await commit(state.source);
  const second = await state.assets.sync(state.business);
  return { ...state, first, second, installed };
}

test("previews additions, removals and content; explicit version update preserves a restorable backup", async (t) => {
  const { assets, home, business, first, second, installed } = await updateFixture(t);
  const diff = await assets.diff(business, "review", "codex");
  assert.equal(diff.fromRevision, first.commit);
  assert.equal(diff.revision, second.commit);
  assert.deepEqual(diff.changes.map(({ path, status }) => ({ path, status })), [
    { path: "SKILL.md", status: "modified" }, { path: "new.txt", status: "added" },
    { path: "scripts/example.txt", status: "removed" },
  ]);
  const details = await assets.diff(business, "review", "codex", undefined, "SKILL.md");
  assert.equal(details.before?.content, markdown);
  assert.match(details.after?.content ?? "", /New review/);
  assert.equal((await assets.diff(business, "review", "codex", undefined, "new.txt")).before, null);
  assert.equal((await assets.diff(business, "review", "codex", undefined, "scripts/example.txt")).after, null);
  await assert.rejects(assets.diff(business, "review", "codex", undefined, "../outside"), { code: "SKILL_FILE_NOT_FOUND" });
  assert.equal((await cli(home, business, ["skill", "diff", "review", "--target", "codex", "--file", "SKILL.md"])).code, 0);
  const updated = await cli(home, business, ["skill", "update", "review", "--target", "codex", "--from-revision", first.commit, "--revision", second.commit]);
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), markdown + "New review instructions.\n");
  await assert.rejects(fs.access(path.join(installed.path, "scripts", "example.txt")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(installed.path, "new.txt"), "utf8"), "新内容\n");
  const { backups } = await assets.backups(business, "review");
  assert.equal(backups.length, 1);
  assert.equal(backups[0]?.revision, first.commit);
  assert.equal(backups[0]?.valid, true);
  const repeated = await assets.install(business, "review", "codex", second.commit, undefined, second.commit);
  assert.equal(repeated.status, "existing");
  assert.equal((await assets.backups(business, "review")).backups.length, 1);
  assert.deepEqual((await assets.diff(business, "review", "codex")).changes, []);
  const restored = await cli(home, business, ["skill", "rollback", "review", "--target", "codex", "--backup", backups[0]!.backup, "--from-revision", second.commit]);
  assert.equal(restored.code, 0, restored.stdout);
  assert.equal(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), markdown);
  assert.equal((await assets.backups(business, "review")).backups[0]?.revision, second.commit);
  assert.equal((await cli(home, business, ["skill", "backups", "review"])).code, 0);
});

test("stale versions, changed sources and local edits prevent updates and rollback", async (t) => {
  const { service, assets, business, first, second, installed } = await updateFixture(t);
  await assert.rejects(assets.install(business, "review", "codex", second.commit, undefined, "0".repeat(40)), { code: "INSTALLATION_CHANGED" });
  const updated = await assets.install(business, "review", "codex", second.commit, undefined, first.commit);
  assert.ok(updated.backupPath);
  const backup = path.basename(updated.backupPath);
  await assert.rejects(assets.rollback(business, "review", "codex", backup, first.commit), { code: "INSTALLATION_CHANGED" });
  await assert.rejects(assets.rollback(business, "review", "codex", backup, null), { code: "INSTALLATION_CHANGED" });
  await assert.rejects(assets.rollback(business, "review", "codex", "../" + backup, second.commit), { code: "INVALID_ARGUMENTS" });
  await fs.appendFile(path.join(installed.path, "SKILL.md"), "Local edit");
  await assert.rejects(assets.diff(business, "review", "codex"), { code: "SKILL_CONFLICT" });
  await assert.rejects(assets.install(business, "review", "codex", second.commit, undefined, second.commit), { code: "SKILL_CONFLICT" });
  await assert.rejects(assets.rollback(business, "review", "codex", backup, second.commit), { code: "SKILL_CONFLICT" });
  await fs.writeFile(path.join(installed.path, "SKILL.md"), markdown + "New review instructions.\n");
  const markerPath = path.join(installed.path, ".agentrecall-install.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  await fs.writeFile(markerPath, JSON.stringify({ ...marker, repository: "https://github.com/other/assets" }));
  await assert.rejects(assets.diff(business, "review", "codex"), { code: "SKILL_CONFLICT" });
  await assert.rejects(assets.rollback(business, "review", "codex", backup, second.commit), { code: "SKILL_CONFLICT" });
  await fs.writeFile(markerPath, JSON.stringify(marker));
  await service.setTeamEnabled(false);
  await assert.rejects(assets.install(business, "review", "codex", second.commit, undefined, second.commit), { code: "TEAM_DISABLED" });
  await assets.rollback(business, "review", "codex", backup, second.commit);
  assert.equal(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), markdown);
});

test("old uninstall backups restore offline into an empty target; damaged and linked backups are rejected", async (t) => {
  const { service, assets, business, root } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const version = await assets.sync(business);
  await assets.install(business, "review", "claude", version.commit);
  const removed = await assets.uninstall(business, "review", "claude");
  const backup = path.basename(removed.backupPath);
  await service.setTeamEnabled(false);
  const recordPath = path.join(removed.backupPath, ".agentrecall-install.json");
  const old = await fs.readFile(recordPath, "utf8");
  await fs.writeFile(recordPath, old.replace('"schemaVersion":1', '"schemaVersion":2'));
  assert.equal((await assets.backups(business, "review")).backups[0]?.valid, false);
  await assert.rejects(assets.rollback(business, "review", "claude", backup, null), { code: "SKILL_CONFLICT" });
  await fs.writeFile(recordPath, old);
  await fs.appendFile(path.join(removed.backupPath, "SKILL.md"), "Edited backup");
  await assert.rejects(assets.rollback(business, "review", "claude", backup, null), { code: "SKILL_CONFLICT" });
  await fs.writeFile(path.join(removed.backupPath, "SKILL.md"), markdown);
  const renamed = path.join(root, "backup-content");
  await fs.rename(removed.backupPath, renamed);
  await fs.symlink(renamed, removed.backupPath, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await assets.backups(business, "review")).backups[0]?.valid, false);
  await assert.rejects(assets.rollback(business, "review", "claude", backup, null), { code: "SKILL_CONFLICT" });
  await fs.unlink(removed.backupPath);
  await fs.rename(renamed, removed.backupPath);
  const restored = await assets.rollback(business, "review", "claude", backup, null);
  assert.equal(restored.commit, version.commit);
  assert.equal(await fs.readFile(path.join(restored.path, "SKILL.md"), "utf8"), markdown);
  assert.deepEqual((await assets.backups(business, "review")).backups, []);
});

test("replacement failures restore the current install, or retain an explicitly recoverable backup", async (t) => {
  const { assets, business, first, second, installed } = await updateFixture(t);
  const rename = syncFs.renameSync;
  let publications = 0;
  const failingPublish = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (String(source).includes(".agentrecall-skill-stage-")) {
      publications++;
      throw Object.assign(new Error("Synthetic publication failure"), { code: "EACCES" });
    }
    return rename(source, destination);
  });
  await assert.rejects(assets.install(business, "review", "codex", second.commit, undefined, first.commit), { code: "SKILL_REPLACE_FAILED" });
  assert.equal(publications, 1);
  assert.equal(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), markdown);
  assert.deepEqual((await assets.backups(business, "review")).backups, []);
  failingPublish.mock.restore();
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (String(source).includes(".agentrecall-skill-stage-") || String(source).includes(".agentrecall-skill-backups")) {
      throw Object.assign(new Error("Synthetic restore failure"), { code: "EACCES" });
    }
    return rename(source, destination);
  });
  await assert.rejects(assets.install(business, "review", "codex", second.commit, undefined, first.commit), { code: "SKILL_RECOVERY_REQUIRED" });
  failure.mock.restore();
  await assert.rejects(fs.access(installed.path), { code: "ENOENT" });
  const { backups } = await assets.backups(business, "review");
  assert.equal(backups.length, 1);
  await assets.rollback(business, "review", "codex", backups[0]!.backup, null);
  assert.equal(await fs.readFile(path.join(installed.path, "SKILL.md"), "utf8"), markdown);
  assert.ok(!(await fs.readdir(business)).some((file) => file.startsWith(".agentrecall-skill-stage-") || file.endsWith(".lock")));
});

test("concurrent updates cannot silently replace a newer install", async (t) => {
  const { assets, home, business, first, second } = await updateFixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, () => cli(home, business, [
    "skill", "update", "review", "--target", "codex", "--revision", second.commit, "--from-revision", first.commit,
  ])));
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.ok(results.filter((result) => result.code !== 0).every((result) => result.result.error?.code === "INSTALLATION_CHANGED"), JSON.stringify(results));
  assert.equal((await assets.backups(business, "review")).backups.length, 1);
});

async function workConfigFixture(t: Parameters<typeof fixture>[0]) {
  const state = await assetsFixture(t);
  await fs.mkdir(path.join(state.source, "skills", "lint"), { recursive: true });
  await fs.writeFile(path.join(state.source, "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint a change\n---\nRun lint.\n");
  const manifest = {
    schemaVersion: 2,
    skills: [{ id: "review", path: "skills/review" }, { id: "lint", path: "skills/lint" }],
    workConfigs: [
      { id: "backend", name: "Backend", description: "Review and lint", skills: ["review", "lint"] },
      { id: "review-only", name: "Review only", description: "Review changes", skills: ["review"] },
    ],
  };
  await fs.writeFile(path.join(state.source, "agentrecall.json"), JSON.stringify(manifest));
  await commit(state.source);
  await state.service.setTeamEnabled(true);
  const synced = await state.assets.sync(state.business);
  return { ...state, manifest, synced };
}

test("work configurations preview local status, reuse overlapping Skills and isolate projects and clients", async (t) => {
  const { service, assets, business, home, root, synced } = await workConfigFixture(t);
  assert.equal((await assets.listWorkConfigs(business)).workConfigs[0]?.id, "backend");
  assert.ok((await assets.previewWorkConfig(business, "backend")).skills.every((skill) => skill.status === "unselected"));
  const preview = await assets.previewWorkConfig(business, "backend", undefined, "codex");
  assert.deepEqual(preview.skills.map((skill) => [skill.id, skill.status]), [["review", "new"], ["lint", "new"]]);
  await assert.rejects(fs.access(path.join(business, ".agents")), { code: "ENOENT" });
  const first = await assets.installWorkConfig(business, "review-only", "codex", synced.commit);
  assert.equal(first.skills[0]?.status, "installed");
  const installed = await assets.installWorkConfig(business, "backend", "codex", synced.commit);
  assert.deepEqual(installed.skills.map((skill) => skill.status), ["existing", "installed"]);
  assert.ok((await assets.installWorkConfig(business, "backend", "codex", synced.commit)).skills.every((skill) => skill.status === "existing"));
  assert.ok((await assets.previewWorkConfig(business, "backend", undefined, "codex")).skills.every((skill) => skill.status === "existing"));
  assert.equal((await cli(home, business, ["work-config", "list"])).code, 0);
  assert.equal((await cli(home, business, ["work-config", "preview", "backend", "--target", "codex"])).code, 0);
  const fromCli = await cli(home, business, ["work-config", "install", "backend", "--target", "claude", "--revision", synced.commit]);
  assert.equal(fromCli.code, 0, fromCli.stdout);
  const other = await repository(path.join(root, "other"), "https://github.com/example/other");
  await service.addProject({ id: "other", directory: other, teamId: "engineering" });
  assert.ok((await assets.previewWorkConfig(other, "backend", undefined, "codex")).skills.every((skill) => skill.status === "new"));
  const worktree = path.join(root, "linked checkout");
  await execute("git", ["-C", other, "worktree", "add", "--detach", worktree]);
  const linked = await assets.installWorkConfig(worktree, "backend", "codex", synced.commit);
  const realWorktree = await fs.realpath(worktree);
  assert.ok(linked.skills.every((skill) => skill.path.startsWith(realWorktree + path.sep)));
  await assert.rejects(fs.access(path.join(other, ".agents")), { code: "ENOENT" });
  await service.setTeamEnabled(false);
  await assert.rejects(assets.listWorkConfigs(business), { code: "TEAM_DISABLED" });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), { code: "TEAM_DISABLED" });
});

test("work configuration conflicts and stale versions fail before publishing any Skill", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  await fs.mkdir(path.join(business, ".agents", "skills", "lint"), { recursive: true });
  await fs.writeFile(path.join(business, ".agents", "skills", "lint", "SKILL.md"), "personal\n");
  const preview = await assets.previewWorkConfig(business, "backend", undefined, "codex");
  assert.deepEqual(preview.skills.map((skill) => skill.status), ["new", "conflict"]);
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", "0".repeat(40)), { code: "SNAPSHOT_CHANGED" });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), { code: "SKILL_CONFLICT" });
  await assert.rejects(fs.access(path.join(business, ".agents", "skills", "review")), { code: "ENOENT" });
  assert.ok(!(await fs.readdir(business)).some((name) => name.startsWith(".agentrecall-skill-stage-") || name.endsWith(".lock")));
});

test("disabling the team while staging a work configuration prevents publication and cleans staging", async (t) => {
  const { service, assets, business, synced } = await workConfigFixture(t);
  const write = syncFs.writeFileSync;
  let disabled = false;
  const changingConfig = t.mock.method(syncFs, "writeFileSync", (...args: Parameters<typeof syncFs.writeFileSync>) => {
    const result = write(...args);
    if (!disabled && path.basename(String(args[0])) === ".agentrecall-install.json") {
      disabled = true;
      const config = JSON.parse(syncFs.readFileSync(service.store.filePath, "utf8"));
      write(service.store.filePath, JSON.stringify({ ...config, teamEnabled: false }));
    }
    return result;
  });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), { code: "TEAM_DISABLED" });
  changingConfig.mock.restore();
  assert.equal(disabled, true);
  await assert.rejects(fs.access(path.join(business, ".agents")), { code: "ENOENT" });
  assert.ok(!(await fs.readdir(business)).some((name) => name.startsWith(".agentrecall-skill-stage-") || name.endsWith(".lock")));
});

test("failed batch publication backs up only new copies and preserves pre-existing Skills", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  const rename = syncFs.renameSync;
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (String(source).includes(".agentrecall-skill-stage-") && path.basename(String(destination)) === "lint") throw new Error("Synthetic failure");
    return rename(source, destination);
  });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), (error: unknown) => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, "WORK_CONFIG_INSTALL_FAILED");
    assert.equal(error.details?.failedSkillId, "lint");
    assert.match(JSON.stringify(error.details), /reverted/);
    return true;
  });
  await assert.rejects(fs.access(path.join(business, ".agents", "skills", "review")), { code: "ENOENT" });
  assert.equal((await assets.backups(business, "review")).backups[0]?.valid, true);
  failure.mock.restore();
  await assets.install(business, "review", "codex", synced.commit);
  const failAgain = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (String(source).includes(".agentrecall-skill-stage-") && path.basename(String(destination)) === "lint") throw new Error("Synthetic failure");
    return rename(source, destination);
  });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), { code: "WORK_CONFIG_INSTALL_FAILED" });
  failAgain.mock.restore();
  assert.equal(await fs.readFile(path.join(business, ".agents", "skills", "review", "SKILL.md"), "utf8"), markdown);
  assert.equal((await assets.backups(business, "review")).backups.length, 1);
  assert.ok(!(await fs.readdir(business)).some((name) => name.startsWith(".agentrecall-skill-stage-") || name.endsWith(".lock")));
});

test("batch recovery preserves edits and reports partial installation instead of success", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  const rename = syncFs.renameSync;
  const review = path.join(business, ".agents", "skills", "review", "SKILL.md");
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (String(source).includes(".agentrecall-skill-stage-") && path.basename(String(destination)) === "lint") {
      syncFs.appendFileSync(review, "Manual change during publication");
      throw new Error("Synthetic failure");
    }
    return rename(source, destination);
  });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), (error: unknown) => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, "WORK_CONFIG_RECOVERY_REQUIRED");
    assert.match(JSON.stringify(error.details), /recovery_required/);
    return true;
  });
  failure.mock.restore();
  assert.match(await fs.readFile(review, "utf8"), /Manual change/);
  await assert.rejects(fs.access(path.join(business, ".agents", "skills", "lint")), { code: "ENOENT" });
});

test("manifest and cache versions preserve old Skills and reject invalid work-config references", async (t) => {
  const { assets, business, source, manifest, cache } = await workConfigFixture(t);
  const lastValid = await fs.readFile(cache, "utf8");
  await fs.writeFile(cache, JSON.stringify({ schemaVersion: 2, repository: "https://github.com/example/assets", commit: "1".repeat(40), skills: [], workConfigs: [] }));
  assert.deepEqual((await assets.listWorkConfigs(business)).workConfigs, []);
  await fs.writeFile(cache, lastValid);
  for (const workConfigs of [
    [{ ...manifest.workConfigs[0]!, skills: ["unknown"] }],
    [{ ...manifest.workConfigs[0]!, skills: ["review", "review"] }],
    [manifest.workConfigs[0], manifest.workConfigs[0]],
  ]) {
    await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify({ ...manifest, workConfigs }));
    await commit(source);
    await assert.rejects(assets.sync(business), { code: "INVALID_ASSET" });
    assert.equal(await fs.readFile(cache, "utf8"), lastValid);
  }
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify({ schemaVersion: 1, skills: manifest.skills }));
  await commit(source);
  await assets.sync(business);
  assert.deepEqual((await assets.listWorkConfigs(business)).workConfigs, []);
  assert.equal((await assets.list(business)).skills.length, 2);
  await assert.rejects(assets.previewWorkConfig(business, "backend"), { code: "WORK_CONFIG_NOT_FOUND" });
  await fs.writeFile(cache, lastValid);
  assert.equal((await assets.listWorkConfigs(business)).workConfigs.length, 2);
  const snapshot = JSON.parse(lastValid);
  snapshot.workConfigs[0].skills = ["missing"];
  await fs.writeFile(cache, JSON.stringify(snapshot));
  await assert.rejects(assets.listWorkConfigs(business), { code: "INVALID_ASSET" });
});

test("persisted work-config references keep shared Skills until the final owner is uninstalled", async (t) => {
  const { service, assets, business, home, synced } = await workConfigFixture(t);
  const concurrent = await Promise.all(["backend", "review-only"].map((id) => cli(home, business, ["work-config", "install", id, "--target", "codex", "--revision", synced.commit])));
  assert.ok(concurrent.every((result) => result.code === 0), JSON.stringify(concurrent));
  await assets.installWorkConfig(business, "backend", "claude", synced.commit);
  const saved = new TeamAssetService(service);
  assert.equal((await saved.installedWorkConfigs(business)).length, 3);
  const status = await saved.workConfigStatus(business, "backend", "codex");
  assert.deepEqual(status.skills.map((skill) => skill.action), ["keep_shared", "backup"]);
  assert.deepEqual(status.skills[0]?.otherConfigs, ["review-only"]);
  await assert.rejects(saved.uninstallWorkConfig(business, "backend", "codex", "0".repeat(40)), { code: "INSTALLATION_CHANGED" });
  assert.equal((await cli(home, business, ["work-config", "status", "backend", "--target", "codex"])).code, 0);
  await service.setTeamEnabled(false);
  assert.equal((await cli(home, business, ["work-config", "installed"])).code, 0);
  const removed = await cli(home, business, ["work-config", "uninstall", "backend", "--target", "codex", "--revision", synced.commit]);
  assert.equal(removed.code, 0, removed.stdout);
  const codex = path.join(business, ".agents", "skills");
  assert.equal(await fs.readFile(path.join(codex, "review", "SKILL.md"), "utf8"), markdown);
  await assert.rejects(fs.access(path.join(codex, "lint")), { code: "ENOENT" });
  await saved.uninstallWorkConfig(business, "review-only", "codex", synced.commit);
  await assert.rejects(fs.access(path.join(codex, "review")), { code: "ENOENT" });
  assert.equal((await saved.backups(business, "review")).backups.length, 1);
  assert.equal(await fs.readFile(path.join(business, ".claude", "skills", "review", "SKILL.md"), "utf8"), markdown);
  assert.equal((await saved.installedWorkConfigs(business)).length, 1);
});

test("legacy individual installs survive group uninstall and all single-Skill mutations enforce active references", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  await assets.install(business, "review", "codex", synced.commit);
  const backup = await assets.uninstall(business, "review", "codex");
  await assets.rollback(business, "review", "codex", path.basename(backup.backupPath), null);
  await assets.installWorkConfig(business, "backend", "codex", synced.commit);
  for (const operation of [
    () => assets.install(business, "review", "codex", synced.commit),
    () => assets.install(business, "review", "codex", synced.commit, undefined, synced.commit),
    () => assets.uninstall(business, "review", "codex"),
    () => assets.rollback(business, "review", "codex", path.basename(backup.backupPath), synced.commit),
  ]) await assert.rejects(operation(), { code: "SKILL_IN_USE" });
  const file = path.join(business, ".agents", "skills", "review", "SKILL.md");
  await fs.appendFile(file, "Personal edit");
  const status = await assets.workConfigStatus(business, "backend", "codex");
  assert.equal(status.skills[0]?.state, "conflict");
  assert.equal(status.skills[0]?.action, "keep_independent");
  await assets.uninstallWorkConfig(business, "backend", "codex", synced.commit);
  assert.match(await fs.readFile(file, "utf8"), /Personal edit/);
  assert.deepEqual(await assets.installedWorkConfigs(business), []);
});

test("group uninstall preflights modified owned content and changed group versions", async (t) => {
  const { assets, business, source, synced } = await workConfigFixture(t);
  await assets.installWorkConfig(business, "backend", "codex", synced.commit);
  const record = path.join(business, ".agentrecall-work-configs.json");
  const before = await fs.readFile(record, "utf8");
  await fs.appendFile(path.join(business, ".agents", "skills", "lint", "SKILL.md"), "Local edit");
  await assert.rejects(assets.uninstallWorkConfig(business, "backend", "codex", synced.commit), { code: "SKILL_CONFLICT" });
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(business, ".agents", "skills", "review", "SKILL.md"), "utf8"), markdown);
  assert.deepEqual((await assets.backups(business, "review")).backups, []);
  await commit(source);
  const next = await assets.sync(business);
  assert.notEqual(next.commit, synced.commit);
  assert.ok((await assets.previewWorkConfig(business, "backend", undefined, "codex")).configurationConflict);
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", next.commit), { code: "WORK_CONFIG_CHANGED" });
  assert.equal(await fs.readFile(record, "utf8"), before);
});

test("ownership write failures undo new installs and restore group removals before reporting failure", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  const rename = syncFs.renameSync;
  const failWrite = () => t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (path.basename(String(destination)) === ".agentrecall-work-configs.json") throw new Error("Synthetic state write failure");
    return rename(source, destination);
  });
  let failure = failWrite();
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), { code: "WORK_CONFIG_INSTALL_FAILED" });
  failure.mock.restore();
  assert.deepEqual(await assets.installedWorkConfigs(business), []);
  await assert.rejects(fs.access(path.join(business, ".agents", "skills", "review")), { code: "ENOENT" });
  await assets.installWorkConfig(business, "backend", "codex", synced.commit);
  const record = path.join(business, ".agentrecall-work-configs.json");
  const before = await fs.readFile(record, "utf8");
  failure = failWrite();
  await assert.rejects(assets.uninstallWorkConfig(business, "backend", "codex", synced.commit), { code: "WORK_CONFIG_UNINSTALL_FAILED" });
  failure.mock.restore();
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(business, ".agents", "skills", "review", "SKILL.md"), "utf8"), markdown);
  assert.ok((await assets.workConfigStatus(business, "backend", "codex")).skills.every((skill) => skill.state === "ready"));
  assert.ok(!(await fs.readdir(business)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.startsWith(".agentrecall-skill-stage-")));
});

test("post-commit cleanup failure preserves durable ownership and allows an idempotent retry", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  const remove = syncFs.rmSync;
  const failure = t.mock.method(syncFs, "rmSync", (...args: Parameters<typeof syncFs.rmSync>) => {
    if (String(args[0]).includes(".agentrecall-skill-stage-")) throw new Error("Synthetic cleanup failure");
    return remove(...args);
  });
  await assert.rejects(assets.installWorkConfig(business, "backend", "codex", synced.commit), (error: unknown) => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, "WORK_CONFIG_RECOVERY_REQUIRED");
    assert.equal(error.details?.recorded, true);
    return true;
  });
  failure.mock.restore();
  assert.ok((await assets.workConfigStatus(business, "backend", "codex")).skills.every((skill) => skill.state === "ready"));
  assert.ok((await assets.installWorkConfig(business, "backend", "codex", synced.commit)).skills.every((skill) => skill.status === "existing"));
  await assets.uninstallWorkConfig(business, "backend", "codex", synced.commit);
  assert.deepEqual(await assets.installedWorkConfigs(business), []);
});

test("failed uninstall recovery preserves ownership and exposes missing Skills for a safe retry", async (t) => {
  const { assets, business, synced } = await workConfigFixture(t);
  await assets.installWorkConfig(business, "backend", "codex", synced.commit);
  const rename = syncFs.renameSync;
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (path.basename(String(source)) === "lint" || String(source).includes(".agentrecall-skill-backups")) throw new Error("Synthetic move failure");
    return rename(source, destination);
  });
  await assert.rejects(assets.uninstallWorkConfig(business, "backend", "codex", synced.commit), { code: "WORK_CONFIG_RECOVERY_REQUIRED" });
  failure.mock.restore();
  assert.deepEqual((await assets.workConfigStatus(business, "backend", "codex")).skills.map((skill) => skill.state), ["missing", "ready"]);
  const backup = (await assets.backups(business, "review")).backups[0]!;
  await assets.uninstallWorkConfig(business, "backend", "codex", synced.commit);
  await assets.rollback(business, "review", "codex", backup.backup, null);
  assert.equal(await fs.readFile(path.join(business, ".agents", "skills", "review", "SKILL.md"), "utf8"), markdown);
  assert.deepEqual(await assets.installedWorkConfigs(business), []);
});

test("corrupt, future, oversized and linked project ownership records fail closed without rewriting data", async (t) => {
  const { assets, business, root, synced } = await workConfigFixture(t);
  const record = path.join(business, ".agentrecall-work-configs.json");
  const empty = '{"schemaVersion":1,"configs":[],"skills":[]}';
  for (const invalid of ['{"schemaVersion":2,"configs":[],"skills":[]}', '{"schemaVersion":1,"configs":[{}],"skills":[]}', "{"]) {
    await fs.writeFile(record, invalid);
    await assert.rejects(assets.installedWorkConfigs(business), { code: "INVALID_WORK_CONFIG_STATE" });
    await assert.rejects(assets.install(business, "review", "codex", synced.commit), { code: "INVALID_WORK_CONFIG_STATE" });
    assert.equal(await fs.readFile(record, "utf8"), invalid);
  }
  await fs.writeFile(record, empty + " ".repeat(1024 * 1024 - Buffer.byteLength(empty)));
  assert.deepEqual(await assets.installedWorkConfigs(business), []);
  await fs.appendFile(record, "中");
  await assert.rejects(assets.installedWorkConfigs(business), { code: "WORK_CONFIG_STATE_TOO_LARGE" });
  await fs.rm(record);
  const outside = path.join(root, "outside-record");
  await fs.mkdir(outside);
  await fs.symlink(outside, record, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assets.installedWorkConfigs(business), { code: "INVALID_WORK_CONFIG_STATE" });
  assert.deepEqual(await fs.readdir(outside), []);
});

async function workConfigUpdateFixture(t: Parameters<typeof fixture>[0], mode: "owned" | "shared" | "independent" = "owned") {
  const state = await workConfigFixture(t);
  if (mode === "independent") await state.assets.install(state.business, "review", "codex", state.synced.commit);
  await state.assets.installWorkConfig(state.business, "backend", "codex", state.synced.commit);
  if (mode === "shared") await state.assets.installWorkConfig(state.business, "review-only", "codex", state.synced.commit);
  await fs.appendFile(path.join(state.source, "skills", "review", "SKILL.md"), "New team instructions\n");
  await fs.mkdir(path.join(state.source, "skills", "verify"), { recursive: true });
  await fs.writeFile(path.join(state.source, "skills", "verify", "SKILL.md"), "---\nname: verify\ndescription: Verify changes\n---\nRun checks.\n");
  state.manifest.skills.push({ id: "verify", path: "skills/verify" });
  state.manifest.workConfigs[0]!.skills = ["review", "verify"];
  await fs.writeFile(path.join(state.source, "agentrecall.json"), JSON.stringify(state.manifest));
  await commit(state.source);
  const next = await state.assets.sync(state.business);
  return { ...state, next, record: path.join(state.business, ".agentrecall-work-configs.json"), installed: path.join(state.business, ".agents", "skills") };
}

test("whole-config update previews all membership changes and commits one concurrent version transition", async (t) => {
  const { assets, business, home, installed, synced, next } = await workConfigUpdateFixture(t);
  const plan = await assets.diffWorkConfig(business, "backend", "codex");
  assert.equal(plan.canUpdate, true);
  assert.equal(plan.fromRevision, synced.commit);
  assert.equal(plan.revision, next.commit);
  assert.deepEqual(plan.changes.map((item) => [item.id, item.membership, item.action]), [
    ["review", "retained", "update"], ["lint", "removed", "backup"], ["verify", "added", "install"],
  ]);
  assert.equal((await cli(home, business, ["work-config", "diff", "backend", "--target", "codex"])).code, 0);
  const attempts = await Promise.all(Array.from({ length: 2 }, () => cli(home, business, [
    "work-config", "update", "backend", "--target", "codex", "--from-revision", synced.commit, "--revision", next.commit,
  ])));
  assert.equal(attempts.filter((attempt) => attempt.code === 0).length, 1, JSON.stringify(attempts));
  assert.ok(attempts.filter((attempt) => attempt.code !== 0).every((attempt) => ["INSTALLATION_CHANGED", "ASSETS_BUSY"].includes(attempt.result.error?.code ?? "")));
  assert.equal(await fs.readFile(path.join(installed, "review", "SKILL.md"), "utf8"), markdown + "New team instructions\n");
  await assert.rejects(fs.access(path.join(installed, "lint")), { code: "ENOENT" });
  await fs.access(path.join(installed, "verify", "SKILL.md"));
  const status = await assets.workConfigStatus(business, "backend", "codex");
  assert.equal(status.revision, next.commit);
  assert.deepEqual(status.skills.map((skill) => [skill.id, skill.state]), [["review", "ready"], ["verify", "ready"]]);
  assert.equal((await assets.backups(business, "review")).backups.length, 1);
  const repeated = await assets.updateWorkConfig(business, "backend", "codex", next.commit, next.commit);
  assert.deepEqual(repeated.effects, []);
  assert.equal((await assets.backups(business, "review")).backups.length, 1);
});

test("updates cannot change shared content but can detach it without affecting the remaining config", async (t) => {
  const { assets, business, source, manifest, installed, record, synced, next } = await workConfigUpdateFixture(t, "shared");
  const before = await fs.readFile(record, "utf8");
  const plan = await assets.diffWorkConfig(business, "backend", "codex");
  assert.equal(plan.canUpdate, false);
  assert.deepEqual(plan.changes[0]?.otherConfigs, ["review-only"]);
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", synced.commit, next.commit), { code: "WORK_CONFIG_UPDATE_CONFLICT" });
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(installed, "review", "SKILL.md"), "utf8"), markdown);
  manifest.workConfigs[0]!.skills = ["verify"];
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify(manifest));
  await commit(source);
  const detached = await assets.sync(business);
  assert.equal((await assets.diffWorkConfig(business, "backend", "codex")).changes[0]?.action, "keep_shared");
  await assets.updateWorkConfig(business, "backend", "codex", synced.commit, detached.commit);
  assert.equal(await fs.readFile(path.join(installed, "review", "SKILL.md"), "utf8"), markdown);
  assert.equal((await assets.workConfigStatus(business, "review-only", "codex")).revision, synced.commit);
});

test("independent content and manual edits block whole-config updates before any write", async (t) => {
  const independent = await workConfigUpdateFixture(t, "independent");
  assert.equal((await independent.assets.diffWorkConfig(independent.business, "backend", "codex")).canUpdate, false);
  await assert.rejects(independent.assets.updateWorkConfig(independent.business, "backend", "codex", independent.synced.commit, independent.next.commit), { code: "WORK_CONFIG_UPDATE_CONFLICT" });
  const owned = await workConfigUpdateFixture(t);
  const before = await fs.readFile(owned.record, "utf8");
  await fs.appendFile(path.join(owned.installed, "lint", "SKILL.md"), "Local change");
  assert.equal((await owned.assets.diffWorkConfig(owned.business, "backend", "codex")).canUpdate, false);
  await assert.rejects(owned.assets.updateWorkConfig(owned.business, "backend", "codex", owned.synced.commit, owned.next.commit), { code: "WORK_CONFIG_UPDATE_CONFLICT" });
  assert.equal(await fs.readFile(owned.record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(owned.installed, "review", "SKILL.md"), "utf8"), markdown);
});

test("metadata failure rolls back replacement, removal and addition together", async (t) => {
  const { assets, business, record, installed, synced, next } = await workConfigUpdateFixture(t);
  const before = await fs.readFile(record, "utf8");
  const rename = syncFs.renameSync;
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (path.basename(String(destination)) === ".agentrecall-work-configs.json") throw new Error("Synthetic metadata failure");
    return rename(source, destination);
  });
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", synced.commit, next.commit), { code: "WORK_CONFIG_UPDATE_FAILED" });
  failure.mock.restore();
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(installed, "review", "SKILL.md"), "utf8"), markdown);
  await fs.access(path.join(installed, "lint", "SKILL.md"));
  await assert.rejects(fs.access(path.join(installed, "verify")), { code: "ENOENT" });
  assert.ok(!(await fs.readdir(business)).some((name) => name.startsWith(".agentrecall-skill-stage-") || name.endsWith(".tmp") || name.endsWith(".lock")));
  await assets.updateWorkConfig(business, "backend", "codex", synced.commit, next.commit);
  assert.equal((await assets.workConfigStatus(business, "backend", "codex")).revision, next.commit);
});

test("incomplete update recovery reports surviving backups and keeps old ownership", async (t) => {
  const { assets, business, record, synced, next } = await workConfigUpdateFixture(t);
  const before = await fs.readFile(record, "utf8");
  const rename = syncFs.renameSync;
  const failure = t.mock.method(syncFs, "renameSync", (source: syncFs.PathLike, destination: syncFs.PathLike) => {
    if (path.basename(String(destination)) === ".agentrecall-work-configs.json" || String(source).includes(".agentrecall-skill-backups")) throw new Error("Synthetic recovery failure");
    return rename(source, destination);
  });
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", synced.commit, next.commit), (error: unknown) => {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, "WORK_CONFIG_RECOVERY_REQUIRED");
    assert.equal(error.details?.recorded, false);
    assert.match(JSON.stringify(error.details), /recovery_required/);
    return true;
  });
  failure.mock.restore();
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.ok((await assets.backups(business, "review")).backups.some((backup) => backup.valid && backup.revision === synced.commit));
  assert.ok((await assets.backups(business, "lint")).backups.some((backup) => backup.valid && backup.revision === synced.commit));
});

test("new references to existing independent Skills preserve ownership on later uninstall", async (t) => {
  const { assets, business, source, manifest, synced } = await workConfigFixture(t);
  await assets.installWorkConfig(business, "review-only", "codex", synced.commit);
  await assets.install(business, "lint", "codex", synced.commit);
  manifest.workConfigs[1]!.skills.push("lint");
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify(manifest));
  await commit(source);
  const next = await assets.sync(business);
  const plan = await assets.diffWorkConfig(business, "review-only", "codex");
  assert.deepEqual(plan.changes.map((change) => change.action), ["reuse", "reuse"]);
  await assets.updateWorkConfig(business, "review-only", "codex", synced.commit, next.commit);
  assert.equal((await assets.workConfigStatus(business, "review-only", "codex")).skills[1]?.action, "keep_independent");
  await assets.uninstallWorkConfig(business, "review-only", "codex", next.commit);
  await fs.access(path.join(business, ".agents", "skills", "lint", "SKILL.md"));
});

test("stale pins and team disable during update staging leave the old group intact", async (t) => {
  const { service, assets, business, record, installed, synced, next } = await workConfigUpdateFixture(t);
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", synced.commit, "0".repeat(40)), { code: "SNAPSHOT_CHANGED" });
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", "0".repeat(40), next.commit), { code: "INSTALLATION_CHANGED" });
  const before = await fs.readFile(record, "utf8");
  const write = syncFs.writeFileSync;
  let disabled = false;
  const change = t.mock.method(syncFs, "writeFileSync", (...args: Parameters<typeof syncFs.writeFileSync>) => {
    const result = write(...args);
    if (!disabled && path.basename(String(args[0])) === ".agentrecall-install.json") {
      disabled = true;
      const config = JSON.parse(syncFs.readFileSync(service.store.filePath, "utf8"));
      write(service.store.filePath, JSON.stringify({ ...config, teamEnabled: false }));
    }
    return result;
  });
  await assert.rejects(assets.updateWorkConfig(business, "backend", "codex", synced.commit, next.commit), { code: "TEAM_DISABLED" });
  change.mock.restore();
  assert.equal(disabled, true);
  assert.equal(await fs.readFile(record, "utf8"), before);
  assert.equal(await fs.readFile(path.join(installed, "review", "SKILL.md"), "utf8"), markdown);
  assert.ok(!(await fs.readdir(business)).some((name) => name.startsWith(".agentrecall-skill-stage-") || name.endsWith(".lock")));
});

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
  await fs.writeFile(path.join(source, "agentrecall.json"), '{"schemaVersion":3,"skills":[]}');
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

test("v3 documents preserve BOM and local content, pin versions and reject unsafe targets", async (t) => {
  const { service, assets, business, source, cache } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const original = await assets.sync(business);
  assert.deepEqual((await assets.list(business)).documents, []);
  const content = "\ufeff# 团队约定\n保留完整内容。\n";
  await fs.writeFile(path.join(source, "AGENTS.md"), content);
  const manifest = { schemaVersion: 3, skills: [{ id: "review", path: "skills/review" }], workConfigs: [], documents: [{ id: "instructions", name: "团队约定", path: "AGENTS.md", target: "AGENTS.md" }] };
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify(manifest));
  await commit(source);
  const synced = await assets.sync(business);
  const preview = await assets.previewDocument(business, "instructions");
  assert.equal(preview.content, content);
  assert.equal(preview.status, "new");
  await assert.rejects(assets.installDocument(business, "instructions", original.commit), { code: "SNAPSHOT_CHANGED" });
  assert.equal((await assets.installDocument(business, "instructions", synced.commit)).status, "installed");
  assert.equal((await assets.installDocument(business, "instructions", synced.commit)).status, "existing");
  await fs.writeFile(path.join(business, "AGENTS.md"), "my local edits");
  assert.equal((await assets.previewDocument(business, "instructions")).status, "conflict");
  await assert.rejects(assets.installDocument(business, "instructions", synced.commit), { code: "DOCUMENT_CONFLICT" });
  assert.equal(await fs.readFile(path.join(business, "AGENTS.md"), "utf8"), "my local edits");
  const snapshot = JSON.parse(await fs.readFile(cache, "utf8"));
  await fs.writeFile(cache, JSON.stringify({ ...snapshot, documents: [{ ...snapshot.documents[0], content: "tampered" }] }));
  await assert.rejects(assets.previewDocument(business, "instructions"), { code: "INVALID_ASSET" });
  for (const target of ["../AGENTS.md", ".github/workflows/build.md", "docs/CON.md", "docs/a.md/../../outside.md"]) {
    await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify({ ...manifest, documents: [{ ...manifest.documents[0], target }] }));
    await commit(source);
    await assert.rejects(assets.sync(business), { code: "INVALID_MANIFEST" });
  }
});

test("documents reject linked parents and invalid UTF-8 while accepting the exact byte limit", async (t) => {
  const { service, assets, business, source, root } = await assetsFixture(t);
  await service.setTeamEnabled(true);
  const manifest = { schemaVersion: 3, skills: [], workConfigs: [], documents: [{ id: "guide", name: "Guide", path: "guide.md", target: "docs/guide.md" }] };
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(source, "guide.md"), "汉".repeat(349525) + "a");
  await commit(source);
  const version = await assets.sync(business);
  assert.equal(Buffer.byteLength((await assets.previewDocument(business, "guide")).content), 1024 * 1024);
  const outside = path.join(root, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(business, "docs"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assets.installDocument(business, "guide", version.commit), { code: "DOCUMENT_CONFLICT" });
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.appendFile(path.join(source, "guide.md"), "汉"); await commit(source);
  await assert.rejects(assets.sync(business));
  await fs.writeFile(path.join(source, "guide.md"), Buffer.from([0xff, 0xfe])); await commit(source);
  await assert.rejects(assets.sync(business), { code: "INVALID_ASSET" });
});
