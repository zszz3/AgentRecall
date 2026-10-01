import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitAssetSource, TeamAssetService, WorkspaceError, WorkspaceService } from "@agentrecall/workspace-core";
import { TeamSessionSharing } from "../services/team-session-sharing";
import { TeamSessionDownloads } from "../services/team-session-downloads";
import { TeamWorkspaceService } from "../services/team-workspace-service";
import { createTeamWorkspaceApi } from "../../preload/team-workspace";
import { registerTeamWorkspaceIpc } from "./team-workspace";

const execute = promisify(execFile);
let root: string;
const services: TeamWorkspaceService[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "team-desktop-"));
  const gitConfig = path.join(root, "gitconfig");
  await fs.writeFile(gitConfig, "");
  vi.stubEnv("HOME", root);
  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("GIT_CONFIG_GLOBAL", gitConfig);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function harness(sharing?: TeamSessionSharing, downloads?: TeamSessionDownloads) {
  const chooseFolder = vi.fn(async () => null as string | null);
  const confirm = vi.fn(async () => false);
  const service = new TeamWorkspaceService(path.join(root, "shared-cli"), { chooseFolder, confirm }, sharing, downloads);
  services.push(service);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sender = Object.assign(new EventEmitter(), { id: 17 });
  const dispose = registerTeamWorkspaceIpc({
    handle: (channel, listener) => { handlers.set(channel, listener as (...args: unknown[]) => unknown); },
    removeHandler: (channel) => { handlers.delete(channel); },
  }, service);
  const api = createTeamWorkspaceApi({ invoke: async (channel, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("No handler");
    return handler({ sender }, ...args);
  } });
  return { service, api, sender, handlers, dispose, chooseFolder, confirm, workspace: new WorkspaceService(path.join(root, "shared-cli")) };
}

async function project(workspace: WorkspaceService) {
  const directory = path.join(root, "business");
  await fs.mkdir(directory);
  await execute("git", ["init", "-q", directory]);
  await workspace.store.initialize();
  await workspace.addTeam({ id: "example--team", name: "Example", repository: "https://github.com/example/assets" });
  return workspace.addProject({ id: "business-", directory, teamId: "example--team" });
}

describe("V2 team workspace IPC", () => {
  it("reads without initialization, shares the CLI config, and rejects malformed requests before mutation", async () => {
    const { api, workspace, handlers, sender, dispose } = harness();
    expect(await api.request({ action: "snapshot" })).toEqual({ ok: true, data: { kind: "snapshot", value: { config: null, busy: false, directories: [] } } });
    await expect(fs.access(workspace.store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const handler = handlers.get("team-workspace:request")!;
    expect(() => handler({ sender }, { action: "enable", enabled: "yes" })).toThrow(/Invalid input/);
    expect(() => handler({ sender }, { action: "snapshot", command: "anything" })).toThrow(/Invalid input/);
    await api.request({ action: "enable", enabled: true });
    await api.request({ action: "add-team", id: "example--team", name: "Example", repository: "https://github.com/example/assets" });
    expect((await workspace.store.read())?.teams[0]?.id).toBe("example--team");
    expect(await api.request({ action: "add-project", id: "relative", name: "Relative", directory: "." })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect((await workspace.store.read())?.projects).toEqual([]);
    await workspace.setTeamEnabled(false);
    expect(await api.request({ action: "snapshot" })).toMatchObject({ ok: true, data: { value: { config: { teamEnabled: false } } } });
    expect(sender.listenerCount("destroyed")).toBe(1);
    dispose();
    expect(sender.listenerCount("destroyed")).toBe(0);
    expect(handlers.size).toBe(0);
  });

  it("keeps native confirmation in the main process and rejects a stale project selection", async () => {
    const { api, workspace, confirm } = harness();
    const saved = await project(workspace);
    const remove = { action: "remove-project" as const, id: saved.id, root: saved.root };
    expect(await api.request(remove)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect((await workspace.store.read())?.projects).toHaveLength(1);
    confirm.mockImplementation(async () => {
      await workspace.removeProject(saved.id);
      const other = path.join(root, "other");
      await fs.mkdir(other);
      await execute("git", ["init", "-q", other]);
      await workspace.addProject({ id: saved.id, directory: other });
      return true;
    });
    expect(await api.request(remove)).toMatchObject({ ok: false, error: { code: "PROJECT_MISMATCH" } });
    expect((await workspace.store.read())?.projects).toHaveLength(1);
    await expect(workspace.bindProject(saved.id, null, saved.root)).rejects.toMatchObject({ code: "PROJECT_MISMATCH" });
    expect(await api.request({ action: "catalog", scope: { projectId: saved.id, root: saved.root } })).toMatchObject({ ok: false, error: { code: "PROJECT_MISMATCH" } });
  });

  it("enforces disabled mode and cancels a sync when its requesting window is destroyed", async () => {
    const { api, workspace, sender, service } = harness();
    const saved = await project(workspace);
    const request = { action: "sync" as const, scope: { projectId: saved.id, root: saved.root, repository: "https://github.com/example/assets" }, transport: "https" as const };
    expect(await api.request(request)).toMatchObject({ ok: false, error: { code: "TEAM_DISABLED" } });
    await workspace.setTeamEnabled(true);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const load = vi.spyOn(GitAssetSource.prototype, "load").mockImplementation((_repository, _scratch, _transport, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new WorkspaceError("CANCELLED", "同步已取消")), { once: true });
      started();
    }));
    const pending = api.request(request);
    await ready;
    expect(await api.request({ action: "snapshot" })).toMatchObject({ ok: true, data: { value: { busy: true } } });
    sender.emit("destroyed");
    expect(await pending).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(sender.listenerCount("destroyed")).toBe(0);
    const onQuit = service.request(18, request);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await service.close();
    expect(await onQuit).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    expect(await api.request({ action: "snapshot" })).toMatchObject({ ok: false, error: { code: "TEAM_CLOSED" } });
    const assets = await fs.readdir(path.join(root, "shared-cli", "assets"));
    expect(assets).toEqual([]);
  });

  it("rejects installation when the previewed asset repository no longer matches the project", async () => {
    const { api, workspace } = harness();
    const saved = await project(workspace);
    await workspace.setTeamEnabled(true);
    expect(await api.request({
      action: "skill-install", scope: { projectId: saved.id, root: saved.root, repository: "https://github.com/other/assets" },
      id: "review", target: "codex", revision: "1".repeat(40),
    })).toMatchObject({ ok: false, error: { code: "TEAM_CHANGED" } });
    await expect(fs.access(path.join(saved.root, ".agents"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires native confirmation for offline group removal and preserves files on cancel", async () => {
    const { api, workspace, confirm } = harness();
    const saved = await project(workspace);
    await workspace.setTeamEnabled(true);
    const files = [{ path: "SKILL.md", content: Buffer.from("---\nname: review\ndescription: Review changes\n---\nReview the diff.\n").toString("base64"), executable: false }];
    const repository = "https://github.com/example/assets";
    const revision = "1".repeat(40);
    const cache = path.join(root, "shared-cli", "assets");
    await fs.mkdir(cache);
    await fs.writeFile(path.join(cache, "example--team.json"), JSON.stringify({
      schemaVersion: 2, repository, commit: revision,
      skills: [{ id: "review", description: "Review changes", files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex") }],
      workConfigs: [{ id: "backend", name: "Backend", description: "Review work", skills: ["review"] }],
    }));
    const assets = new TeamAssetService(workspace);
    await assets.installWorkConfig(saved.root, "backend", "codex", revision, saved.id);
    await workspace.setTeamEnabled(false);
    const request = { action: "work-uninstall" as const, scope: { projectId: saved.id, root: saved.root, repository }, id: "backend", target: "codex" as const, revision };
    expect(await api.request(request)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(await assets.installedWorkConfigs(saved.root, saved.id)).toHaveLength(1);
    confirm.mockResolvedValue(true);
    expect(await api.request(request)).toMatchObject({ ok: true, data: { kind: "complete" } });
    expect(await assets.installedWorkConfigs(saved.root, saved.id)).toEqual([]);
    await expect(fs.access(path.join(saved.root, ".agents", "skills", "review"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await assets.backups(saved.root, "review", saved.id)).backups).toHaveLength(1);
  });
  it("connects repositories and local projects without asking for internal IDs or enabling sharing", async () => {
    const { api, workspace } = harness();
    const result = await api.request({ action: "add-team", repository: "git@github.com:Example/Assets.git", makeDefault: true });
    expect(result.ok).toBe(true);
    const saved = (await workspace.store.read())!;
    expect(saved.teamEnabled).toBe(false);
    expect(saved.teams).toHaveLength(1);
    expect(saved.teams[0]).toMatchObject({ name: "example/assets", repository: "https://github.com/example/assets" });
    expect(saved.defaultTeamId).toBe(saved.teams[0]!.id);
    expect(saved.teams[0]!.id).toMatch(/^team-/);
    expect(await api.request({ action: "add-team", repository: "https://github.com/example/assets" })).toMatchObject({ ok: false, error: { code: "TEAM_EXISTS" } });
    const directory = path.join(root, "local-project");
    await fs.mkdir(directory);
    await execute("git", ["init", "-q", directory]);
    expect(await api.request({ action: "add-project", directory, teamId: saved.defaultTeamId })).toMatchObject({ ok: true });
    const updated = (await workspace.store.read())!;
    expect(updated.projects[0]).toMatchObject({ name: "local-project", teamId: saved.defaultTeamId });
    expect(updated.projects[0]!.id).toMatch(/^project-/);
    expect(await api.request({ action: "add-project", directory })).toMatchObject({ ok: false, error: { code: "PROJECT_EXISTS" } });
    expect((await workspace.store.read())?.projects).toHaveLength(1);
    expect((await workspace.store.read())?.teamEnabled).toBe(false);
  });

});


it("enforces team/project scope for sessions and cancels retained previews on window destruction", async () => {
  const sharing = new TeamSessionSharing({
    store: { getSession: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() },
    ensureDetails: vi.fn(), confirm: vi.fn(), save: vi.fn(),
  });
  const list = vi.spyOn(sharing, "list").mockResolvedValue({ page: 1, items: [], hasMore: false });
  const cancel = vi.spyOn(sharing, "cancel");
  const { api, workspace, sender, dispose } = harness(sharing);
  const saved = await project(workspace);
  const scope = { projectId: saved.id, root: saved.root, repository: "https://github.com/example/assets" };
  expect(await api.request({ action: "session-list", scope, page: 1 })).toMatchObject({ ok: false, error: { code: "TEAM_DISABLED" } });
  await workspace.setTeamEnabled(true);
  expect(await api.request({ action: "session-list", scope, page: 1 })).toMatchObject({ ok: true, data: { kind: "session-list" } });
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ projectIdentity: `legacy:${saved.id}` }), 1, expect.any(AbortSignal), undefined, undefined, undefined);
  const open = vi.spyOn(sharing, "cached").mockResolvedValue({ partial: false, records: [], bytes: 0, files: [], missingAttachments: [] });
  const turns = vi.spyOn(sharing, "turns").mockResolvedValue({ turns: [], offset: 0, hasMore: false });
  const turn = vi.spyOn(sharing, "turn").mockResolvedValue(null);
  const restoreLocal = vi.spyOn(sharing, "restoreLocal").mockResolvedValue("Session 已创建");
  const exportLocal = vi.spyOn(sharing, "exportLocal").mockResolvedValue(true);
  const share = { scope, id: 17, digest: "a".repeat(64) };
  expect(await api.request({ action: "session-open", ...share })).toMatchObject({ ok: true, data: { kind: "session-open" } });
  expect(await api.request({ action: "session-turns", ...share, record: 0, offset: 0 })).toMatchObject({ ok: true, data: { kind: "session-turns" } });
  expect(await api.request({ action: "session-turn", ...share, record: 0, turnId: "turn" })).toMatchObject({ ok: true, data: { kind: "session-turn", value: null } });
  expect(open).toHaveBeenCalledOnce(); expect(turns).toHaveBeenCalledOnce(); expect(turn).toHaveBeenCalledOnce();
  expect(await api.request({ action: "session-turns", ...share, record: -1, offset: 0 })).toMatchObject({ ok: false });
  expect(turns).toHaveBeenCalledOnce();
  expect(await api.request({ action: "session-export", ...share, format: "json" })).toMatchObject({ ok: true, data: { kind: "complete" } });
  expect(await api.request({ action: "session-restore", ...share })).toMatchObject({ ok: true, data: { kind: "complete", message: "Session 已创建" } });
  expect(restoreLocal).toHaveBeenCalledWith(sender.id, expect.any(Object), share.id, share.digest, expect.any(AbortSignal));
  expect(exportLocal).toHaveBeenCalledWith(sender.id, expect.any(Object), share.id, share.digest, "json", expect.any(AbortSignal));
  exportLocal.mockResolvedValueOnce(false);
  expect(await api.request({ action: "session-export", ...share, id: -1, format: "markdown" })).toMatchObject({ ok: true, data: { kind: "cancelled" } });
  sender.emit("destroyed");
  expect(cancel).toHaveBeenCalledWith(sender.id);
  expect(sender.listenerCount("destroyed")).toBe(0);
  dispose();
});


it("disabling teams cancels the current download before persisting disabled mode", async () => {
  const { api, workspace } = harness();
  const saved = await project(workspace); await workspace.setTeamEnabled(true);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(GitAssetSource.prototype, "load").mockImplementation((_repository, _scratch, _transport, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(new WorkspaceError("CANCELLED", "同步已取消")), { once: true }); started();
  }));
  const download = api.request({ action: "sync", scope: { projectId: saved.id, root: saved.root, repository: "https://github.com/example/assets" }, transport: "https" });
  await ready;
  expect(await api.request({ action: "enable", enabled: false })).toMatchObject({ ok: true, data: { value: { config: { teamEnabled: false } } } });
  expect(await download).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});

it("creates a name-only space and exposes asset previews and sessions without a checkout", async () => {
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), confirm: vi.fn(), save: vi.fn() });
  const list = vi.spyOn(sharing, "list").mockResolvedValue({ page: 1, items: [], hasMore: false });
  const { api, workspace, confirm } = harness(sharing);
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  expect(await api.request({ action: "create-project", name: "Research", teamId: "team" })).toMatchObject({ ok: true });
  const project = (await workspace.store.read())!.projects[0]!;
  expect(project).toMatchObject({ name: "Research", root: null, repository: null });
  const scope = { projectId: project.id, root: null, repository: "https://github.com/example/assets" };
  expect(await api.request({ action: "catalog", scope })).toMatchObject({ ok: true, data: { kind: "catalog", value: { installed: [], root: null } } });
  expect(await api.request({ action: "session-list", scope, page: 1 })).toMatchObject({ ok: true });
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ projectIdentity: project.sharingKey, root: null, projectName: "Research" }), 1, expect.any(AbortSignal), undefined, undefined, undefined);
  expect(await api.request({ action: "skill-install", scope, id: "review", target: "codex", revision: "1".repeat(40) })).toMatchObject({ ok: false, error: { code: "LOCAL_DIRECTORY_REQUIRED" } });
  expect(await api.request({ action: "catalog", scope: { ...scope, directory: "relative" } })).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  confirm.mockResolvedValue(true);
  expect(await api.request({ action: "remove-project", id: project.id, root: null })).toMatchObject({ ok: true });
  expect((await workspace.store.read())!.projects).toEqual([]);
});

it("opens teams without projects, reads connected local assets and guards installation clients", async () => {
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), confirm: vi.fn(), save: vi.fn() });
  const list = vi.spyOn(sharing, "list").mockResolvedValue({ page: 1, items: [], hasMore: false });
  const { api, workspace, confirm } = harness(sharing);
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  const scope = { teamId: "team", repository: "https://github.com/example/assets" };
  expect(await api.request({ action: "session-list", scope, page: 1 })).toMatchObject({ ok: true });
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ teamWide: true, projectIdentity: "team:shared" }), 1, expect.any(AbortSignal), undefined, undefined, undefined);
  expect(await api.request({ action: "catalog", scope })).toMatchObject({ ok: true, data: { kind: "catalog", value: { installed: [] } } });
  const directory = path.join(root, "no-git"); await fs.mkdir(directory); await fs.writeFile(path.join(directory, "AGENTS.md"), "personal rules");
  expect(await api.request({ action: "connect-directory", teamId: "team", directory, targets: ["codex"] })).toMatchObject({ ok: true });
  const connection = (await workspace.store.read())!.directories![0]!;
  const local = { ...scope, connectionId: connection.id, directory: connection.path };
  expect(await api.request({ action: "local-assets", scope: local, kind: "documents" })).toMatchObject({ ok: true, data: { kind: "local-assets", value: { entries: [{ path: "AGENTS.md" }] } } });
  expect(await api.request({ action: "local-assets", scope: local, kind: "documents", file: "AGENTS.md" })).toMatchObject({ ok: true, data: { kind: "local-preview", value: { content: "personal rules" } } });
  expect(await api.request({ action: "skill-install", scope: local, id: "review", target: "claude", revision: "1".repeat(40) })).toMatchObject({ ok: false, error: { code: "CLIENT_DISABLED" } });
  expect(await api.request({ action: "disconnect-directory", teamId: "team", id: connection.id, directory: connection.path })).toMatchObject({ ok: true, data: { kind: "cancelled" } });
  confirm.mockResolvedValue(true);
  expect(await api.request({ action: "disconnect-directory", teamId: "team", id: connection.id, directory: connection.path })).toMatchObject({ ok: true });
  expect(await fs.readFile(path.join(directory, "AGENTS.md"), "utf8")).toBe("personal rules");
  expect(await api.request({ action: "local-assets", scope: local, kind: "documents" })).toMatchObject({ ok: false, error: { code: "PROJECT_MISMATCH" } });
  expect((await workspace.store.read())!.projects).toEqual([]);
});

it("one sync request installs team resources to enabled clients using the saved transport", async () => {
  const { api, workspace, confirm } = harness();
  const saved = await project(workspace); await workspace.setTeamEnabled(true); await workspace.setTeamTransport("example--team", "ssh");
  const files = [{ path: "SKILL.md", content: Buffer.from("---\nname: review\ndescription: Review changes\n---\nReview code.\n").toString("base64"), executable: false }];
  const repository = "https://github.com/example/assets";
  const load = vi.spyOn(GitAssetSource.prototype, "load").mockResolvedValue({ schemaVersion: 3, repository, commit: "1".repeat(40), skills: [{ id: "review", description: "Review changes", files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex") }], workConfigs: [], documents: [{ id: "rules", name: "Rules", path: "AGENTS.md", target: "AGENTS.md", content: "Team rules", digest: createHash("sha256").update("Team rules").digest("hex") }] });
  const scope = { teamId: "example--team", repository };
  expect(await api.request({ action: "sync", scope })).toMatchObject({ ok: true, data: { kind: "sync-result", value: { status: "complete" } } });
  expect(load.mock.calls[0]![2]).toBe("ssh"); expect(confirm).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(saved.root, ".agents", "skills", "review", "SKILL.md"), "utf8")).toContain("Review code.");
  expect(await fs.readFile(path.join(saved.root, ".claude", "skills", "review", "SKILL.md"), "utf8")).toContain("Review code.");
  expect(await fs.readFile(path.join(saved.root, "AGENTS.md"), "utf8")).toBe("Team rules");
  expect(await api.request({ action: "sync-status", scope })).toMatchObject({ ok: true, data: { kind: "sync-status", value: { status: "complete" } } });
});

describe("team configuration authoring", () => {
  it("owns immutable previews per window and confirms before publishing", async () => {
    const { api, service, workspace, confirm } = harness();
    await project(workspace); await workspace.setTeamEnabled(true);
    const scope = { teamId: "example--team", repository: "https://github.com/example/assets" };
    const change = { kind: "environment" as const, operation: "create" as const, value: { name: "TEAM_MODE", value: "review", targets: ["codex" as const] } };
    const preview = { repository: scope.repository, revision: "1".repeat(40), branch: "main", kind: change.kind, operation: change.operation, name: "TEAM_MODE", files: [{ path: "agentrecall.json", before: "{}", after: "{\"TEAM_MODE\":\"review\"}" }] };
    vi.spyOn(TeamAssetService.prototype, "previewConfiguration").mockResolvedValue(preview);
    const publish = vi.spyOn(TeamAssetService.prototype, "publishConfiguration").mockResolvedValue({ repository: scope.repository, commit: "2".repeat(40), cacheUpdated: true, cleanupRequired: false });
    const prepared = await api.request({ action: "configuration-preview", scope, revision: preview.revision, change });
    expect(prepared.ok && prepared.data.kind).toBe("configuration-preview");
    if (!prepared.ok || prepared.data.kind !== "configuration-preview") throw new Error("Missing preview");
    const request = { action: "configuration-publish" as const, scope, token: prepared.data.value.token };
    expect(await service.request(18, request)).toMatchObject({ ok: false, error: { code: "CONFIGURATION_PREVIEW_EXPIRED" } });
    expect(confirm).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
    expect(await api.request(request)).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(publish).not.toHaveBeenCalled();
    change.value.value = "mutated-after-preview";
    confirm.mockResolvedValue(true);
    expect(await api.request(request)).toMatchObject({ ok: true, data: { kind: "configuration-published", value: { cacheUpdated: true } } });
    expect(publish.mock.calls[0][2].value).toMatchObject({ value: "review" });
    expect(await api.request(request)).toMatchObject({ ok: false, error: { code: "CONFIGURATION_PREVIEW_EXPIRED" } });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects expired, cancelled and changed-team previews and malformed drafts before publishing", async () => {
    const { api, workspace, confirm, sender, handlers } = harness(); await project(workspace); await workspace.setTeamEnabled(true);
    const scope = { teamId: "example--team", repository: "https://github.com/example/assets" };
    const change = { kind: "environment" as const, operation: "create" as const, value: { name: "TEAM_MODE", value: "review", targets: ["codex" as const] } };
    vi.spyOn(TeamAssetService.prototype, "previewConfiguration").mockResolvedValue({ repository: scope.repository, revision: "1".repeat(40), branch: "main", kind: change.kind, operation: change.operation, name: "TEAM_MODE", files: [] });
    const publish = vi.spyOn(TeamAssetService.prototype, "publishConfiguration");
    const prepare = async () => {
      const result = await api.request({ action: "configuration-preview", scope, revision: "1".repeat(40), change });
      if (!result.ok || result.data.kind !== "configuration-preview") throw new Error("Missing preview");
      return { action: "configuration-publish" as const, scope, token: result.data.value.token };
    };
    const first = await prepare();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    expect(await api.request(first)).toMatchObject({ ok: false, error: { code: "CONFIGURATION_PREVIEW_EXPIRED" } }); clock.mockRestore();
    const second = await prepare(); sender.emit("destroyed");
    expect(await api.request(second)).toMatchObject({ ok: false, error: { code: "CONFIGURATION_PREVIEW_EXPIRED" } });
    const third = await prepare(); confirm.mockImplementation(async () => { await workspace.setTeamTransport(scope.teamId, "ssh"); return true; });
    expect(await api.request(third)).toMatchObject({ ok: false, error: { code: "TEAM_CHANGED" } });
    expect(() => handlers.get("team-workspace:request")!({ sender }, { action: "configuration-preview", scope, revision: "1".repeat(40), change: { ...change, value: { ...change.value, value: "${SECRET}" } } })).toThrow(/Invalid input/);
    expect(publish).not.toHaveBeenCalled();
  });
});

it("includes preview tokens and the reply envelope in the authoring size limit", async () => {
  const { api, workspace } = harness(); await project(workspace); await workspace.setTeamEnabled(true);
  const scope = { teamId: "example--team", repository: "https://github.com/example/assets" };
  const change = { kind: "environment" as const, operation: "create" as const, value: { name: "TEAM_MODE", value: "review", targets: ["codex" as const] } };
  const preview = { repository: scope.repository, revision: "1".repeat(40), branch: "main", kind: change.kind, operation: change.operation, name: "TEAM_MODE", files: [{ path: "agentrecall.json", before: null, after: "" }] };
  preview.files[0].after = "a".repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(preview)));
  vi.spyOn(TeamAssetService.prototype, "previewConfiguration").mockResolvedValue(preview);
  expect(await api.request({ action: "configuration-preview", scope, revision: preview.revision, change })).toMatchObject({ ok: false, error: { code: "ASSETS_TOO_LARGE" } });
});

it("validates selected turn IDs at IPC and forwards them with the authenticated window scope", async () => {
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), confirm: vi.fn(), save: vi.fn() });
  const prepare = vi.spyOn(sharing, "prepare").mockRejectedValue(new WorkspaceError("FIXTURE_PREPARE", "fixture"));
  const { api, workspace, sender } = harness(sharing);
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  const scope = { teamId: "team", repository: "https://github.com/example/assets" };
  for (const turnIds of [[], ["duplicate", "duplicate"], Array.from({ length: 501 }, (_, i) => `turn-${i}`)]) {
    expect(await api.request({ action: "session-preview", scope, sessionKey: "codex:one", turnIds })).toMatchObject({ ok: false, error: { code: "TEAM_REQUEST_FAILED" } });
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(await api.request({ action: "session-preview", scope, sessionKey: "codex:one", turnIds: ["turn-2", "turn-9"] })).toMatchObject({ ok: false, error: { code: "FIXTURE_PREPARE" } });
  expect(prepare).toHaveBeenCalledWith(sender.id, expect.objectContaining({ repository: scope.repository, teamWide: true }), "codex:one", expect.any(AbortSignal), ["turn-2", "turn-9"]);
});

it("validates item selections at IPC and retains the batch confirmation and window ownership boundary", async () => {
  const { api, workspace, confirm, service, sender } = harness();
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  const scope = { teamId: "team", repository: "https://github.com/example/assets" }, revision = "1".repeat(40);
  const change = { kind: "environment" as const, operation: "create" as const, value: { name: "TEAM_MODE", value: "review", targets: ["codex" as const] } };
  const item = { key: "env", kind: "configuration" as const, change };
  vi.spyOn(TeamAssetService.prototype, "list").mockResolvedValue({ teamId: "team", repository: scope.repository, commit: revision, skills: [], documents: [], workConfigs: [], configuration: { instructions: [], mcpServers: [], environment: [] } });
  const preview = vi.spyOn(TeamAssetService.prototype, "previewConfiguration").mockResolvedValue({ repository: scope.repository, revision, branch: "main", kind: "environment", operation: "create", name: "TEAM_MODE", files: [], items: [{ key: "environment:TEAM_MODE", name: "TEAM_MODE", status: "added", files: [] }] });
  const publish = vi.spyOn(TeamAssetService.prototype, "publishConfiguration").mockResolvedValue({ repository: scope.repository, commit: "2".repeat(40), cacheUpdated: true, cleanupRequired: false });
  expect(await api.request({ action: "push-preview", scope, revision, items: [item, item] })).toMatchObject({ ok: false, error: { code: "TEAM_REQUEST_FAILED" } });
  expect(preview).not.toHaveBeenCalled();
  const reply = await api.request({ action: "push-preview", scope, revision, items: [item] });
  if (!reply.ok || reply.data.kind !== "push-preview") throw new Error("Missing preview");
  const token = reply.data.value.token;
  expect(await service.request(sender.id + 1, { action: "push-publish", scope, token })).toMatchObject({ ok: false, error: { code: "PUSH_PREVIEW_EXPIRED" } });
  expect(publish).not.toHaveBeenCalled(); confirm.mockResolvedValue(true);
  expect(await api.request({ action: "push-publish", scope, token })).toMatchObject({ ok: true, data: { kind: "push-result", value: { items: [{ key: "env", status: "published" }] } } });
  expect(confirm).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce();
});

it("cancels superseded Diff reads without marking the workspace busy or preparing a push", async () => {
  const { TeamPushService } = await import("../services/team-push-service");
  const started: AbortSignal[] = [];
  vi.spyOn(TeamPushService.prototype, "inspect").mockImplementation(async (_scope, _revision, _item, signal) => {
    started.push(signal);
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new WorkspaceError("CANCELLED", "superseded")), { once: true }));
  });
  const { api, sender } = harness();
  const scope = { teamId: "team", repository: "https://github.com/example/assets" };
  const item = { kind: "turn" as const, key: "one", sessionKey: "session", turnId: "one" };
  const first = api.request({ action: "push-inspect", scope, item });
  await vi.waitFor(() => expect(started).toHaveLength(1));
  expect(await api.request({ action: "snapshot" })).toMatchObject({ ok: true, data: { value: { busy: false } } });
  const second = api.request({ action: "push-inspect", scope, item: { ...item, key: "two", turnId: "two" } });
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(await first).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  sender.emit("destroyed");
  expect(await second).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
});


it("starts app-owned downloads through IPC while reads remain cache-only", async () => {
  const sharing = new TeamSessionSharing({store:{ getSession:vi.fn(), searchSessions:vi.fn(), getAllMessages:vi.fn(), getTraceEvents:vi.fn(), getSessionTurn:vi.fn(), getSessionSourceArtifacts:vi.fn(), getAttachmentFile:vi.fn() },ensureDetails:vi.fn(),confirm:vi.fn(),save:vi.fn()});
  vi.spyOn(sharing,"cached").mockResolvedValue(null);
  vi.spyOn(sharing,"cachedIds").mockResolvedValue([]);
  const directOpen = vi.spyOn(sharing,"open");
  const run = vi.fn(async (_input, signal:AbortSignal) => new Promise<void>((_resolve,reject) => signal.addEventListener("abort",()=>reject(new Error("cancel")),{once:true})));
  const {api,workspace,sender} = harness(sharing,new TeamSessionDownloads(run));
  const saved = await project(workspace);
  const share = {scope:{projectId:saved.id,root:saved.root,repository:"https://github.com/example/assets"},id:17,digest:"a".repeat(64)};
  await workspace.setTeamEnabled(true);
  expect(await api.request({action:"session-open",...share})).toMatchObject({ok:false,error:{code:"TEAM_SESSION_NOT_READY"}});
  expect(directOpen).not.toHaveBeenCalled();
  expect(await api.request({action:"session-fetch",...share})).toMatchObject({ok:true,data:{value:{phase:"downloading"}}});
  sender.emit("destroyed");
  expect(run.mock.calls[0]![1].aborted).toBe(false);
  expect(await api.request({action:"session-status",scope:share.scope,items:[{id:share.id,digest:share.digest}]})).toMatchObject({ok:true,data:{value:[{phase:"downloading"}]}});
  await api.request({action:"session-fetch-cancel",...share});
  expect(run.mock.calls[0]![1].aborted).toBe(true);
});

it("Pull prepares only missing shares and reports an incomplete sync instead of success", async () => {
  const sharing = new TeamSessionSharing({ store: { getSession: vi.fn(), searchSessions: vi.fn(), getAllMessages: vi.fn(), getTraceEvents: vi.fn(), getSessionTurn: vi.fn(), getSessionSourceArtifacts: vi.fn(), getAttachmentFile: vi.fn() }, ensureDetails: vi.fn(), confirm: vi.fn(), save: vi.fn() });
  const items = [1, 2].map(id => ({ id, digest: "a".repeat(64), title: "Fixture", author: "member", bytes: 1, createdAt: "2026-09-30", canWithdraw: false }));
  const catalog = vi.spyOn(sharing, "pullCatalog").mockResolvedValue(items);
  vi.spyOn(sharing, "cached").mockImplementation(async (_context, id) => id === 1 ? { partial: false, records: [], bytes: 0, files: [], missingAttachments: [] } : null);
  const run = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const { api, workspace } = harness(sharing, new TeamSessionDownloads(run));
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  const scope = { teamId: "team", repository: "https://github.com/example/assets" };
  vi.spyOn(TeamAssetService.prototype, "pull").mockResolvedValue({ schemaVersion: 1, repository: scope.repository, commit: "a".repeat(40), startedAt: 1, finishedAt: 2, status: "no-directories", directories: [] });
  expect(await api.request({ action: "sync", scope })).toMatchObject({ ok: false, error: { code: "TEAM_SESSION_SYNC_INCOMPLETE" } });
  expect(await api.request({ action: "sync", scope })).toMatchObject({ ok: true, data: { kind: "sync-result" } });
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.every(([input]) => input.id === 2)).toBe(true);
  expect(await api.request({ action: "session-list", scope, page: 1, query: "x".repeat(201), mode: "turns" })).toMatchObject({ ok: false });
});


it("saves a configuration through IPC and reads the same local value and Diff without remote access", async () => {
  const { api, workspace } = harness();
  await workspace.store.initialize(); await workspace.addTeam({ id: "team", repository: "https://github.com/example/assets" }); await workspace.setTeamEnabled(true);
  const scope = { teamId: "team", repository: "https://github.com/example/assets" }, revision = "1".repeat(40);
  await fs.mkdir(path.join(path.dirname(workspace.store.filePath), "assets"));
  await fs.writeFile(path.join(path.dirname(workspace.store.filePath), "assets", "team.json"), JSON.stringify({ schemaVersion: 2, repository: scope.repository, commit: revision, skills: [], workConfigs: [] }));
  const remote = vi.spyOn(GitAssetSource.prototype, "prepareConfiguration");
  const change = { kind: "environment" as const, operation: "create" as const, value: { name: "TEAM_MODE", value: "local", targets: ["codex" as const] } };
  const saved = await api.request({ action: "workspace-stage", scope, items: [{ kind: "configuration", key: "draft", change }] });
  expect(saved).toMatchObject({ ok: true, data: { kind: "workspace-changes", value: [{ item: { kind: "local-resource", key: "environment:TEAM_MODE" } }] } });
  expect(await api.request({ action: "catalog", scope })).toMatchObject({ ok: true, data: { kind: "catalog", value: { assets: { configuration: { environment: [change.value] } } } } });
  expect(await api.request({ action: "push-inspect", scope, revision, item: { kind: "local-resource", key: "environment:TEAM_MODE" } })).toMatchObject({ ok: true, data: { kind: "push-inspection", value: { item: { status: "added" } } } });
  const folder = path.join(root, "source-documents");
  await fs.mkdir(path.join(folder, "docs"), { recursive: true });
  await fs.writeFile(path.join(folder, "docs", "guide.md"), "Saved local content");
  await workspace.connectDirectory("team", folder, ["codex"]);
  const canonicalFolder = await fs.realpath(folder);
  const directories = workspace.directoryConnections((await workspace.store.read())!);
  const id = directories.find(entry => entry.path === canonicalFolder)!.id;
  expect(await api.request({ action: "workspace-stage", scope, items: [{ kind: "resource", key: "guide", connectionId: id, directory: canonicalFolder, resource: "documents", file: "docs/guide.md", id: "guide", name: "Guide", destination: "docs/guide.md" }] })).toMatchObject({ ok: true });
  await fs.writeFile(path.join(folder, "docs", "guide.md"), "Later source content");
  expect(await api.request({ action: "document-preview", scope, id: "guide" })).toMatchObject({ ok: true, data: { kind: "document-preview", value: { content: "Saved local content" } } });
  expect(await api.request({ action: "push-inspect", scope, revision, item: { kind: "local-resource", key: "documents:guide" } })).toMatchObject({ ok: true, data: { kind: "push-inspection", value: { item: { files: [{ before: null, after: "Saved local content" }] } } } });
  expect(remote).not.toHaveBeenCalled();
});
