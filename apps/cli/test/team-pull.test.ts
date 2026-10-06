import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import test from "node:test";
import { GitAssetSource, TeamAssetService } from "@agentrecall/workspace-core";
import { MAX_PULL_REPORT_BYTES, validatePullReport } from "../../../packages/workspace-core/src/team-pull.js";
import { ProjectDocuments } from "../../../packages/workspace-core/src/project-documents.js";
import { execute, fixture, repository, cli } from "./fixtures.js";
const markdown = "---\nname: review\ndescription: Review code changes\n---\nVersion one.\n";
async function commit(source: string) { await execute("git", ["-C", source, "add", "."]); await execute("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "asset"]); }
async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t), source = await repository(path.join(f.root, "assets"));
  await fs.mkdir(path.join(source, "skills", "review"), { recursive: true });
  await fs.writeFile(path.join(source, "skills", "review", "SKILL.md"), markdown);
  const documents = ["AGENTS.md", "CLAUDE.md", "docs/guide.md"].map((target, index) => ({ id: "doc-" + index, name: target, path: target, target }));
  await fs.mkdir(path.join(source, "docs"));
  for (const doc of documents) await fs.writeFile(path.join(source, doc.path), "Original " + doc.id);
  await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify({ schemaVersion: 3, skills: [{ id: "review", path: "skills/review" }], workConfigs: [], documents })); await commit(source);
  await f.service.store.initialize(); await f.service.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await f.service.setTeamEnabled(true);
  const folders = ["first", "second", "disabled"].map((name) => path.join(f.root, name));
  for (const [index, folder] of folders.entries()) { await fs.mkdir(folder); await f.service.connectDirectory("team", folder, [index === 1 ? "claude" : "codex"]); }
  const dirs = (await f.service.store.read())!.directories!;
  await f.service.updateDirectory("team", dirs[2]!.id, dirs[2]!.path, { enabled: false, targets: ["codex"] });
  const clone = async (_repo: string, destination: string) => { await execute("git", ["clone", "--bare", "--no-hardlinks", "--", source, destination]); };
  const assets = new TeamAssetService(f.service, new GitAssetSource(clone), { teamId: "team", repository: "https://github.com/example/assets" });
  return { ...f, source, folders, dirs, assets, documents };
}

test("pull installs, updates and retires managed assets in all enabled directories, retaining personal files", async (t) => {
  const f = await setup(t), [first, second, disabled] = f.folders as [string, string, string];
  const initial = await f.assets.pull(f.root);
  assert.equal(initial.status, "complete"); assert.equal(initial.directories[2]!.status, "skipped");
  assert.equal(await fs.readFile(path.join(first, ".agents/skills/review/SKILL.md"), "utf8"), markdown);
  assert.equal(await fs.readFile(path.join(second, ".claude/skills/review/SKILL.md"), "utf8"), markdown);
  await assert.rejects(fs.access(path.join(first, "CLAUDE.md")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(second, "AGENTS.md")), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(disabled), []);
  const again = await f.assets.pull(f.root); assert.ok(again.directories[0]!.items.every((item) => item.status === "unchanged"));
  await fs.appendFile(path.join(f.source, "skills/review/SKILL.md"), "Version two.\n");
  await fs.writeFile(path.join(f.source, "docs/guide.md"), "Updated guide"); await commit(f.source);
  await fs.appendFile(path.join(second, ".claude/skills/review/SKILL.md"), "Local edit");
  const partial = await f.assets.pull(f.root); assert.equal(partial.status, "partial");
  assert.ok(partial.directories[0]!.items.some((item) => item.status === "updated" && item.backup));
  assert.ok(partial.directories[1]!.items.some((item) => item.status === "conflict"));
  assert.match(await fs.readFile(path.join(second, ".claude/skills/review/SKILL.md"), "utf8"), /Local edit/);
  assert.equal(await fs.readFile(path.join(first, "docs/guide.md"), "utf8"), "Updated guide");
  assert.equal((await f.assets.pullStatus("team"))!.status, "partial");
  await fs.writeFile(path.join(second, ".claude/skills/review/SKILL.md"), markdown);
  assert.equal((await f.assets.pull(f.root)).status, "complete");
  await fs.mkdir(path.join(first, ".agents/skills/personal")); await fs.writeFile(path.join(first, ".agents/skills/personal/SKILL.md"), "personal");
  await fs.writeFile(path.join(f.source, "agentrecall.json"), JSON.stringify({ schemaVersion: 3, skills: [], workConfigs: [], documents: [] })); await commit(f.source);
  const retired = await f.assets.pull(f.root); assert.equal(retired.status, "complete");
  assert.ok(retired.directories[0]!.items.every((item) => item.status === "retired" && item.backup));
  await assert.rejects(fs.access(path.join(first, ".agents/skills/review")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(first, "docs/guide.md")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(first, ".agents/skills/personal/SKILL.md"), "utf8"), "personal");
});

test("pull does not adopt matching unowned documents and preserves conflicts without blocking other directories", async (t) => {
  const f = await setup(t), first = f.folders[0]!;
  await fs.writeFile(path.join(first, "AGENTS.md"), "Original doc-0");
  assert.equal((await f.assets.pull(f.root)).status, "complete");
  const state = JSON.parse(await fs.readFile(path.join(first, ".agentrecall-documents.json"), "utf8"));
  assert.ok(!state.documents.some((item: { target: string }) => item.target === "AGENTS.md"));
  await fs.writeFile(path.join(f.source, "AGENTS.md"), "new instructions"); await fs.writeFile(path.join(f.source, "docs/guide.md"), "new guide"); await commit(f.source);
  const result = await f.assets.pull(f.root); assert.equal(result.status, "partial");
  assert.equal(await fs.readFile(path.join(first, "AGENTS.md"), "utf8"), "Original doc-0");
  assert.equal(await fs.readFile(path.join(f.folders[1]!, "docs/guide.md"), "utf8"), "new guide");
});

test("document record failure restores old file and ownership; retry succeeds", async (t) => {
  const f = await setup(t); await f.assets.pull(f.root);
  await fs.writeFile(path.join(f.source, "docs/guide.md"), "new guide"); await commit(f.source);
  const original = syncFs.renameSync;
  const mocked = t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof syncFs.renameSync>) => {
    const [from, to] = args;
    if (String(to) === path.join(f.dirs[0]!.path, ".agentrecall-documents.json")) throw Object.assign(new Error("fixture write failure"), { code: "EACCES" });
    return original(from, to);
  });
  assert.equal((await f.assets.pull(f.root)).status, "partial");
  assert.equal(await fs.readFile(path.join(f.folders[0]!, "docs/guide.md"), "utf8"), "Original doc-2");
  mocked.mock.restore();
  assert.equal((await f.assets.pull(f.root)).status, "complete");
  assert.equal(await fs.readFile(path.join(f.folders[0]!, "docs/guide.md"), "utf8"), "new guide");
});

test("cancellation preserves completed writes, skips following directories and records the partial result", async (t) => {
  const f = await setup(t), controller = new AbortController();
  const apply = ProjectDocuments.prototype.apply;
  t.mock.method(ProjectDocuments.prototype, "apply", function(this: ProjectDocuments, ...args: Parameters<typeof apply>) { const result = apply.apply(this, args); controller.abort(); return result; });
  const report = await f.assets.pull(f.root, undefined, undefined, controller.signal);
  assert.equal(report.status, "cancelled"); assert.equal(report.directories[1]!.status, "cancelled");
  assert.equal(await fs.readFile(path.join(f.folders[0]!, "AGENTS.md"), "utf8"), "Original doc-0");
  assert.deepEqual(await fs.readdir(f.folders[1]!), []);
  assert.equal((await f.assets.pullStatus("team"))!.status, "cancelled");
});

test("team transport is persisted without losing v3 directory or legacy project records", async (t) => {
  const f = await setup(t), before = (await f.service.store.read())!;
  await f.service.setTeamTransport("team", "ssh"); const after = (await f.service.store.read())!;
  assert.equal(after.schemaVersion, 4); assert.equal(after.teams[0]!.transport, "ssh");
  assert.deepEqual(after.directories, before.directories); assert.deepEqual(after.projects, before.projects);
  assert.equal((await cli(f.home, f.root, ["team", "transport", "team", "--transport", "https"])).code, 0);
  assert.equal((await f.service.store.read())!.teams[0]!.transport, "https");
  const empty = new TeamAssetService(f.service, new GitAssetSource(async (_url, dest) => { await execute("git", ["clone", "--bare", "--no-hardlinks", "--", f.source, dest]); }), { teamId: "team", repository: "https://github.com/example/assets" });
  await f.service.store.update((current) => ({ ...current, directories: [] }));
  assert.equal((await empty.pull(f.root)).status, "no-directories");
});

test("linked document paths and corrupt ownership records fail without writing outside or overwriting old assets", async (t) => {
  const f = await setup(t), first = f.folders[0]!;
  const outside = path.join(f.root, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(first, "docs"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.assets.pull(f.root)).status, "partial");
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(path.join(first, ".agentrecall-documents.json"), JSON.stringify({ schemaVersion: 99, documents: [] }));
  await fs.appendFile(path.join(f.source, "skills/review/SKILL.md"), "upstream update"); await commit(f.source);
  const report = await f.assets.pull(f.root);
  assert.equal(report.status, "partial");
  assert.equal(await fs.readFile(path.join(first, ".agents/skills/review/SKILL.md"), "utf8"), markdown);
  assert.match(await fs.readFile(path.join(f.folders[1]!, ".claude/skills/review/SKILL.md"), "utf8"), /upstream update/);
});


test("sync reports enforce the full serialized byte limit including escaping and multibyte metadata", () => {
  const report = { schemaVersion: 1, repository: "https://github.com/example/assets", commit: "1".repeat(40), startedAt: 1, finishedAt: 2, status: "complete", directories: [] as Array<{ id: string; path: string; status: string; items: Array<{ kind: string; id: string; status: string; message: string }> }> };
  assert.equal(validatePullReport(report).directories.length, 0);
  const item = { kind: "skill", id: "review", status: "failed", message: "\u0001".repeat(500) };
  function fill(count: number) { report.directories = Array.from({ length: Math.ceil(count / 512) }, (_, index) => ({ id: "directory-" + index, path: "/", status: "partial", items: Array.from({ length: Math.min(512, count - index * 512) }, () => item) })); }
  let low = 1, high = 32 * 512;
  while (low < high) { const middle = Math.ceil((low + high) / 2); fill(middle); if (Buffer.byteLength(JSON.stringify(report)) <= MAX_PULL_REPORT_BYTES) low = middle; else high = middle - 1; }
  fill(low); report.directories[0]!.path += "x".repeat(MAX_PULL_REPORT_BYTES - Buffer.byteLength(JSON.stringify(report)));
  assert.equal(Buffer.byteLength(JSON.stringify(report)), MAX_PULL_REPORT_BYTES);
  assert.equal(validatePullReport(report).directories.length, report.directories.length);
  report.directories[0]!.path += "汉";
  assert.throws(() => validatePullReport(report), { code: "PULL_REPORT_TOO_LARGE" });
});

test("v5 classification does not relocate installed Skills or omit configuration distribution", async t => {
  const f = await setup(t);
  const manifestFile = path.join(f.source, "agentrecall.json");
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, schemaVersion: 5, instructions: [], mcpServers: [], environment: [{ name: "TEAM_MODE", value: "review", targets: ["codex"] }], organization: [{ id: "skills", name: "Skill folders", folders: ["Frontend"], assignments: [{ resourceId: "review", folder: "Frontend" }] }] }));
  await commit(f.source);
  const result = await f.assets.pull(f.root);
  assert.equal(result.status, "complete");
  assert.equal(await fs.readFile(path.join(f.folders[0]!, ".agents/skills/review/SKILL.md"), "utf8"), markdown);
  assert.match(await fs.readFile(path.join(f.folders[0]!, ".codex/config.toml"), "utf8"), /TEAM_MODE/);
  await assert.rejects(fs.access(path.join(f.folders[0]!, ".agents/skills/Frontend")), { code: "ENOENT" });
});
