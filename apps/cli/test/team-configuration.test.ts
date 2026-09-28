import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse as parseToml } from "smol-toml";
import { GitAssetSource, TeamAssetService } from "@agentrecall/workspace-core";
import { configurationFiles, ProjectConfiguration } from "../../../packages/workspace-core/src/project-configuration.js";
import { manifestSchema, MAX_FILE_BYTES, validateSnapshot, type TeamConfiguration } from "../../../packages/workspace-core/src/asset-format.js";
import { execute, fixture, repository } from "./fixtures.js";
const remote = "https://github.com/example/assets";
const configuration: TeamConfiguration = {
  instructions: [{ id: "rules", name: "Review rules", path: "rules.md", content: "Review every change.", digest: "a".repeat(64), targets: ["codex", "claude"] }],
  mcpServers: [
    { id: "review", name: "Review service", transport: "stdio", command: "node", args: ["server.mjs"], env: { TOKEN: { fromEnv: "TOKEN" }, MODE: "team" }, targets: ["codex", "claude"] },
    { id: "docs", name: "Docs service", transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: { fromEnv: "DOCS_AUTH" } }, targets: ["codex", "claude"] },
  ],
  environment: [{ name: "TEAM_MODE", value: "review", targets: ["codex", "claude"] }],
};
const empty: TeamConfiguration = { instructions: [], mcpServers: [], environment: [] };
async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t), folder = path.join(f.root, "work"); await fs.mkdir(folder);
  return { ...f, folder, apply: (config = configuration) => { const store = new ProjectConfiguration(folder); return (["codex", "claude"] as const).flatMap((target) => configurationFiles(config, target).map((desired) => store.apply(desired, remote))); } };
}
test("configuration updates and retires only owned content, preserving personal config and secret references", async (t) => {
  const f = await setup(t); await fs.mkdir(path.join(f.folder, ".codex")); await fs.mkdir(path.join(f.folder, ".claude"));
  const personal = "# Personal rules\r\nKeep my notes exactly.\r\n";
  await fs.writeFile(path.join(f.folder, "AGENTS.md"), personal);
  const toml = '# Personal comment\nmodel = "my-model"\n[mcp_servers.personal]\ncommand = "personal"\n';
  await fs.writeFile(path.join(f.folder, ".codex/config.toml"), toml);
  await fs.writeFile(path.join(f.folder, ".mcp.json"), JSON.stringify({ mcpServers: { personal: { command: "personal" } }, other: [1, 2] }));
  await fs.writeFile(path.join(f.folder, ".claude/settings.json"), JSON.stringify({ env: { PERSONAL: "yes" }, model: "my-model" }));
  assert.ok(f.apply().every((item) => item?.status === "installed"));
  const text = await fs.readFile(path.join(f.folder, ".codex/config.toml"), "utf8");
  assert.ok(text.startsWith(toml)); assert.match(text, /env_vars = \[ "TOKEN" \]/); assert.match(text, /Authorization = "DOCS_AUTH"/); assert.equal(parseToml(text).model, "my-model");
  const mcp = JSON.parse(await fs.readFile(path.join(f.folder, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.review.env.TOKEN, "${TOKEN}"); assert.equal(mcp.mcpServers.docs.type, "http"); assert.deepEqual(mcp.other, [1, 2]); assert.equal(mcp.mcpServers.personal.command, "personal");
  assert.ok(f.apply().every((item) => item?.status === "unchanged"));
  await fs.appendFile(path.join(f.folder, "AGENTS.md"), "\nMy added note.");
  const update = structuredClone(configuration); update.instructions[0]!.content = "New rules."; update.environment[0]!.value = "production";
  assert.ok(f.apply(update).some((item) => item?.status === "updated" && item.backup));
  const instructions = await fs.readFile(path.join(f.folder, "AGENTS.md"), "utf8"); assert.ok(instructions.startsWith(personal)); assert.match(instructions, /My added note/); assert.match(instructions, /New rules/);
  assert.ok(f.apply(empty).every((item) => item?.status === "retired" && item.backup));
  assert.equal(await fs.readFile(path.join(f.folder, "AGENTS.md"), "utf8"), personal + "\nMy added note."); assert.equal(await fs.readFile(path.join(f.folder, ".codex/config.toml"), "utf8"), toml);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.folder, ".claude/settings.json"), "utf8")), { env: { PERSONAL: "yes" }, model: "my-model" });
});

test("local managed edits, unowned matching servers and conflicting TOML tables are retained", async (t) => {
  const f = await setup(t); f.apply();
  const file = path.join(f.folder, "AGENTS.md"), before = (await fs.readFile(file, "utf8")).replace("Review every change.", "My edits."); await fs.writeFile(file, before);
  assert.throws(() => f.apply(), { code: "CONFIGURATION_CONFLICT" }); assert.equal(await fs.readFile(file, "utf8"), before);
  const other = path.join(f.root, "other"); await fs.mkdir(other); await fs.mkdir(path.join(other, ".codex"));
  const toml = '[shell_environment_policy.set]\nPERSONAL="keep"\n'; await fs.writeFile(path.join(other, ".codex/config.toml"), toml);
  assert.throws(() => new ProjectConfiguration(other).apply(configurationFiles(configuration, "codex")[1]!, remote), { code: "CONFIGURATION_CONFLICT" }); assert.equal(await fs.readFile(path.join(other, ".codex/config.toml"), "utf8"), toml);
  const mcp = configurationFiles(configuration, "claude")[1]!;
  await fs.writeFile(path.join(other, ".mcp.json"), JSON.stringify({ mcpServers: { review: mcp.entries![0]!.value } }));
  assert.throws(() => new ProjectConfiguration(other).apply(mcp, remote), { code: "CONFIGURATION_CONFLICT" });
});

test("duplicate JSON keys, case-insensitive personal Env collisions and malformed instruction markers fail closed", async (t) => {
  const f = await setup(t); await fs.mkdir(path.join(f.folder, ".claude"));
  const file = path.join(f.folder, ".claude/settings.json");
  const env = configurationFiles(configuration, "claude")[2]!;
  for (const text of ['{"env":{"personal":"one","personal":"two"}}', '{"env":{"team_mode":"personal"}}']) {
    await fs.writeFile(file, text);
    assert.throws(() => new ProjectConfiguration(f.folder).apply(env, remote), { code: "CONFIGURATION_CONFLICT" });
    assert.equal(await fs.readFile(file, "utf8"), text);
  }
  await fs.writeFile(path.join(f.folder, "AGENTS.md"), "<!-- agentrecall:team begin -->partial");
  assert.throws(() => new ProjectConfiguration(f.folder).apply(configurationFiles(configuration, "codex")[0]!, remote), { code: "CONFIGURATION_CONFLICT" });
});

test("owner record publication failure restores the previous file and allows a retry", async (t) => {
  const f = await setup(t); f.apply(); const file = path.join(f.folder, "AGENTS.md"), original = await fs.readFile(file, "utf8");
  const rename = syncFs.renameSync;
  const mock = t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof rename>) => { if (String(args[1]) === path.join(f.folder, ".agentrecall-configuration.json")) throw new Error("fixture failure"); return rename(...args); });
  const update = structuredClone(configuration); update.instructions[0]!.content = "Update";
  assert.throws(() => f.apply(update), /fixture failure/); assert.equal(await fs.readFile(file, "utf8"), original);
  mock.mock.restore(); assert.equal(f.apply(update)[0]?.status, "updated");
});

test("linked paths, unsupported ownership and complete output byte limits protect local files", async (t) => {
  const f = await setup(t), outside = path.join(f.root, "outside"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.folder, ".codex"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(new ProjectConfiguration(f.folder).apply(configurationFiles(empty, "codex")[1]!, remote), null);
  assert.throws(() => new ProjectConfiguration(f.folder).apply(configurationFiles(configuration, "codex")[1]!, remote), { code: "CONFIGURATION_CONFLICT" }); assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(path.join(f.folder, ".agentrecall-configuration.json"), '{"schemaVersion":99,"files":[]}'); assert.throws(() => new ProjectConfiguration(f.folder), { code: "CONFIGURATION_CONFLICT" }); await fs.unlink(path.join(f.folder, ".agentrecall-configuration.json"));
  const desired = configurationFiles(configuration, "codex")[0]!, file = path.join(f.folder, "AGENTS.md"); await fs.writeFile(file, "a".repeat(MAX_FILE_BYTES));
  assert.throws(() => new ProjectConfiguration(f.folder).apply(desired, remote), { code: "CONFIGURATION_CONFLICT" }); assert.equal((await fs.stat(file)).size, MAX_FILE_BYTES);
  const suffix = "\n<!-- agentrecall:team begin -->\n" + desired.text!.trimEnd() + "\n<!-- agentrecall:team end -->\n";
  await fs.writeFile(file, "a".repeat(MAX_FILE_BYTES - Buffer.byteLength(suffix)));
  assert.equal(new ProjectConfiguration(f.folder).apply(desired, remote)?.status, "installed"); assert.equal((await fs.stat(file)).size, MAX_FILE_BYTES);
  assert.throws(() => new ProjectConfiguration(f.folder).apply({ ...desired, text: desired.text + "汉" }, remote), { code: "CONFIGURATION_CONFLICT" });
});

test("v4 Git assets are validated, listed and distributed with accurate conflicts", async (t) => {
  const f = await setup(t), source = await repository(path.join(f.root, "assets"));
  const { content, digest: _digest, ...entry } = configuration.instructions[0]!;
  const manifest = { schemaVersion: 4, skills: [], workConfigs: [], documents: [], ...configuration, instructions: [entry] };
  await fs.writeFile(path.join(source, "rules.md"), content); await fs.writeFile(path.join(source, "agentrecall.json"), JSON.stringify(manifest)); await execute("git", ["-C", source, "add", "."]); await execute("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "asset"]);
  await f.service.store.initialize(); await f.service.addTeam({ id: "team", repository: remote }); await f.service.setTeamEnabled(true); await f.service.connectDirectory("team", f.folder, ["codex", "claude"]);
  const sourceAdapter = new GitAssetSource(async (_url, destination) => { await execute("git", ["clone", "--bare", "--no-hardlinks", "--", source, destination]); });
  const service = new TeamAssetService(f.service, sourceAdapter, { teamId: "team", repository: remote });
  const initial = await service.pull(f.root); assert.equal(initial.status, "complete"); assert.equal(initial.schemaVersion, 2); assert.equal((await service.list(f.root)).configuration.instructions[0]!.content, content);
  const local = path.join(f.folder, ".mcp.json"), json = JSON.parse(await fs.readFile(local, "utf8")); json.mcpServers.review.command = "personal-edit"; await fs.writeFile(local, JSON.stringify(json));
  const partial = await service.pull(f.root); assert.equal(partial.status, "partial"); assert.ok(partial.directories[0]!.items.some((item) => item.kind === "mcp" && item.status === "conflict")); assert.equal((await service.pullStatus("team"))!.status, "partial");
  const snapshot = await sourceAdapter.load(remote, await fs.mkdtemp(path.join(f.root, "snapshot-")), "https");
  assert.throws(() => validateSnapshot({ ...snapshot, documents: [{ id: "duplicate", name: "Dup", path: "rules.md", target: "AGENTS.md", content, digest: snapshot.schemaVersion === 4 ? snapshot.instructions[0]!.digest : "" }] }, remote), { code: "INVALID_ASSET" });
  assert.equal(manifestSchema.safeParse({ ...manifest, mcpServers: [{ ...configuration.mcpServers[0], env: { TOKEN: { fromEnv: "OTHER" } } }] }).success, false);
  assert.equal(manifestSchema.safeParse({ ...manifest, environment: [{ name: "KEY", value: "${SECRET}" }] }).success, false);
});
