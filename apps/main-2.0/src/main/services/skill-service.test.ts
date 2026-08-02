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
    source: "agent-recall-v2",
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
    source: "agent-recall-v2",
    localFingerprint: "fp-review",
    contentHash: "remote-hash",
    uploadedFromPath: "/old/path",
    portableScope: "agent-recall-v2",
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
    source: "agent-recall-v2",
    portableScope: "agent-recall-v2",
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
    listProjects: vi.fn(async () => []),
    getSkillUsageSnapshot: vi.fn(async () => ({
      path: "/tmp/usage.jsonl",
      exists: true,
      totalEvents: 3,
      stats: [{ skill: "review", count: 3, lastUsedAt: 100 }],
      byName: { review: { skill: "review", count: 3, lastUsedAt: 100 } },
      byAgentName: { "codex:review": { skill: "review", count: 3, lastUsedAt: 100 } },
    })),
    isSkillUsageSourceFresh: vi.fn(async () => false),
    upsertSkillUsageSource: vi.fn(async () => undefined),
    pruneSkillUsageSources: vi.fn(async () => undefined),
    listRecentSkillTriggers: vi.fn(async () => [{
      agent: "claude" as const,
      skill: "review",
      occurredAt: 100,
      linkState: "linked-session" as const,
      sessionKey: "local:claude:abc",
      sessionTitle: "Fix bug",
      projectPath: "/repo",
      turnId: null,
    }]),
    listSkillUsageOverview: vi.fn(async () => [{
      agent: "claude" as const,
      skill: "review",
      totalTriggers: 3,
      triggers7d: 1,
      triggers30d: 2,
      lastTriggeredAt: 100,
      linkedTriggers: 1,
    }]),
    getSkillPerformanceSignals: vi.fn(async () => ({
      sampleSize: 1,
      medianTotalTokens: 30_000,
      medianDurationMs: 120_000,
      errorTurnRatio: 1,
      baselineTurnCount: 2,
      baselineMedianTotalTokens: 15_500,
      baselineMedianDurationMs: 60_000,
      baselineErrorTurnRatio: 0.5,
    })),
    listSkillVersionGroups: vi.fn(async () => [
      { skillHash: "hash-b", triggerCount: 1, firstTriggeredAt: 100, lastTriggeredAt: 100 },
      { skillHash: null, triggerCount: 2, firstTriggeredAt: 1, lastTriggeredAt: 50 },
    ]),
    listSkillToolOutcomes: vi.fn(async () => []),
    hasClaudeHookUsageEvents: vi.fn(async () => true),
    listSkillSyncBindings: vi.fn(async () => bindings),
    getSkillSyncBindingForPortableIdentity: vi.fn(async (identity) =>
      bindings.find((binding) => binding.portableIdentity === identity) ?? null),
    upsertSkillSyncBinding: vi.fn(async (binding) => {
      bindings.push(binding);
    }),
    deleteSkillSyncBindingsForRemoteIds: vi.fn(async () => undefined),
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
  const executeAiSearch = vi.fn(async () => executeAiSearch.mock.calls.length === 1
    ? JSON.stringify({
        queries: ["code review"],
        interpretation: "寻找代码审查 Skill。",
      })
    : JSON.stringify({
        recommendations: [{
          id: discoveredEntry.id,
          description: "审查代码变更并发现质量问题。",
          reason: "直接匹配代码审查需求。",
        }],
      }));
  const operations: SkillServiceOperations = {
    listInstalledSkills: vi.fn(() => ({ skills: [installedSkill()], roots: [], scannedAt: 1 })),
    skillProjectDirsFromIndexedProjects: vi.fn(() => []),
    usageForSkill: vi.fn(() => ({ skill: "review", count: 3, lastUsedAt: 100 })),
    listSkillUsageSources: vi.fn(() => usageSources),
    readSkillUsageSourceEvents: vi.fn(async () => [{ agent: "codex" as const, skill: "review", timestamp: 100 }]),
    isSyncableSkill: vi.fn(() => true),
    portableSkillLocation: vi.fn(() => ({ scope: "agent-recall-v2" as const, relativePath: "review", identity: "agent-recall/review" })),
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
    homeDir: "/tmp/agent-recall-test-home",
    managedLibrary,
    skillsShClient,
    executeAiSearch,
  });
  return { service, settings, store, bindings, usageSources, client, operations, hookSetup, copyText, revealPath, diffResult, managedLibrary, skillsShClient, discoveredEntry, discoveredPage, discoveredDetail, executeAiSearch };
}

describe("SkillService local skills and usage", () => {
  it("gates skill trigger listing behind the Eval setting", async () => {
    const disabled = createHarness();
    await expect(disabled.service.listSkillTriggers()).rejects.toThrow("Eval is disabled");
    expect(disabled.store.listRecentSkillTriggers).not.toHaveBeenCalled();

    const settings = structuredClone(defaultSettings);
    settings.evalEnabled = true;
    const enabled = createHarness({ settings });
    await expect(enabled.service.listSkillTriggers({ skill: "review", limit: 10 })).resolves.toMatchObject([
      { skill: "review", linkState: "linked-session", sessionKey: "local:claude:abc" },
    ]);
    expect(enabled.store.listRecentSkillTriggers).toHaveBeenCalledWith({ skill: "review", limit: 10 });
  });

  it("gates the live report behind the Eval setting", async () => {
    const disabled = createHarness();
    await expect(disabled.service.getSkillEvalOverview()).rejects.toThrow("Eval is disabled");
    await expect(disabled.service.getSkillEvalDetail("review")).rejects.toThrow("Eval is disabled");
    expect(disabled.store.listSkillUsageOverview).not.toHaveBeenCalled();
  });

  it("labels unused skills never-used where transcripts are scanned and unobserved elsewhere", async () => {
    const settings = structuredClone(defaultSettings);
    settings.evalEnabled = true;
    const harness = createHarness({ settings });
    harness.managedLibrary.list = vi.fn(() => ({
      skills: [
        installedSkill(),
        { ...installedSkill(), id: "claude:ghost", name: "ghost", agent: "claude" as const },
        { ...installedSkill(), id: "codex:helper", name: "helper", agent: "codex" as const },
        { ...installedSkill(), id: "trae:opaque", name: "opaque", agent: "trae" as const },
      ],
      roots: [],
      scannedAt: 1,
    }));

    const overview = await harness.service.getSkillEvalOverview();
    expect(overview.hookInstalled).toBe(true);
    expect(overview.claudeHookObservable).toBe(true);
    expect(overview.skills.find((item) => item.skill === "review")).toMatchObject({
      observation: "exercised",
      installed: true,
      totalTriggers: 3,
      linkedTriggers: 1,
    });
    expect(overview.skills.find((item) => item.skill === "ghost")).toMatchObject({
      observation: "never-used",
      totalTriggers: 0,
    });
    // Trae keeps no transcript that the usage scan reads, so "no records" there
    // cannot be reported as "never used".
    expect(overview.skills.find((item) => item.skill === "opaque")).toMatchObject({
      observation: "unobserved",
    });

    // The hook only adds the trigger-time version fingerprint. Claude triggers
    // are read from the session transcripts, so dropping the hook must not turn
    // an unused claude skill into an unobservable one.
    harness.hookSetup.skillUsageHookStatus = vi.fn(() => ({ installed: false }));
    const withoutHook = await harness.service.getSkillEvalOverview();
    expect(withoutHook.claudeHookObservable).toBe(false);
    expect(withoutHook.skills.find((item) => item.skill === "ghost")).toMatchObject({ observation: "never-used" });
    expect(withoutHook.skills.find((item) => item.skill === "helper")).toMatchObject({ observation: "never-used" });
  });

  it("builds the eval detail with version groups and the bound remote version", async () => {
    const settings = structuredClone(defaultSettings);
    settings.evalEnabled = true;
    const harness = createHarness({ settings });
    harness.bindings.push({
      localSkillPath: installedSkill().directoryPath,
      portableIdentity: "agent-recall/review",
      remoteSkillId: "remote-v1",
      remoteUpdatedAt: "2026-07-16T00:00:00.000Z",
      remoteVersion: 4,
      lastContentHash: "remote-hash",
      lastSyncedAt: 1,
      direction: "upload",
    });

    const detail = await harness.service.getSkillEvalDetail("Review");
    expect(detail.skill).toBe("review");
    expect(detail.remoteVersion).toBe(4);
    // The fixture SKILL.md path does not exist, so the current hash (and any
    // "current" marking) degrades gracefully instead of guessing.
    expect(detail.currentHash).toBeNull();
    expect(detail.versions.map((group) => group.current)).toEqual([false, false]);
    expect(harness.store.getSkillPerformanceSignals).toHaveBeenCalledWith("Review");
    expect(harness.store.listSkillVersionGroups).toHaveBeenCalledWith("Review");
  });

  it("merges usage and hook state into the installed Skill snapshot", async () => {
    const harness = createHarness();
    const snapshot = await harness.service.listSkills();
    expect(snapshot.skills[0]).toMatchObject({ name: "review", usageCount: 3, lastUsedAt: 100 });
    expect(snapshot.usage).toEqual({ hookInstalled: true, logExists: true, totalEvents: 3 });
    expect(harness.managedLibrary.list).toHaveBeenCalledOnce();
    expect(harness.operations.listInstalledSkills).not.toHaveBeenCalled();
    expect(harness.operations.usageForSkill).toHaveBeenCalledWith(expect.any(Object), "review");
  });

  it("imports only explicitly selected local Skills and updates installation targets", async () => {
    const harness = createHarness();
    await harness.service.listImportCandidates();
    expect(harness.managedLibrary.listImportCandidates).toHaveBeenCalledWith([]);

    expect(await harness.service.importLocalSkills(["/tmp/a/SKILL.md", "/tmp/b/SKILL.md"])).toHaveLength(2);
    expect(harness.managedLibrary.importLocalSkill).toHaveBeenNthCalledWith(1, "/tmp/a/SKILL.md", []);
    expect(harness.managedLibrary.importLocalSkill).toHaveBeenNthCalledWith(2, "/tmp/b/SKILL.md", []);

    harness.service.updateManagedSkillTargets("review", ["codex", "trae"]);
    expect(harness.managedLibrary.updateTargets).toHaveBeenCalledWith("review", ["codex", "trae"]);
  });

  it("adds usage statistics to local Skills so the UI can rank them by use", async () => {
    const harness = createHarness();
    const localSkill: InstalledSkill = {
      ...installedSkill(),
      id: "codex-user:review",
      source: "codex-user",
      path: "/tmp/.codex/skills/review/SKILL.md",
      directoryPath: "/tmp/.codex/skills/review",
      rootPath: "/tmp/.codex/skills",
    };
    vi.mocked(harness.managedLibrary.listImportCandidates).mockReturnValue({
      skills: [localSkill],
      roots: [],
      scannedAt: 1,
    });

    expect((await harness.service.listImportCandidates()).skills[0]).toMatchObject({
      name: "review",
      usageCount: 3,
      lastUsedAt: 100,
    });
    expect(harness.operations.usageForSkill).toHaveBeenCalledWith(expect.any(Object), "review", "codex");
  });

  it("uses name-only usage for local Skill agents without scoped usage data", async () => {
    const harness = createHarness();
    const localSkill: InstalledSkill = {
      ...installedSkill(),
      id: "trae-user:review",
      agent: "trae",
      source: "trae-user",
      path: "/tmp/.trae/skills/review/SKILL.md",
      directoryPath: "/tmp/.trae/skills/review",
      rootPath: "/tmp/.trae/skills",
    };
    vi.mocked(harness.managedLibrary.listImportCandidates).mockReturnValue({
      skills: [localSkill],
      roots: [],
      scannedAt: 1,
    });

    await harness.service.listImportCandidates();

    expect(harness.operations.usageForSkill).toHaveBeenCalledWith(expect.any(Object), "review");
    expect(harness.operations.usageForSkill).not.toHaveBeenCalledWith(expect.any(Object), "review", "trae");
  });

  it("caches local Skill discovery until an explicit refresh", async () => {
    const harness = createHarness();

    await harness.service.listImportCandidates();
    await harness.service.listImportCandidates();
    expect(harness.managedLibrary.listImportCandidates).toHaveBeenCalledOnce();

    await harness.service.listImportCandidates(true);
    expect(harness.managedLibrary.listImportCandidates).toHaveBeenCalledTimes(2);
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

  it("uses the selected Runtime to plan discovery searches and caches the returned candidates", async () => {
    const settings = structuredClone(defaultSettings);
    settings.skillAiRuntimeId = "runtime-claude-team";
    const harness = createHarness({ settings });
    const result = await harness.service.aiSearchDiscoveredSkills({ query: "帮我找代码审查 Skill", language: "zh" });
    expect(result).toMatchObject({
      queries: ["code review"],
      interpretation: "寻找代码审查 Skill。",
      skills: [{
        ...harness.discoveredEntry,
        description: "审查代码变更并发现质量问题。",
        reason: "直接匹配代码审查需求。",
      }],
    });
    expect(harness.executeAiSearch).toHaveBeenCalledTimes(2);
    expect(harness.executeAiSearch).toHaveBeenCalledWith(
      "runtime-claude-team",
      expect.stringContaining("帮我找代码审查 Skill"),
    );
    expect(harness.skillsShClient.list).toHaveBeenCalledWith({ page: 0, query: "code review" });
    expect(harness.skillsShClient.getDetail).toHaveBeenCalledWith(harness.discoveredEntry);
    await expect(harness.service.getDiscoveredSkill(harness.discoveredEntry.id)).resolves.toBe(harness.discoveredDetail);
  });

  it("refreshes only stale usage sources and prunes removed files", async () => {
    const settings = structuredClone(defaultSettings);
    settings.includeTclaude = true;
    settings.includeCodeBuddyCli = true;
    const harness = createHarness({ settings });
    harness.usageSources.push(
      { agent: "codex", kind: "codex-session", path: "/tmp/a.jsonl", mtimeMs: 1, fileSize: 1 },
      { agent: "claude", kind: "claude-hook", path: "/tmp/b.jsonl", mtimeMs: 1, fileSize: 1 },
    );
    vi.mocked(harness.store.isSkillUsageSourceFresh).mockImplementation(
      async (source) => source.path.endsWith("a.jsonl"),
    );

    expect(await harness.service.refreshUsage()).toEqual({
      refreshed: 1,
      skipped: 1,
      total: 2,
      totalEvents: 3,
      lastRefreshedAt: 123,
    });
    expect(harness.operations.listSkillUsageSources).toHaveBeenCalledWith({
      homeDir: "/tmp/agent-recall-test-home",
      includeTclaude: true,
      includeTcodex: false,
      includeCodeBuddyCli: true,
      includeCodeWizCli: false,
      includeOpenClaw: false,
      includeHermes: false,
      includeOpenCode: false,
      includeZcode: false,
      includeCursorAgent: false,
      includeQoder: false,
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
  it("copies and reveals verified local Skill candidates", async () => {
    const harness = createHarness();
    const localSkill: InstalledSkill = {
      ...installedSkill(),
      id: "codex-user:review",
      source: "codex-user",
      path: "/tmp/.codex/skills/review/SKILL.md",
      directoryPath: "/tmp/.codex/skills/review",
      rootPath: "/tmp/.codex/skills",
    };
    vi.mocked(harness.managedLibrary.listImportCandidates).mockReturnValue({
      skills: [localSkill],
      roots: [],
      scannedAt: 1,
    });

    await harness.service.copyPath(localSkill.path);
    await harness.service.reveal(localSkill.directoryPath);

    expect(harness.copyText).toHaveBeenCalledWith(localSkill.path);
    expect(harness.revealPath).toHaveBeenCalledWith(localSkill.directoryPath);
    await expect(harness.service.copyPath("/tmp/not-a-skill/SKILL.md")).rejects.toThrow(/outside managed roots/i);
  });

  it("owns copy, reveal, delete, and hook operations", async () => {
    const harness = createHarness();
    harness.service.copySetupSql();
    await harness.service.copyPath(installedSkill().path);
    await harness.service.reveal(installedSkill().directoryPath);
    expect(await harness.service.delete(installedSkill().path)).toEqual({
      deletedPath: installedSkill().directoryPath,
      skillName: "review",
    });
    expect(harness.service.installUsageHook()).toBe("installed");
    expect(harness.service.uninstallUsageHook()).toBe("removed");

    expect(harness.copyText).toHaveBeenNthCalledWith(1, "setup sql");
    expect(harness.copyText).toHaveBeenNthCalledWith(2, installedSkill().path);
    expect(harness.revealPath).toHaveBeenCalledWith(installedSkill().directoryPath);
    expect(harness.managedLibrary.listImportCandidates).not.toHaveBeenCalled();
  });
});
