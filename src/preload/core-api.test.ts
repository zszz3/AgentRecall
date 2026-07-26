import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IpcInputError } from "../shared/ipc/contract";
import { createCoreApi, type CoreIpcRenderer } from "./core-api";

const EXPECTED_CORE_API_KEYS = [
  "productProfile",
  "platform",
  "searchSessionPage",
  "getSession",
  "getMessages",
  "getTraceEvents",
  "getLiveSessions",
  "listTags",
  "listProjects",
  "listTagsByProject",
  "listEnvironments",
  "setCustomTitle",
  "setFavorited",
  "refreshIndex",
  "getIndexStatus",
  "getSettings",
  "setSettings",
  "getNativeUpdateState",
  "checkNativeUpdate",
  "downloadNativeUpdate",
  "installNativeUpdate",
  "retryNativeUpdate",
  "copyNativeUpdateDiagnostics",
  "openNativeUpdateHelp",
  "openNativeUpdateReleases",
  "getPrivacyDiagnostics",
  "inspectLegacyIntegrations",
  "previewLegacyCleanup",
  "applyLegacyCleanup",
  "resumeSession",
  "onIndexStatus",
  "onFocusSearch",
  "onOpenSettings",
  "onNativeUpdateState",
] as const;

const FORBIDDEN_ADVANCED_API_KEYS = [
  "askAiAssistant",
  "summarizeSession",
  "summarizeMissingSessions",
  "onSummaryProgress",
  "getStats",
  "getQuotas",
  "getMcpStatus",
  "setMcpEnabled",
  "listSshConfigHosts",
  "saveEnvironment",
  "refreshEnvironment",
  "diagnoseEnvironment",
  "deleteEnvironment",
  "onEnvironmentsUpdated",
  "addTag",
  "removeTag",
  "deleteTag",
  "setPinned",
  "setHidden",
  "deleteSession",
  "copyResumeCommand",
  "resumeSessionInIterm",
  "migrateSession",
  "onMigrationProgress",
  "openNativeApp",
  "revealSession",
  "copyMarkdown",
  "exportMarkdown",
  "copyPlainText",
  "getCodexConfig",
  "probeCodexModels",
  "applyCodexProfile",
  "applyClaudeProfile",
  "getCodexChatProxyStatus",
  "stopCodexChatProxy",
  "getApiProviderKey",
  "listSkills",
  "refreshSkillUsage",
  "getRemoteSessionStatus",
  "listSessionSyncItems",
  "uploadRemoteSession",
  "copyCombinedSyncSetupSql",
  "openSupabaseSqlEditor",
] as const;

interface FakeIpc {
  ipc: CoreIpcRenderer;
  invokes: Array<{ channel: string; args: unknown[] }>;
  emit(channel: string, value?: unknown): void;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

function fakeIpc(): FakeIpc {
  const invokes: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    listeners.set(channel, listener);
  });
  const removeListener = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    if (listeners.get(channel) === listener) listeners.delete(channel);
  });
  const ipc = {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => {
      invokes.push({ channel, args });
      return undefined;
    }),
    on,
    removeListener,
  } as unknown as CoreIpcRenderer;
  return {
    ipc,
    invokes,
    on,
    removeListener,
    emit(channel, value) {
      listeners.get(channel)?.({}, value);
    },
  };
}

describe("production Core preload API", () => {
  it("exposes exactly the hard-coded Core API and no advanced capabilities", () => {
    const fake = fakeIpc();
    const api = createCoreApi(fake.ipc, "darwin");

    expect(Object.keys(api)).toEqual(EXPECTED_CORE_API_KEYS);
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.productProfile.id).toBe("core-v1");
    expect(api.platform).toBe("darwin");
    for (const key of FORBIDDEN_ADVANCED_API_KEYS) {
      expect(key in api, key).toBe(false);
    }
  });

  it("routes every Core command through the exact request channel", async () => {
    const fake = fakeIpc();
    const api = createCoreApi(fake.ipc, "linux");

    await api.searchSessionPage({ source: "claude", environmentId: "local" });
    await api.getSession("claude:one");
    await api.getMessages("claude:one", 0, 20);
    await api.getTraceEvents("claude:one", { limit: 20 });
    await api.getLiveSessions();
    await api.listTags({ environmentId: "local" });
    await api.listProjects({ environmentId: "local" });
    await api.listTagsByProject();
    await api.listEnvironments();
    await api.setCustomTitle("claude:one", "Renamed");
    await api.setFavorited("claude:one", true);
    await api.refreshIndex();
    await api.getIndexStatus();
    await api.getSettings();
    await api.setSettings({ autoCheckUpdates: false });
    await api.getNativeUpdateState();
    await api.checkNativeUpdate();
    await api.downloadNativeUpdate();
    await api.installNativeUpdate();
    await api.retryNativeUpdate();
    await api.copyNativeUpdateDiagnostics();
    await api.openNativeUpdateHelp();
    await api.openNativeUpdateReleases();
    await api.getPrivacyDiagnostics();
    await api.inspectLegacyIntegrations();
    await api.previewLegacyCleanup();
    await api.applyLegacyCleanup("plan-1", true);
    await api.resumeSession("claude:one");

    expect(fake.invokes).toEqual([
      { channel: "search:session-page", args: [{ source: "claude", environmentId: "local" }] },
      { channel: "session:get", args: ["claude:one"] },
      { channel: "session:messages", args: ["claude:one", 0, 20] },
      { channel: "session:trace-events", args: ["claude:one", { limit: 20 }] },
      { channel: "sessions:live", args: [] },
      { channel: "tags:list", args: [{ environmentId: "local" }] },
      { channel: "projects:list", args: [{ environmentId: "local" }] },
      { channel: "tags:by-project", args: [] },
      { channel: "environments:list", args: [] },
      { channel: "title:set", args: ["claude:one", "Renamed"] },
      { channel: "favorite:set", args: ["claude:one", true] },
      { channel: "index:refresh", args: [] },
      { channel: "index:status", args: [] },
      { channel: "settings:get", args: [] },
      { channel: "settings:set", args: [{ autoCheckUpdates: false }] },
      { channel: "native-update:get-state", args: [] },
      { channel: "native-update:check", args: [] },
      { channel: "native-update:download", args: [] },
      { channel: "native-update:install", args: [] },
      { channel: "native-update:retry", args: [] },
      { channel: "native-update:copy-diagnostics", args: [] },
      { channel: "native-update:open-help", args: [] },
      { channel: "native-update:open-releases", args: [] },
      { channel: "privacy:diagnostics", args: [] },
      { channel: "privacy:legacy-inspect", args: [] },
      { channel: "privacy:legacy-preview", args: [] },
      { channel: "privacy:legacy-apply", args: ["plan-1", true] },
      { channel: "command:resume", args: ["claude:one"] },
    ]);
  });

  it("validates untyped renderer input before invoking IPC", () => {
    const fake = fakeIpc();
    const api = createCoreApi(fake.ipc, "darwin");
    const unsafeSearch = api.searchSessionPage as (options: unknown) => unknown;
    const unsafeSettings = api.setSettings as (settings: unknown) => unknown;
    const unsafeCleanup = api.applyLegacyCleanup as (
      planId: unknown,
      confirmed: unknown,
    ) => unknown;

    expect(() => unsafeSearch({ source: "openclaw" })).toThrow(IpcInputError);
    expect(() => unsafeSearch({ environmentId: "ssh-prod" })).toThrow(IpcInputError);
    expect(() => unsafeSearch({ allowedSources: ["claude-cli"] })).toThrow(IpcInputError);
    expect(() => unsafeSettings({ remoteSyncEnabled: true })).toThrow(IpcInputError);
    expect(() => unsafeCleanup("../outside", true)).toThrow(IpcInputError);
    expect(() => unsafeCleanup("plan-1", false)).toThrow(IpcInputError);
    expect(fake.invokes).toEqual([]);
  });

  it("subscribes only to Core and update events and removes the same listeners", () => {
    const fake = fakeIpc();
    const api = createCoreApi(fake.ipc, "darwin");
    const values: unknown[] = [];
    const disposers = [
      api.onIndexStatus((value) => values.push(value)),
      api.onFocusSearch(() => values.push("focus")),
      api.onOpenSettings(() => values.push("settings")),
      api.onNativeUpdateState((value) => values.push(value)),
    ];

    expect(fake.on.mock.calls.map(([channel]) => channel)).toEqual([
      "index-status",
      "focus-search",
      "open-settings",
      "native-update:state",
    ]);
    fake.emit("focus-search");
    fake.emit("open-settings");
    expect(values).toEqual(["focus", "settings"]);

    for (const dispose of disposers) dispose();
    expect(fake.removeListener.mock.calls.map(([channel]) => channel)).toEqual([
      "index-status",
      "focus-search",
      "open-settings",
      "native-update:state",
    ]);
  });

  it("keeps the production preload entrypoint isolated from legacy modules", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(source).toContain('import { createCoreApi } from "./core-api"');
    expect(source).toContain('contextBridge.exposeInMainWorld("sessionSearch", api)');
    expect(source).not.toContain("legacy-preload");
    expect(source).not.toContain("createProvidersApi");
    expect(source).not.toContain("createSkillsApi");
    expect(source).not.toContain("createRemoteSessionsApi");
    expect(source).not.toContain("ipcRenderer.invoke(");
  });
});
