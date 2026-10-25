import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { GitAssetSource, TeamAssetService, WorkspaceService, WorkspaceError } from "@agentrecall/workspace-core";
import { TeamPushService } from "./team-push-service";
import { TeamSessionSharing } from "./team-session-sharing";
import type { TeamPushItem } from "../../shared/team-push";
import type { SessionTurnDetail } from "../../core/types";
let root: string, service: TeamPushService, workspace: WorkspaceService;
const scope = { teamId: "team", repository: "https://github.com/example/assets" }, revision = "1".repeat(40);
const config: TeamPushItem = { key: "env", kind: "configuration", change: { kind: "environment", operation: "create", value: { name: "TEAM_MODE", value: "review", targets: ["codex"] } } };
const turn: SessionTurnDetail = { id: "turn-one", turnIndex: 0, sourceMessageIndex: 0, synthetic: false, status: "completed", startedAt: null, endedAt: null, userPreview: "Selected question", assistantPreview: "", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, errorCount: 0, toolNames: [], messageCount: 1, spanCount: 0, messages: [{ role: "user", messageIndex: 0, sourceMessageIndex: 0, content: "Selected question", timestamp: "" }], spans: [] };
const turns: TeamPushItem[] = [{ key: "turn-1", kind: "turn", sessionKey: "one", turnId: turn.id }];
const confirm = vi.fn(async () => true);
let publishAsset: MockInstance<TeamAssetService["publishConfiguration"]>, publishSession: MockInstance<TeamSessionSharing["publish"]>;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "push-plan-"));
  workspace = new WorkspaceService(root); await workspace.store.initialize(); await workspace.addTeam({ id: scope.teamId, repository: scope.repository }); await workspace.setTeamEnabled(true);
  confirm.mockReset().mockResolvedValue(true);
  vi.spyOn(TeamAssetService.prototype, "list").mockResolvedValue({ teamId: "team", repository: scope.repository, commit: revision, skills: [], documents: [], configuration: { instructions: [], mcpServers: [], environment: [] }, workConfigs: [], organization: [], agentRoles: [], workflowTemplates: [], outcomes: [] });
  vi.spyOn(TeamAssetService.prototype, "previewConfiguration").mockImplementation(async (_directory, _revision, change) => ({ repository: scope.repository, revision, branch: "main", kind: change.kind, operation: change.operation, name: change.value.name, files: [], items: [{ key: "environment:TEAM_MODE", name: "TEAM_MODE", status: "added", files: [{ path: "agentrecall.json", before: null, after: JSON.stringify(change) }] }] }));
  publishAsset = vi.spyOn(TeamAssetService.prototype, "publishConfiguration").mockResolvedValue({ repository: scope.repository, commit: "2".repeat(40), cacheUpdated: true, cleanupRequired: false });
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), getSessionTurn: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), save: vi.fn(), confirm });
  vi.spyOn(sharing, "prepare").mockResolvedValue({ token: "session-token", expiresAt: Date.now() + 600000, repository: scope.repository, projectIdentity: "team:shared", root: { schemaVersion: 2, exportedAt: 1, session: { sessionKey: "one", displayTitle: "One", originalTitle: "One", source: "codex-cli" }, messages: [], traceEvents: [] }, selectedTurns: [turn], bytes: 200, children: [], files: [], missingAttachments: [] });
  publishSession = vi.spyOn(sharing, "publish").mockImplementation(async (owner, _context, _token, _signal, validate, confirmed) => { await validate(); expect(await confirmed!(owner, "fixture")).toBe(true); return { localReady: true, id: 1, title: "One", author: "fixture", createdAt: "", bytes: 200, digest: "1".repeat(64), canWithdraw: true }; });
  service = new TeamPushService(root, confirm, sharing);
});
afterEach(async () => { service.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
it("previews only checked items, owns tokens by window, and confirms once before publishing retained content", async () => {
  const item = structuredClone(config), preview = await service.preview(7, scope, revision, [item, ...turns], new AbortController().signal);
  expect(preview.items.map(item => item.key)).toEqual(["env", "turn-1"]);
  expect(preview.items[1]!.session?.selectedTurns).toEqual([turn]);
  expect(publishAsset).not.toHaveBeenCalled(); expect(publishSession).not.toHaveBeenCalled();
  if (item.kind === "configuration" && item.change.kind === "environment") item.change.value.value = "changed-after-preview";
  await expect(service.publish(8, scope, preview.token, new AbortController().signal)).rejects.toMatchObject({ code: "PUSH_PREVIEW_EXPIRED" });
  const result = await service.publish(7, scope, preview.token, new AbortController().signal);
  expect(result.items.map(item => item.status)).toEqual(["published", "published"]); expect(confirm).toHaveBeenCalledOnce();
  expect(publishAsset.mock.calls[0]![2]).toMatchObject({ value: { value: "review" } });
  await expect(service.publish(7, scope, preview.token, new AbortController().signal)).rejects.toMatchObject({ code: "PUSH_PREVIEW_EXPIRED" });
});
it("retains per-item failures while preserving successes and does not publish after cancellation", async () => {
  const preview = await service.preview(7, scope, revision, [config, ...turns], new AbortController().signal);
  publishSession.mockRejectedValue(new WorkspaceError("TEAM_GITHUB_ACCESS", "fixture upload failed"));
  expect(await service.publish(7, scope, preview.token, new AbortController().signal)).toEqual({ items: [{ key: "env", status: "published" }, { key: "turn-1", status: "failed", message: "fixture upload failed" }] });
  const next = await service.preview(7, scope, revision, [config], new AbortController().signal);
  confirm.mockResolvedValue(false);
  expect((await service.publish(7, scope, next.token, new AbortController().signal)).items[0]!.status).toBe("cancelled");
  expect(publishAsset).toHaveBeenCalledTimes(1);
  service.cancel(7);
  await expect(service.publish(7, scope, next.token, new AbortController().signal)).rejects.toMatchObject({ code: "PUSH_PREVIEW_EXPIRED" });
});
it("checks duplicate resources and team changes and skips unchanged resources", async () => {
  await expect(service.preview(7, scope, revision, [config, { ...config, key: "second-source" }], new AbortController().signal)).rejects.toMatchObject({ code: "DUPLICATE_PUSH_RESOURCE" });
  vi.mocked(TeamAssetService.prototype.previewConfiguration).mockRejectedValue(new WorkspaceError("NO_CONFIGURATION_CHANGE", "unchanged"));
  const preview = await service.preview(7, scope, revision, [config], new AbortController().signal);
  expect(preview.items[0]!.status).toBe("unchanged");
  expect((await service.publish(7, scope, preview.token, new AbortController().signal)).items[0]!.status).toBe("unchanged");
  expect(confirm).not.toHaveBeenCalled(); expect(publishAsset).not.toHaveBeenCalled();
  const next = await service.preview(7, scope, revision, [config], new AbortController().signal);
  await workspace.setTeamEnabled(false);
  await expect(service.publish(7, scope, next.token, new AbortController().signal)).rejects.toMatchObject({ code: "TEAM_DISABLED" });
});

it("bounds the complete multibyte Diff reply including duplicated turn content and its envelope", async () => {
  const payload = structuredClone(turn);
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), getSessionTurn: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), save: vi.fn(), confirm });
  const snapshot = { token: "bounded", expiresAt: Date.now() + 600000, repository: scope.repository, projectIdentity: "team:shared", root: { schemaVersion: 2 as const, exportedAt: 1, session: { sessionKey: "one", displayTitle: "One", originalTitle: "One", source: "codex-cli" }, messages: [], traceEvents: [] }, selectedTurns: [payload], bytes: 1, children: [], files: [], missingAttachments: [] as string[] };
  vi.spyOn(sharing, "prepare").mockResolvedValue(snapshot);
  const discard = vi.spyOn(sharing, "discard");
  const bounded = new TeamPushService(root, confirm, sharing);
  try {
    const measure = async () => Buffer.byteLength(JSON.stringify({ ok: true, data: { kind: "push-preview", value: await bounded.preview(7, scope, undefined, turns, new AbortController().signal) } }));
    const limit = 16 * 1024 * 1024;
    let available = limit - await measure();
    if (available % 2) { snapshot.missingAttachments = ["x"]; available = limit - await measure(); }
    const bytes = available / 2;
    payload.messages[0]!.content += "汉".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
    expect(await measure()).toBe(limit);
    payload.messages[0]!.content += "x";
    await expect(measure()).rejects.toMatchObject({ code: "ASSETS_TOO_LARGE" });
    expect(discard).toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  } finally { bounded.close(); sharing.close(); }
});

it("inspects locally without preparing an upload or invalidating an existing selected preview", async () => {
  const signal = new AbortController().signal;
  const preview = await service.preview(7, scope, revision, [config], signal);
  const inspect = vi.spyOn(TeamAssetService.prototype, "inspectConfiguration").mockResolvedValue({ key: "environment:TEAM_MODE", name: "TEAM_MODE", status: "added", files: [{ path: "agentrecall.json", before: null, after: "review" }] });
  vi.mocked(TeamAssetService.prototype.previewConfiguration).mockClear();
  expect((await service.inspect(scope, revision, config, signal)).item).toMatchObject({ key: "env", status: "added" });
  expect(inspect).toHaveBeenCalledOnce(); expect(TeamAssetService.prototype.previewConfiguration).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  await expect(service.inspect({ ...scope, repository: "https://github.com/example/other" }, revision, config, signal)).rejects.toMatchObject({ code: "TEAM_CHANGED" });
  expect((await service.publish(7, scope, preview.token, signal)).items[0]?.status).toBe("published");
});

it("stages complete sessions through Push and rejects overlapping turn selections", async () => {
  const full: TeamPushItem = { kind: "session", key: "session:one", sessionKey: "one" };
  const preview = await service.preview(7, scope, undefined, [full], new AbortController().signal);
  expect(preview.items[0]!.key).toBe(full.key);
  expect(preview.items[0]!.session).toBeUndefined();
  expect(preview.items[0]!.files[0]!.after).toContain("MiB");
  expect(publishSession).not.toHaveBeenCalled();
  expect((await service.publish(7, scope, preview.token, new AbortController().signal)).items).toEqual([{ key: full.key, status: "published" }]);
  await expect(service.preview(7, scope, undefined, [full, ...turns], new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
});

it("blocks a conflicting local resource before contacting Git and publishes only its persisted value", async () => {
  if (config.kind !== "configuration") throw new Error("fixture kind");
  const entry = { key: "environment:TEAM_MODE", name: "TEAM_MODE", status: "added" as const, conflict: true, change: config.change };
  const local = vi.spyOn(TeamAssetService.prototype, "localChanges").mockResolvedValue([entry]);
  const item: TeamPushItem = { kind: "local-resource", key: entry.key };
  await expect(service.preview(7, scope, revision, [item], new AbortController().signal)).rejects.toMatchObject({ code: "TEAM_LOCAL_CONFLICT" });
  expect(TeamAssetService.prototype.previewConfiguration).not.toHaveBeenCalled();
  local.mockResolvedValue([{ ...entry, conflict: false }]);
  const preview = await service.preview(7, scope, revision, [item], new AbortController().signal);
  expect(preview.items[0]!.status).toBe("added");
  expect(TeamAssetService.prototype.previewConfiguration).toHaveBeenCalledWith(root, revision, config.change, undefined, expect.any(AbortSignal));
});
it("keeps a protected role and its new Skill together in a valid, mergeable review branch", async () => {
  vi.restoreAllMocks();
  const testHome = path.join(root, "home"); await fs.mkdir(testHome);
  const gitConfig = path.join(testHome, "gitconfig"); await fs.writeFile(gitConfig, "");
  for (const [key, value] of Object.entries({ HOME: testHome, USERPROFILE: testHome, APPDATA: path.join(testHome, "appdata"), LOCALAPPDATA: path.join(testHome, "local"), XDG_CONFIG_HOME: path.join(testHome, "config"), npm_config_prefix: path.join(testHome, "npm"), GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" })) vi.stubEnv(key, value);
  const execute = promisify(execFile);
  const git = async (...args: string[]) => (await execute("git", args, { windowsHide: true })).stdout.trim();
  const seed = path.join(root, "seed"), remote = path.join(root, "remote.git"); await fs.mkdir(seed);
  await git("init", "-q", "--initial-branch=main", seed); await git("init", "-q", "--bare", "--initial-branch=main", remote);
  await fs.writeFile(path.join(seed, "agentrecall.json"), JSON.stringify({ schemaVersion: 4, skills: [], workConfigs: [], documents: [], instructions: [], mcpServers: [], environment: [] }));
  await fs.writeFile(path.join(seed, "OWNERS.json"), JSON.stringify({ schemaVersion: 1, rules: [{ resources: ["agentRoles"], owners: ["@reviewer"] }] }));
  await git("-C", seed, "add", "."); await git("-C", seed, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture"); await git("-C", seed, "push", remote, "HEAD:main");
  const source = new GitAssetSource(async (_url, destination) => { await git("clone", "--bare", "--no-hardlinks", remote, destination); });
  // Keep the real preparation and publication; replace only its remote transport.
  const prepare = source.prepareConfiguration.bind(source);
  vi.spyOn(GitAssetSource.prototype, "prepareConfiguration").mockImplementation(prepare);
  const assets = new TeamAssetService(workspace, source, scope); await assets.sync(root);
  const base = await git("-C", remote, "rev-parse", "HEAD");
  await assets.stage(root, [
    { kind: "skills", operation: "create", value: { id: "review", name: "Review", files: [{ path: "SKILL.md", executable: false, content: Buffer.from("---\nname: review\ndescription: Review code\n---\nReview.\n").toString("base64") }] } },
    { kind: "agentRoles", operation: "create", value: { id: "reviewer", name: "Reviewer", description: "Reviews code", content: "Review the code.\n", model: { runtime: "codex" }, skills: ["review"], mcpServers: [], tags: [] } },
  ]);
  const preview = await service.preview(7, scope, base, [{ key: "skills:review", kind: "local-resource" }, { key: "agentRoles:reviewer", kind: "local-resource" }], new AbortController().signal);
  expect(preview.items.map(item => item.owners)).toEqual([["@reviewer"], ["@reviewer"]]);
  const result = await service.publish(7, scope, preview.token, new AbortController().signal);
  expect(result.items.map(item => item.status)).toEqual(["review", "review"]);
  expect(await git("-C", remote, "rev-parse", "HEAD")).toBe(base);
  const branch = await git("-C", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/agentrecall/review/");
  const proposed = JSON.parse(await git("-C", remote, "show", `${branch}:agentrecall.json`));
  expect(proposed.skills).toEqual([{ id: "review", path: "skills/review" }]);
  expect(proposed.agentRoles[0].skills).toEqual(["review"]);
  const branchSource = new GitAssetSource(async (_url, destination) => { await git("clone", "--bare", "--no-hardlinks", "--branch", branch, remote, destination); });
  expect((await branchSource.load(scope.repository, await fs.mkdtemp(path.join(root, "read-")), "https")).skills.map(skill => skill.id)).toEqual(["review"]);
  await git("-C", remote, "merge-tree", "--write-tree", "main", branch);
}, 30_000);
it("still reports a review push as awaiting review when only temporary-file cleanup failed", async () => {
  const mcp: TeamPushItem = { key: "mcp", kind: "configuration", change: { kind: "mcp", operation: "create", value: { id: "docs", name: "Docs", targets: ["codex"], transport: "http", url: "https://example.invalid/mcp", headers: {} } } };
  vi.mocked(TeamAssetService.prototype.previewConfiguration).mockResolvedValue({ repository: scope.repository, revision, branch: "main", kind: "mcp", operation: "create", name: "Docs", files: [], items: [{ key: "mcp:docs", name: "Docs", status: "added", files: [], owners: ["@acme/platform"] }], review: { branch: "agentrecall/review/abc", owners: ["@acme/platform"] } });
  publishAsset.mockRejectedValue(new WorkspaceError("CONFIGURATION_CLEANUP_REQUIRED", "cleanup", { published: true }));
  const preview = await service.preview(7, scope, revision, [mcp], new AbortController().signal);
  const result = await service.publish(7, scope, preview.token, new AbortController().signal);
  expect(result.items).toEqual([expect.objectContaining({ key: "mcp", status: "review", message: expect.stringContaining("agentrecall/review/abc") })]);
});
