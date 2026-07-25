import { describe, expect, it } from "vitest";
import type {
  CoreLiveSessionSnapshot,
  CoreSearchOptions,
  CoreSessionEnvironment,
  CoreSessionSourceFilter,
} from "./core-api";

// Compile-time negative assertions keep the public Core types from widening.
// @ts-expect-error Core environments never expose an SSH id.
const invalidEnvironmentId: CoreSessionEnvironment["id"] = "ssh-dev";
// @ts-expect-error Core environments never expose an SSH kind.
const invalidEnvironmentKind: CoreSessionEnvironment["kind"] = "ssh";
// @ts-expect-error Advanced session families are not part of Core live state.
const invalidLiveFamily: CoreLiveSessionSnapshot["sessions"][number]["family"] = "codebuddy";
// @ts-expect-error Advanced sources are not legal Core search filters.
const invalidSource: CoreSessionSourceFilter = "openclaw";
// @ts-expect-error Hidden records have no Core visibility mode.
const invalidVisibility: CoreSearchOptions["visibility"] = "hidden";
// @ts-expect-error Product source scoping is injected by main and never accepted from preload.
const invalidInternalScope: CoreSearchOptions = { allowedSources: ["claude-cli"] };

void [
  invalidEnvironmentId,
  invalidEnvironmentKind,
  invalidLiveFamily,
  invalidSource,
  invalidVisibility,
  invalidInternalScope,
];

describe("Core API value types", () => {
  it("describes listEnvironments as local-only", () => {
    const environment = {
      id: "local",
      kind: "local",
      label: "Local",
      hostAlias: null,
      host: null,
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: true,
      syncState: "idle",
      lastSyncedAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    } satisfies CoreSessionEnvironment;

    expect(environment.id).toBe("local");
    expect(environment.kind).toBe("local");
  });

  it("describes live sessions as Claude/Codex-only", () => {
    const snapshot = {
      generatedAt: "2026-07-25T00:00:00.000Z",
      sessions: [
        { family: "claude", rawId: "claude-session", pid: 1 },
        { family: "codex", rawId: "codex-session", pid: 2 },
      ],
    } satisfies CoreLiveSessionSnapshot;

    expect(snapshot.sessions.map((session) => session.family)).toEqual([
      "claude",
      "codex",
    ]);
  });
});
