import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitAssetSource, TeamAssetService, WorkspaceError, WorkspaceService } from "@agentrecall/workspace-core";
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

function harness() {
  const chooseFolder = vi.fn(async () => null as string | null);
  const confirm = vi.fn(async () => false);
  const service = new TeamWorkspaceService(path.join(root, "shared-cli"), { chooseFolder, confirm });
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
    expect(await api.request({ action: "snapshot" })).toEqual({ ok: true, data: { kind: "snapshot", value: { config: null, busy: false } } });
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
    expect(sender.listenerCount("destroyed")).toBe(0);
    dispose();
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
