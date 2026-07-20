import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createSkillsApi } from "../preload/skills";
import { IpcInputError } from "../shared/ipc/contract";
import { SKILLS_IPC } from "../shared/ipc/skills";
import { registerSkillsIpc, type SkillsIpcService } from "./ipc/skills";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createMainRegistrar() {
  const handlers = new Map<string, RegisteredHandler>();
  const removed: string[] = [];
  const ipc = {
    handle(channel: string, listener: RegisteredHandler) {
      if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`);
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      removed.push(channel);
      handlers.delete(channel);
    },
  } as unknown as IpcMainRegistrar;
  return { ipc, handlers, removed };
}

function createService(): SkillsIpcService {
  return {
    listSkills: vi.fn(() => ({ skills: [], roots: [], scannedAt: 1 })),
    listImportCandidates: vi.fn(() => ({ skills: [], roots: [], scannedAt: 1 })),
    importLocalSkills: vi.fn(() => []),
    updateManagedSkillTargets: vi.fn(() => ({} as never)),
    listDiscoveredSkills: vi.fn(async () => ({ skills: [], total: 0, hasMore: false, page: 0, stale: false })),
    getDiscoveredSkill: vi.fn(async () => { throw new Error("not used"); }),
    importDiscoveredSkill: vi.fn(async () => { throw new Error("not used"); }),
    refreshUsage: vi.fn(() => ({ refreshed: 0, skipped: 0, total: 0, totalEvents: 0, lastRefreshedAt: 1 })),
    getSyncSnapshot: vi.fn(async () => ({
      status: { kind: "ready" as const, setupSql: "select 1" },
      remoteSkillGroups: [],
      bindings: [],
      relations: [],
      scannedAt: 1,
    })),
    upload: vi.fn(async () => ({ status: "needs-confirmation" as const, conflict: {
      name: "Example",
      agent: "codex" as const,
      latestVersion: 1,
      latestSource: "codex-user",
      latestPath: "example",
    } })),
    install: vi.fn(async () => { throw new Error("not used"); }),
    downloadMany: vi.fn(async () => ({ requested: 0, succeeded: [], skipped: [], conflicts: [], failures: [] })),
    deleteMany: vi.fn(async () => ({ requested: 0, succeeded: [], skipped: [], conflicts: [], failures: [] })),
    getVersion: vi.fn(async () => { throw new Error("not used"); }),
    getDiff: vi.fn(async () => ({ state: "identical" as const, localHash: "", remoteHash: "", files: [] })),
    copySetupSql: vi.fn(),
    copyPath: vi.fn(),
    reveal: vi.fn(async () => undefined),
    delete: vi.fn(() => ({ deletedPath: "/tmp/skill", skillName: "skill" })),
    getUsageHookStatus: vi.fn(() => true),
    installUsageHook: vi.fn(() => "installed"),
    uninstallUsageHook: vi.fn(() => "removed"),
  };
}

describe("Skills IPC", () => {
  it("registers every shared contract and normalizes optional upload force", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerSkillsIpc(ipc, service);
    const event = {} as IpcMainInvokeEvent;

    expect([...handlers.keys()].sort()).toEqual(Object.values(SKILLS_IPC).map((contract) => contract.channel).sort());
    await handlers.get(SKILLS_IPC.upload.channel)?.(event, " /project/Skill /SKILL.md ");
    await handlers.get(SKILLS_IPC.upload.channel)?.(event, "/project/skill/SKILL.md", true);
    await handlers.get(SKILLS_IPC.getDiff.channel)?.(event, "/project/skill/SKILL.md", null);
    await handlers.get(SKILLS_IPC.downloadMany.channel)?.(event, [" fp-a ", "fp-b"]);
    await handlers.get(SKILLS_IPC.importLocal.channel)?.(event, [" /tmp/a/SKILL.md ", "/tmp/b/SKILL.md"]);
    await handlers.get(SKILLS_IPC.updateTargets.channel)?.(event, "review", ["codex", "trae"]);
    await handlers.get(SKILLS_IPC.listDiscovered.channel)?.(event, { page: 2, query: " review " });

    expect(service.upload).toHaveBeenNthCalledWith(1, " /project/Skill /SKILL.md ", false);
    expect(service.upload).toHaveBeenNthCalledWith(2, "/project/skill/SKILL.md", true);
    expect(service.getDiff).toHaveBeenCalledWith("/project/skill/SKILL.md", null);
    expect(service.downloadMany).toHaveBeenCalledWith(["fp-a", "fp-b"]);
    expect(service.importLocalSkills).toHaveBeenCalledWith([" /tmp/a/SKILL.md ", "/tmp/b/SKILL.md"]);
    expect(service.updateManagedSkillTargets).toHaveBeenCalledWith("review", ["codex", "trae"]);
    expect(service.listDiscoveredSkills).toHaveBeenCalledWith({ page: 2, query: "review" });
  });

  it("rejects malformed paths, identifiers, lists, and extra arguments", () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerSkillsIpc(ipc, service);
    const event = {} as IpcMainInvokeEvent;

    expect(() => handlers.get(SKILLS_IPC.upload.channel)?.(event, "", false)).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.reveal.channel)?.(event, "/tmp/skill\0hidden")).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.install.channel)?.(event, "   ")).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.downloadMany.channel)?.(event, ["valid", 1])).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.downloadMany.channel)?.(event, Array.from({ length: 501 }, () => "fp"))).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.getDiff.channel)?.(event, 123, null)).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.list.channel)?.(event, true)).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.importLocal.channel)?.(event, ["/tmp/valid", 1])).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.updateTargets.channel)?.(event, "../review", ["codex"])).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.updateTargets.channel)?.(event, "review", ["cursor"])).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.listDiscovered.channel)?.(event, { page: -1, query: "" })).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.listDiscovered.channel)?.(event, { page: 0, query: "", extra: true })).toThrow(IpcInputError);
    expect(() => handlers.get(SKILLS_IPC.getDiscovered.channel)?.(event, "owner/repo")).toThrow(IpcInputError);

    expect(service.upload).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.downloadMany).not.toHaveBeenCalled();
    expect(service.getDiff).not.toHaveBeenCalled();
    expect(service.listSkills).not.toHaveBeenCalled();
    expect(service.importLocalSkills).not.toHaveBeenCalled();
    expect(service.updateManagedSkillTargets).not.toHaveBeenCalled();
    expect(service.listDiscoveredSkills).not.toHaveBeenCalled();
    expect(service.getDiscoveredSkill).not.toHaveBeenCalled();
  });

  it("removes every registered handler through its disposer", () => {
    const { ipc, handlers, removed } = createMainRegistrar();
    const dispose = registerSkillsIpc(ipc, createService());
    dispose();
    expect(handlers.size).toBe(0);
    expect(removed.sort()).toEqual(Object.values(SKILLS_IPC).map((contract) => contract.channel).sort());
  });

  it("builds the existing preload API from the shared contracts", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createSkillsApi({ invoke } as unknown as Parameters<typeof createSkillsApi>[0]);

    await api.listSkills();
    await api.listSkillImportCandidates();
    await api.importLocalSkills(["/tmp/review/SKILL.md"]);
    await api.updateManagedSkillTargets("review", ["codex", "trae"]);
    await api.listDiscoveredSkills({ page: 0, query: "review" });
    await api.getDiscoveredSkill("owner/repo/review");
    await api.importDiscoveredSkill("owner/repo/review");
    await api.refreshSkillUsage();
    await api.getSkillSyncSnapshot();
    await api.uploadSkillToSync("/tmp/skill/SKILL.md", true);
    await api.installSyncedSkill("remote-1");
    await api.downloadSyncedSkills(["fp-1"]);
    await api.deleteSyncedSkills(["fp-2"]);
    await api.getSyncedSkillVersion("remote-2");
    await api.getSyncedSkillDiff(null, "remote-3");
    await api.copySkillSyncSetupSql();
    await api.copySkillPath("/tmp/skill/SKILL.md");
    await api.revealSkill("/tmp/skill");
    await api.deleteSkill("/tmp/skill/SKILL.md");
    await api.getSkillUsageHookStatus();
    await api.installSkillUsageHook();
    await api.uninstallSkillUsageHook();

    expect(invoke.mock.calls).toEqual([
      [SKILLS_IPC.list.channel],
      [SKILLS_IPC.listImportCandidates.channel],
      [SKILLS_IPC.importLocal.channel, ["/tmp/review/SKILL.md"]],
      [SKILLS_IPC.updateTargets.channel, "review", ["codex", "trae"]],
      [SKILLS_IPC.listDiscovered.channel, { page: 0, query: "review" }],
      [SKILLS_IPC.getDiscovered.channel, "owner/repo/review"],
      [SKILLS_IPC.importDiscovered.channel, "owner/repo/review"],
      [SKILLS_IPC.refreshUsage.channel],
      [SKILLS_IPC.getSyncSnapshot.channel],
      [SKILLS_IPC.upload.channel, "/tmp/skill/SKILL.md", true],
      [SKILLS_IPC.install.channel, "remote-1"],
      [SKILLS_IPC.downloadMany.channel, ["fp-1"]],
      [SKILLS_IPC.deleteMany.channel, ["fp-2"]],
      [SKILLS_IPC.getVersion.channel, "remote-2"],
      [SKILLS_IPC.getDiff.channel, null, "remote-3"],
      [SKILLS_IPC.copySetupSql.channel],
      [SKILLS_IPC.copyPath.channel, "/tmp/skill/SKILL.md"],
      [SKILLS_IPC.reveal.channel, "/tmp/skill"],
      [SKILLS_IPC.delete.channel, "/tmp/skill/SKILL.md"],
      [SKILLS_IPC.getUsageHookStatus.channel],
      [SKILLS_IPC.installUsageHook.channel],
      [SKILLS_IPC.uninstallUsageHook.channel],
    ]);
  });
});
