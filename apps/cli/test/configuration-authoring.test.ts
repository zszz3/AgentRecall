import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { GitAssetSource, TeamAssetService, WorkspaceError, configurationChangeSchema, type ConfigurationChange } from "@agentrecall/workspace-core";
import { execute, fixture, repository } from "./fixtures.js";
const url = "https://github.com/example/assets";
const env: ConfigurationChange = { kind: "environment", operation: "create", value: { name: "TEAM_MODE", value: "review", targets: ["codex", "claude"] } };
async function head(remote: string) { return (await execute("git", ["-C", remote, "rev-parse", "HEAD"])).stdout.trim(); }
async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t), remote = path.join(f.root, "remote.git"), seed = await repository(path.join(f.root, "seed"));
  await execute("git", ["init", "--bare", "-q", "--initial-branch=assets", remote]);
  await fs.writeFile(path.join(seed, "agentrecall.json"), JSON.stringify({ schemaVersion: 2, skills: [], workConfigs: [] }));
  await fs.writeFile(path.join(seed, "README.md"), "Unrelated repository content\n");
  const push = async () => {
    await execute("git", ["-C", seed, "add", "."]);
    await execute("git", ["-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "asset"]);
    await execute("git", ["-C", seed, "push", remote, "HEAD:refs/heads/assets"]);
  };
  await push();
  const source = new GitAssetSource(async (_url, destination) => { await execute("git", ["clone", "--bare", "--no-hardlinks", remote, destination]); });
  await f.service.store.initialize(); await f.service.addTeam({ id: "team", repository: url }); await f.service.setTeamEnabled(true);
  const assets = new TeamAssetService(f.service, source, { teamId: "team", repository: url });
  await assets.sync(f.root);
  return { ...f, remote, seed, source, assets, push };
}

test("previews and publishes Env, MCP and instructions without touching local directories or unrelated Git files", async (t) => {
  const f = await setup(t), original = await head(f.remote);
  const local = path.join(f.root, "local"); await fs.mkdir(local); await fs.writeFile(path.join(local, ".env"), "PRIVATE_FIXTURE=never-upload\n");
  await f.service.connectDirectory("team", local, ["codex"]);
  const changes: ConfigurationChange[] = [env,
    { kind: "mcp", operation: "create", value: { id: "docs", name: "Docs", targets: ["codex", "claude"], transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "LOCAL_DOCS_AUTH" } } } },
    { kind: "instructions", operation: "create", value: { id: "review", name: "Review", targets: ["codex"], content: "Review the diff.\n" } },
  ];
  let current = original;
  for (const change of changes) {
    const preview = await f.assets.previewConfiguration(f.root, current, change);
    assert.equal(preview.branch, "assets"); assert.equal(await head(f.remote), current);
    assert.ok(preview.files.some(file => file.path === "agentrecall.json"));
    const result = await f.assets.publishConfiguration(f.root, preview, change);
    assert.equal(result.cacheUpdated, true); assert.equal(result.cleanupRequired, false);
    assert.equal(result.commit, await head(f.remote));
    assert.equal((await execute("git", ["-C", f.remote, "rev-parse", "HEAD^"])).stdout.trim(), current);
    current = result.commit;
  }
  const listed = await f.assets.list(f.root);
  assert.equal(listed.configuration.environment[0]!.value, "review");
  assert.equal(listed.configuration.instructions[0]!.content, "Review the diff.\n");
  assert.equal((await execute("git", ["-C", f.remote, "show", "HEAD:README.md"])).stdout, "Unrelated repository content\n");
  assert.match((await execute("git", ["-C", f.remote, "show", "HEAD:agentrecall.json"])).stdout, /"fromEnv": "LOCAL_DOCS_AUTH"/);
  assert.deepEqual(await fs.readdir(local), [".env"]);
  assert.deepEqual(await fs.readdir(path.join(f.home, "configuration-edits")), []);
  const edit: ConfigurationChange = { ...env, operation: "update", value: { ...env.value, value: "development" } };
  await f.assets.publishConfiguration(f.root, await f.assets.previewConfiguration(f.root, current, edit), edit);
  assert.equal((await f.assets.list(f.root)).configuration.environment[0]!.value, "development");
  await assert.rejects(f.assets.previewConfiguration(f.root, await head(f.remote), edit), { code: "NO_CONFIGURATION_CHANGE" });
});

test("stale previews and a race immediately before push retain the other member's commit", async (t) => {
  const f = await setup(t), before = await head(f.remote), preview = await f.assets.previewConfiguration(f.root, before, env);
  const scratch = await fs.mkdtemp(path.join(f.root, "prepared-"));
  const prepared = await f.source.prepareConfiguration(url, scratch, "https", env, before);
  await fs.appendFile(path.join(f.seed, "README.md"), "Another member's edit\n"); await f.push();
  const other = await head(f.remote);
  await assert.rejects(prepared.publish(() => undefined), { code: "ASSET_REVISION_CHANGED" });
  await assert.rejects(f.assets.publishConfiguration(f.root, preview, env), { code: "ASSET_REVISION_CHANGED" });
  assert.equal(await head(f.remote), other);
});

test("rejects malformed changes, modified previews, occupied instruction files and cancelled or disabled publication", async (t) => {
  const f = await setup(t), before = await head(f.remote);
  await assert.rejects(f.assets.previewConfiguration(f.root, before, { ...env, value: { ...env.value, value: "${SECRET}" } }), { code: "INVALID_CONFIGURATION_CHANGE" });
  assert.equal(configurationChangeSchema.safeParse({ kind: "mcp", operation: "create", value: { id: "invalid", name: "Invalid", transport: "http", url: "not a URL", targets: ["codex"], headers: {} } }).success, false);
  const preview = await f.assets.previewConfiguration(f.root, before, env);
  await assert.rejects(f.assets.publishConfiguration(f.root, { ...preview, name: "tampered" }, env), { code: "CONFIGURATION_PREVIEW_CHANGED" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.assets.publishConfiguration(f.root, preview, env, undefined, abort.signal), { code: "CANCELLED" });
  await f.service.setTeamEnabled(false);
  await assert.rejects(f.assets.publishConfiguration(f.root, preview, env), { code: "TEAM_DISABLED" });
  await f.service.setTeamEnabled(true);
  await fs.mkdir(path.join(f.seed, "rules")); await fs.writeFile(path.join(f.seed, "rules", "review.md"), "Unowned file\n"); await f.push();
  await assert.rejects(f.assets.previewConfiguration(f.root, await head(f.remote), { kind: "instructions", operation: "create", value: { id: "review", name: "Review", targets: ["codex"], content: "replace" } }), { code: "CONFIGURATION_FILE_CONFLICT" });
  assert.equal((await execute("git", ["-C", f.remote, "show", "HEAD:rules/review.md"])).stdout, "Unowned file\n");
});

test("reports a committed publication when local cache saving fails and sync recovers it", async (t) => {
  const f = await setup(t), before = await head(f.remote), preview = await f.assets.previewConfiguration(f.root, before, env);
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).includes(".published-")) throw new Error("fixture cache failure");
    return open(...args);
  });
  const result = await f.assets.publishConfiguration(f.root, preview, env);
  assert.equal(result.cacheUpdated, false); assert.equal(result.commit, await head(f.remote)); assert.notEqual(result.commit, before);
  mocked.mock.restore(); await f.assets.sync(f.root);
  assert.equal((await f.assets.list(f.root)).configuration.environment[0]!.value, "review");
});


test("bounds complete instruction bytes and serialized previews, leaving the remote unchanged", async (t) => {
  const f = await setup(t), before = await head(f.remote);
  const content = "汉".repeat(Math.floor(1024 * 1024 / 3)) + "x";
  const change: ConfigurationChange = { kind: "instructions", operation: "create", value: { id: "limit", name: "Limits", targets: ["codex"], content } };
  assert.equal(Buffer.byteLength(content), 1024 * 1024);
  assert.equal(configurationChangeSchema.safeParse(change).success, true);
  assert.equal(configurationChangeSchema.safeParse({ ...change, value: { ...change.value, content: "\uD800" } }).success, false);
  assert.equal(configurationChangeSchema.safeParse({ ...change, value: { ...change.value, content: content + "x" } }).success, false);
  const exact = await f.assets.previewConfiguration(f.root, before, change);
  assert.equal(exact.files.find(file => file.path === "rules/limit.md")!.after, content);
  await assert.rejects(f.assets.previewConfiguration(f.root, before, { ...change, value: { ...change.value, content: "\u0001".repeat(1024 * 1024) } }), { code: "ASSETS_TOO_LARGE" });
  assert.equal(await head(f.remote), before);
});

test("retains an explicit published result if scratch cleanup fails after the push", async (t) => {
  const f = await setup(t), preview = await f.assets.previewConfiguration(f.root, await head(f.remote), env);
  const remove = fs.rm;
  const mocked = t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).includes("configuration-edits") && path.basename(String(args[0])).startsWith(".edit-")) throw new Error("fixture cleanup failure");
    return remove(...args);
  });
  await assert.rejects(f.assets.publishConfiguration(f.root, preview, env), error => error instanceof WorkspaceError && error.code === "CONFIGURATION_CLEANUP_REQUIRED" && error.details?.published === true);
  mocked.mock.restore();
  assert.notEqual(await head(f.remote), preview.revision);
  assert.equal((await f.assets.list(f.root)).configuration.environment[0]!.value, "review");
});


test("compares the preview revision atomically even if the remote rewinds immediately before push", async (t) => {
  const f = await setup(t), before = await head(f.remote);
  const ancestor = (await execute("git", ["-C", f.remote, "rev-parse", "HEAD^"])).stdout.trim();
  const prepared = await f.source.prepareConfiguration(url, await fs.mkdtemp(path.join(f.root, "race-")), "https", env, before);
  await assert.rejects(prepared.publish(() => { execFileSync("git", ["-C", f.remote, "update-ref", "refs/heads/assets", ancestor, before]); }), { code: "ASSET_PUBLISH_UNCONFIRMED" });
  assert.equal(await head(f.remote), ancestor);
});

test("pushes selected Skill and document items atomically, with file additions, removals, binary bytes and modes in Diff", async t => {
  const f = await setup(t);
  const file = (path: string, content: string | Buffer, executable = false) => ({ path, content: Buffer.from(content).toString("base64"), executable });
  const markdown = "---\nname: review\ndescription: Review changes\n---\nReview carefully.\n";
  const create: import("@agentrecall/workspace-core").AssetChange = { kind: "batch", operation: "update", value: { name: "Selected items", changes: [
    { kind: "skills", operation: "create", value: { id: "review", name: "review", files: [file("SKILL.md", markdown), file("scripts/old.sh", "exit 0\n", true), file("icon.bin", Buffer.from([0, 255, 4]))] } },
    { kind: "documents", operation: "create", value: { id: "guide", name: "Guide", target: "docs/team/guide.md", content: "# Before\n" } },
  ] } };
  const original = await head(f.remote), preview = await f.assets.previewConfiguration(f.root, original, create);
  assert.equal(await head(f.remote), original);
  assert.deepEqual(preview.items!.map(item => [item.key, item.status]), [["skills:review", "added"], ["documents:guide", "added"]]);
  const published = await f.assets.publishConfiguration(f.root, preview, create);
  const commit = published.commit;
  assert.equal((await execute("git", ["-C", f.remote, "rev-parse", "HEAD^"])).stdout.trim(), original);
  assert.equal((await execute("git", ["-C", f.remote, "show", "HEAD:README.md"])).stdout, "Unrelated repository content\n");
  const update: import("@agentrecall/workspace-core").AssetChange = { kind: "batch", operation: "update", value: { name: "Selected items", changes: [
    { kind: "skills", operation: "update", value: { id: "review", name: "review", files: [file("SKILL.md", markdown + "Run checks.\n"), file("scripts/new.sh", "exit 1\n", true), file("icon.bin", Buffer.from([0, 255, 5]))] } },
    { kind: "documents", operation: "update", value: { id: "guide", name: "Guide", target: "docs/team/guide.md", content: "# Before\n" } },
  ] } };
  const diff = await f.assets.previewConfiguration(f.root, commit, update);
  assert.deepEqual(diff.items!.map(item => item.status), ["modified", "unchanged"]);
  assert.equal(diff.files.find(item => item.path === "skills/review/scripts/old.sh")!.after, null);
  assert.equal(diff.files.find(item => item.path === "skills/review/scripts/new.sh")!.executable, true);
  await f.assets.publishConfiguration(f.root, diff, update);
  const scratch = path.join(f.root, "verify-push"); await fs.mkdir(scratch);
  const snapshot = await f.source.load(url, scratch, "https");
  assert.deepEqual(snapshot.skills[0]!.files.map(item => item.path).sort(), ["SKILL.md", "icon.bin", "scripts/new.sh"]);
  assert.deepEqual(Buffer.from(snapshot.skills[0]!.files.find(item => item.path === "icon.bin")!.content, "base64"), Buffer.from([0, 255, 5]));
  assert.equal(snapshot.skills[0]!.files.find(item => item.path === "scripts/new.sh")!.executable, true);
  await assert.rejects(f.assets.previewConfiguration(f.root, await head(f.remote), update), { code: "NO_CONFIGURATION_CHANGE" });
});

test("rejects duplicate push destinations and existing unowned files before a batch can publish", async t => {
  const f = await setup(t), before = await head(f.remote);
  const document: import("@agentrecall/workspace-core").AssetChange = { kind: "documents", operation: "create", value: { id: "guide", name: "Guide", target: "docs/team/guide.md", content: "Guide" } };
  await assert.rejects(f.assets.previewConfiguration(f.root, before, { kind: "batch", operation: "update", value: { name: "Duplicates", changes: [document, document] } }), { code: "INVALID_CONFIGURATION_CHANGE" });
  await fs.mkdir(path.join(f.seed, "docs")); await fs.writeFile(path.join(f.seed, "docs", "guide.md"), "Unowned\n"); await f.push();
  const current = await head(f.remote);
  await assert.rejects(f.assets.previewConfiguration(f.root, current, document), { code: "CONFIGURATION_FILE_CONFLICT" });
  assert.equal(await head(f.remote), current);
});
