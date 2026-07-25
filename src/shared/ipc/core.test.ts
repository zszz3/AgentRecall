import { describe, expect, it } from "vitest";
import type {
  CoreProjectQueryOptions,
  CoreSearchOptions,
  CoreSettingsUpdate,
  CoreTagListOptions,
  CoreTraceEventQueryOptions,
} from "../core-api";
import {
  CORE_EVENTS,
  CORE_IPC,
} from "./core";
import {
  IpcInputError,
  parseIpcRequest,
  type IpcRequestContract,
} from "./contract";

const EXPECTED_CORE_IPC_CHANNELS = [
  "search:session-page",
  "session:get",
  "session:messages",
  "session:trace-events",
  "sessions:live",
  "tags:list",
  "projects:list",
  "tags:by-project",
  "environments:list",
  "title:set",
  "favorite:set",
  "index:refresh",
  "index:status",
  "settings:get",
  "settings:set",
  "command:resume",
] as const;

const EXPECTED_CORE_EVENTS = [
  "index-status",
  "focus-search",
  "open-settings",
] as const;

function expectInvalid<Args extends unknown[]>(
  contract: IpcRequestContract<Args>,
  input: unknown[],
): void {
  expect(() => parseIpcRequest(contract, input)).toThrow(IpcInputError);
}

describe("Core IPC contract", () => {
  it("registers only the hard-coded Core request and event channels", () => {
    expect(Object.values(CORE_IPC).map((contract) => contract.channel)).toEqual(
      EXPECTED_CORE_IPC_CHANNELS,
    );
    expect(Object.values(CORE_EVENTS)).toEqual(EXPECTED_CORE_EVENTS);
  });

  it("accepts the complete bounded Core search/filter shape", () => {
    const [parsed] = parseIpcRequest(CORE_IPC.searchSessionPage, [{
      query: "authentication regression",
      tag: "branch:codex/v1",
      projectPath: "/workspace/agent-recall",
      environmentId: "local",
      source: "claude-app",
      liveStatus: "open",
      liveSessionKeys: ["claude:session-1", "codex:session-2"],
      visibility: "favorites",
      sortBy: "activity",
      dateFrom: 1,
      dateTo: 2,
      limit: 30,
      excludeSubagents: true,
    }]);
    const typed: CoreSearchOptions = parsed;

    expect(typed).toMatchObject({
      source: "claude-app",
      environmentId: "local",
      visibility: "favorites",
      liveSessionKeys: ["claude:session-1", "codex:session-2"],
    });
  });

  it("rejects non-Core sources, environments, visibility modes, live keys, and internal scope", () => {
    for (const options of [
      { source: "openclaw" },
      { source: "claude-internal" },
      { environmentId: "ssh-production" },
      { visibility: "hidden" },
      { visibility: "pinned" },
      { liveSessionKeys: ["codebuddy:session-1"] },
      { liveSessionKeys: ["tclaude:session-1"] },
      { allowedSources: ["claude-cli"] },
    ]) {
      expectInvalid(CORE_IPC.searchSessionPage, [options]);
    }
  });

  it("keeps project and tag metadata requests local-only", () => {
    const [projectOptions] = parseIpcRequest(CORE_IPC.listProjects, [{
      environmentId: "local",
      excludeSubagents: true,
    }]);
    const [tagOptions] = parseIpcRequest(CORE_IPC.listTags, [{
      environmentId: "all",
      projectPath: "/workspace/agent-recall",
      projectEnvironmentId: "local",
    }]);
    const typedProjectOptions: CoreProjectQueryOptions | undefined = projectOptions;
    const typedTagOptions: CoreTagListOptions | undefined = tagOptions;

    expect(typedProjectOptions?.environmentId).toBe("local");
    expect(typedTagOptions?.projectEnvironmentId).toBe("local");
    expectInvalid(CORE_IPC.listProjects, [{ environmentId: "ssh-dev" }]);
    expectInvalid(CORE_IPC.listProjects, [{ allowedSources: ["codex-cli"] }]);
    expectInvalid(CORE_IPC.listTags, [{ environmentId: "ssh-dev" }]);
    expectInvalid(CORE_IPC.listTags, [{ projectEnvironmentId: "ssh-dev" }]);
    expectInvalid(CORE_IPC.listTags, [{ allowedSources: ["codex-cli"] }]);
  });

  it("validates detail pagination and trace windows at runtime", () => {
    expect(parseIpcRequest(CORE_IPC.getMessages, ["claude:session", 0, 80])).toEqual([
      "claude:session",
      0,
      80,
    ]);
    const [, traceOptions] = parseIpcRequest(CORE_IPC.getTraceEvents, [
      "codex:session",
      {
        startTimestamp: "2026-07-25T01:02:03.000Z",
        endTimestamp: "2026-07-25T02:03:04.000Z",
        limit: 300,
      },
    ]);
    const typedTraceOptions: CoreTraceEventQueryOptions | undefined = traceOptions;
    expect(typedTraceOptions?.limit).toBe(300);

    expectInvalid(CORE_IPC.getMessages, ["session", -1, 80]);
    expectInvalid(CORE_IPC.getMessages, ["session", 0, 1_001]);
    expectInvalid(CORE_IPC.getTraceEvents, ["session", { startTimestamp: "not-a-date" }]);
    expectInvalid(CORE_IPC.getSession, ["bad\0key"]);
  });

  it("accepts only Core settings and rejects advanced configuration fields", () => {
    const [parsed] = parseIpcRequest(CORE_IPC.setSettings, [{
      defaultTerminal: "WezTerm",
      globalShortcut: "Alt+Space",
      claudeBinary: "claude",
      codexBinary: "codex",
      hideSubagentSessions: true,
      autoCheckUpdates: false,
    }]);
    const typed: CoreSettingsUpdate = parsed;
    expect(typed.autoCheckUpdates).toBe(false);

    for (const update of [
      { remoteSyncEnabled: true },
      { skillSyncEnabled: true },
      { sessionSearchMcpEnabled: true },
      { summaryAutoBackfill: true },
      { apiConfig: {} },
      { hideCodexQuota: true },
      { includeOpenClaw: true },
      { claudeBinary: "" },
      { codexBinary: "bad\0path" },
    ]) {
      expectInvalid(CORE_IPC.setSettings, [update]);
    }
  });

  it("rejects arguments on no-input Core channels", () => {
    for (const contract of [
      CORE_IPC.getLiveSessions,
      CORE_IPC.listTagsByProject,
      CORE_IPC.listEnvironments,
      CORE_IPC.refreshIndex,
      CORE_IPC.getIndexStatus,
      CORE_IPC.getSettings,
    ]) {
      expectInvalid(contract, ["unexpected"]);
    }
  });
});
