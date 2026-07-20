import { describe, expect, it, vi } from "vitest";
import { defaultSettings, type AppSettings } from "../../core/platform";
import type { SkillSyncBinding } from "../../core/session-store";
import type { InstalledSkill } from "../../core/skill-manager";
import type { ManagedSkill, ManagedSkillImportResult } from "../../core/managed-skill-library";
import type { SkillsShDetail, SkillsShEntry, SkillsShPage } from "../../core/skills-sh";
import type { RemoteSkill, RemoteSkillGroup, RemoteSkillVersion, SkillVersionBasePayload } from "../../core/skill-sync";
import type { SkillUsageSource } from "../../core/skill-usage";
import {
  SkillService,
  type ManagedSkillLibraryPort,
  type SkillsShClientPort,
  type SkillServiceOperations,
  type SkillStorePort,
  type SkillSyncClientPort,
} from "./skill-service";

function installedSkill(): ManagedSkill {
  return {
    id: "agent-recall:review",
    name: "review",
    description: "Review code",
    agent: "codex",
    source: "agent-recall",
    path: "/tmp/agent-recall/skills/review/SKILL.md",
    directoryPath: "/tmp/agent-recall/skills/review",
    rootPath: "/tmp/agent-recall/skills",
    markdown: "# Review\n",
    mtimeMs: 1,
    managedId: "review",
    origin: { kind: "local", label: "Codex" },
    installations: [
      { target: "codex", path: "/tmp/.codex/skills/review", state: "installed" },
      { target: "claude", path: "/tmp/.claude/skills/review", state: "not-installed" },
      { target: "trae", path: "/tmp/.trae/skills/review", state: "not-installed" },
    ],
  };
}

function remoteVersion(overrides: Partial<RemoteSkillVersion> = {}): RemoteSkillVersion {
  return {
    id: "remote-v1",
    name: "review",
    description: "Review code",
    agent: "codex",
    source: "agent-recall",
    localFingerprint: "fp-review",
    contentHash: "remote-hash",
    uploadedFromPath: "/old/path",
    portableScope: "agent-recall",
    relativePath: "review",
    identityVersion: 2,
    legacy: false,
    version: 1,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function remoteSkill(overrides: Partial<RemoteSkill> = {}): RemoteSkill {
  return {
    ...remoteVersion(),
    markdown: "# Remote Review\n",
    metadata: {},
    ...overrides,
  };
}

function remoteGroup(version = remoteVersion()): RemoteSkillGroup {
  return {
    fingerprint: "fp-review",
    agent: "codex",
    name: "review",
    description: "Review code",
    source: "agent-recall",
    portableScope: "agent-recall",
    relativePath: "review",
    legacy: false,
    latest: version,
    versions: [version],
  };
}

function createHarness(options: { settings?: AppSettings; groups?: RemoteSkillGroup[] } = {}) {
  const settings = options.settings ?? structuredClone(defaultSettings);
  const bindings: SkillSyncBinding[] = [];
  const usageSources: SkillUsageSource[] = [];
  const store: SkillStorePort = {
    listProjects: vi.fn(() => []),
    getSkillUsageSnapshot: vi.fn(() => ({
      path: "/tmp/usage.jsonl",
      exists: true,
      totalEvents: 3,
      stats: [{ skill: "review", count: 3, lastUsedAt: 100 }],
      byName: { review: { skill: "review", count: 3, lastUsedAt: 100 } },
      byAgentName: { "codex:review": { skill: "review", count: 3, lastUsedAt: 100 } },
    })),
    isSkillUsageSourceFresh: vi.fn(() => false),
    upsertSkillUsageSource: vi.fn(),
    pruneSkillUsageSources: vi.fn(),
    listSkillSyncBindings: vi.fn(() => bindings),
    getSkillSyncBindingForPortableIdentity: vi.fn((identity) => bindings.find((binding) => binding.portableIdentity === identity) ?? null),
    upsertSkillSyncBinding: vi.fn((binding) => bindings.push(binding)),
    deleteSkillSyncBindingsForRemoteIds: vi.fn(),
  };
  const version = remoteVersion();
  const fullRemote = remoteSkill();
  const client: SkillSyncClientPort = {
    checkStatus: vi.fn(async () => ({ kind: "ready" as const, setupSql: "setup sql" })),
    listRemoteSkillVersions: vi.fn(async () => [version]),
    uploadSkillVersion: vi.fn(async () => fullRemote),
    getRemoteSkill: vi.fn(async () => fullRemote),
    deleteRemoteSkillVersions: vi.fn(async (ids) => ids),
  };
  const diffResult = { state: "different" as const, localHash: "local-hash", remoteHash: "remote-hash", files: [] };
  const importResult: ManagedSkillImportResult = { status: "imported", managedId: "review", skill: installedSkill() };
  const managedLibrary: ManagedSkillLibraryPort = {
    list: vi.fn(() => ({ skills: [installedSkill()], roots: [], scannedAt: 1 })),
    listImportCandidates: vi.fn(() => ({ skills: [], roots: [], scannedAt: 1 })),
    importLocalSkill: vi.fn(() => importResult),
    importFiles: vi.fn(() => importResult),
    replaceFiles: vi.fn(() => ({ ...importResult, status: "updated" as const })),
    updateTargets: vi.fn(() => installedSkill()),
    delete: vi.fn(() => ({ deletedPath: installedSkill().directoryPath, skillName: "review" })),
  };
  const discoveredEntry: SkillsShEntry = {
    id: "acme/tools/review",
    source: "acme/tools",
    owner: "acme",
    repo: "tools",
    skillId: "review",
    name: "Review",
    installs: 42,
    url: "https://skills.sh/acme/tools/review",
  };
  const discoveredPage: SkillsShPage = { skills: [discoveredEntry], total: 1, hasMore: false, page: 0, stale: false };
  const discoveredDetail: SkillsShDetail = {
    entry: discoveredEntry,
    hash: "download-hash",
    markdown: "# Review\n",
    files: [{ relativePath: "SKILL.md", contents: "# Review\n" }],
    stale: false,
  };
  const skillsShClient: SkillsShClientPort = {
    list: vi.fn(async () => discoveredPage),
    getDetail: vi.fn(async () => discoveredDetail),
  };
  const operations: SkillServiceOperations = {
    listInstalledSkills: vi.fn(() => ({ skills: [installedSkill()], roots: [], scannedAt: 1 })),
    skillProjectDirsFromIndexedProjects: vi.fn(() => []),
    usageForSkill: vi.fn(() => ({ skill: "review", count: 3, lastUsedAt: 100 })),
    listSkillUsageSources: vi.fn(() => usageSources),
    readSkillUsageSourceEvents: vi.fn(() => [{ agent: "codex" as const, skill: "review", timestamp: 100 }]),
    isSyncableSkill: vi.fn(() => true),
    portableSkillLocation: vi.fn(() => ({ scope: "agent-recall" as const, relativePath: "review", identity: "agent-recall/review" })),
    skillSyncLocalContentHash: vi.fn(async () => "local-hash"),
    skillSyncFingerprint: vi.fn(() => "fp-review"),
    buildSkillVersionBasePayload: vi.fn(() => ({ base: { metadata: {} } as SkillVersionBasePayload, contentHash: "local-hash" })),
    groupRemoteSkillVersions: vi.fn(() => options.groups ?? [remoteGroup(version)]),
    installRemoteSkillLocally: vi.fn(() => ({
      installedPath: installedSkill().path,
      directoryPath: installedSkill().directoryPath,
      overwritten: false,
    })),
    skillSyncFilesFromMetadata: vi.fn(() => []),
    buildSkillDiffSnapshot: vi.fn(() => diffResult),
    deleteInstalledSkill: vi.fn(() => ({ deletedPath: installedSkill().directoryPath, skillName: "review" })),
    buildSkillSyncSetupSql: vi.fn(() => "setup sql"),
  };
  const hookSetup = {
    installSkillUsageHook: vi.fn(() => ({ status: "installed" })),
    uninstallSkillUsageHook: vi.fn(() => ({ status: "removed" })),
    skillUsageHookStatus: vi.fn(() => ({ installed: true })),
  };
  const copyText = vi.fn();
  const revealPath = vi.fn(async () => undefined);
  const service = new SkillService({
    getStore: () => store,
    getSettings: () => settings,
    getHookSetup: () => hookSetup,
    createSyncClient: () => client,
    copyText,
    revealPath,
    now: () => 123,
    logError: vi.fn(),
    operations,
    managedLibrary,
    skillsShClient,
  });
  return { service, settings, store, bindings, usageSources, client, operations, hookSetup, copyText, revealPath, diffResult, managedLibrary, skillsShClient, discoveredEntry, discoveredPage, discoveredDetail };
}

describe("SkillService local skills and usage", () => {
  it("merges usage and hook state into the installed Skill snapshot", () => {
    const harness = createHarness();
    const snapshot = harness.service.listSkills();
    expect(snapshot.skills[0]).toMatchObject({ name: "review", usageCount: 3, lastUsedAt: 100 });
    expect(snapshot.usage).toEqual({ hookInstalled: true, logExists: true, totalEvents: 3 });
    expect(harness.managedLibrary.list).toHaveBeenCalledOnce();
    expect(harness.operations.listInstalledSkills).not.toHaveBeenCalled();
    expect(harness.operations.usageForSkill).toHaveBeenCalledWith(expect.any(Object), "review");
  });

  it("imports only explicitly selected local Skills and updates installation targets", () => {
    const harness = createHarness();
    harness.service.listImportCandidates();
    expect(harness.managedLibrary.listImportCandidates).toHaveBeenCalledWith([]);

    expect(harness.service.importLocalSkills(["/tmp/a/SKILL.md", "/tmp/b/SKILL.md"])).toHaveLength(2);
    expect(harness.managedLibrary.importLocalSkill).toHaveBeenNthCalledWith(1, "/tmp/a/SKILL.md", []);
    expect(harness.managedLibrary.importLocalSkill).toHaveBeenNthCalledWith(2, "/tmp/b/SKILL.md", []);

    harness.service.updateManagedSkillTargets("review", ["codex", "trae"]);
    expect(harness.managedLibrary.updateTargets).toHaveBeenCalledWith("review", ["codex", "trae"]);
  });

  it("lists, previews, and imports a selected skills.sh result", async () => {
    const harness = createHarness();
    await expect(harness.service.listDiscoveredSkills({ page: 0, query: "review" })).resolves.toBe(harness.discoveredPage);
    await expect(harness.service.getDiscoveredSkill(harness.discoveredEntry.id)).resolves.toBe(harness.discoveredDetail);
    await expect(harness.service.importDiscoveredSkill(harness.discoveredEntry.id)).resolves.toMatchObject({ managedId: "review" });
    expect(harness.managedLibrary.importFiles).toHaveBeenCalledWith(expect.objectContaining({
      suggestedId: "review",
      origin: expect.objectContaining({ kind: "skills-sh", source: "acme/tools" }),
      files: harness.discoveredDetail.files,
    }));
  });

  it("refreshes only stale usage sources and prunes removed files", () => {
    const harness = createHarness();
    harness.usageSources.push(
      { agent: "codex", kind: "codex-session", path: "/tmp/a.jsonl", mtimeMs: 1, fileSize: 1 },
      { agent: "claude", kind: "claude-hook", path: "/tmp/b.jsonl", mtimeMs: 1, fileSize: 1 },
    );
    vi.mocked(harness.store.isSkillUsageSourceFresh).mockImplementation((source) => source.path.endsWith("a.jsonl"));

    expect(harness.service.refreshUsage()).toEqual({
      refreshed: 1,
      skipped: 1,
      total: 2,
      totalEvents: 3,
      lastRefreshedAt: 123,
    });
    expect(harness.store.upsertSkillUsageSource).toHaveBeenCalledOnce();
    expect(harness.store.pruneSkillUsageSources).toHaveBeenCalledWith(["/tmp/a.jsonl", "/tmp/b.jsonl"]);
  });
});

describe("SkillService sync orchestration", () => {
  it("returns an unconfigured snapshot without constructing a remote client", async () => {
    const harness = createHarness();
    await expect(harness.service.getSyncSnapshot()).resolves.toMatchObject({
      status: { kind: "unconfigured", remediation: "settings" },
      remoteSkillGroups: [],
      bindings: [],
      relations: [],
      scannedAt: 123,
    });
    expect(harness.client.checkStatus).not.toHaveBeenCalled();
  });

  it("skips an unchanged upload and records its portable binding", async () => {
    const settings = structuredClone(defaultSettings);
    settings.skillSyncEnabled = true;
    settings.skillSyncSupabaseUrl = "https://project.supabase.co";
    settings.skillSyncSupabaseAnonKey = "anon";
    const sameVersion = remoteVersion({ contentHash: "local-hash" });
    const harness = createHarness({ settings, groups: [remoteGroup(sameVersion)] });
    vi.mocked(harness.client.listRemoteSkillVersions).mockResolvedValue([sameVersion]);

    await expect(harness.service.upload(installedSkill().path)).resolves.toMatchObject({
      status: "skipped",
      remoteSkillId: "remote-v1",
      version: 1,
    });
    expect(harness.store.upsertSkillSyncBinding).toHaveBeenCalledWith(expect.objectContaining({
      localSkillPath: installedSkill().path,
      portableIdentity: "agent-recall/review",
      lastContentHash: "local-hash",
      lastSyncedAt: 123,
      direction: "upload",
    }));
    expect(harness.client.uploadSkillVersion).not.toHaveBeenCalled();
  });

  it("requires confirmation for an unbound remote change and uploads the next version when forced", async () => {
    const settings = structuredClone(defaultSettings);
    settings.skillSyncEnabled = true;
    settings.skillSyncSupabaseUrl = "https://project.supabase.co";
    settings.skillSyncSupabaseAnonKey = "anon";
    const harness = createHarness({ settings });

    await expect(harness.service.upload(installedSkill().path, false)).resolves.toMatchObject({
      status: "needs-confirmation",
      conflict: { latestVersion: 1 },
    });
    await expect(harness.service.upload(installedSkill().path, true)).resolves.toMatchObject({
      status: "uploaded",
      version: 1,
    });
    expect(harness.client.uploadSkillVersion).toHaveBeenCalledWith(expect.any(Object), 2);
  });

  it("hydrates missing remote SKILL.md content before building a diff", async () => {
    const settings = structuredClone(defaultSettings);
    settings.skillSyncEnabled = true;
    settings.skillSyncSupabaseUrl = "https://project.supabase.co";
    settings.skillSyncSupabaseAnonKey = "anon";
    const harness = createHarness({ settings });

    await expect(harness.service.getDiff(installedSkill().path, "remote-v1")).resolves.toBe(harness.diffResult);
    expect(harness.operations.buildSkillDiffSnapshot).toHaveBeenCalledWith(
      { contentHash: "local-hash", files: [] },
      {
        contentHash: "remote-hash",
        files: [{
          relativePath: "SKILL.md",
          contentBase64: Buffer.from("# Remote Review\n", "utf8").toString("base64"),
        }],
      },
    );
  });
});

describe("SkillService utilities and hooks", () => {
  it("owns copy, reveal, delete, and hook operations", async () => {
    const harness = createHarness();
    harness.service.copySetupSql();
    harness.service.copyPath(installedSkill().path);
    await harness.service.reveal(installedSkill().directoryPath);
    expect(harness.service.delete(installedSkill().path)).toEqual({
      deletedPath: installedSkill().directoryPath,
      skillName: "review",
    });
    expect(harness.service.installUsageHook()).toBe("installed");
    expect(harness.service.uninstallUsageHook()).toBe("removed");

    expect(harness.copyText).toHaveBeenNthCalledWith(1, "setup sql");
    expect(harness.copyText).toHaveBeenNthCalledWith(2, installedSkill().path);
    expect(harness.revealPath).toHaveBeenCalledWith(installedSkill().directoryPath);
  });
});
