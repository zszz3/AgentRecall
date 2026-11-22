// @vitest-environment happy-dom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEnvironment, SessionMigrationProgress, SessionSearchResult, SessionTurnSummary } from "../../../../core/types";
import type { ActionStatus } from "../../app-types";
import { useSessionMigration, type SessionMigrationController } from "./use-session-migration";

const session = { sessionKey: "codex:a", source: "codex", projectPath: "/repo", environmentId: "local", environmentKind: "local" } as unknown as SessionSearchResult;
const environments = [
  { id: "local", kind: "local", label: "This Mac" },
  { id: "wsl:ubuntu", kind: "wsl", label: "Ubuntu" },
] as SessionEnvironment[];

describe("useSessionMigration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controller: SessionMigrationController;
  let status: ActionStatus | null;
  let emitProgress: (progress: SessionMigrationProgress) => void;
  const onMigrated = vi.fn(async () => undefined);
  const api = {
    migrateSession: vi.fn(),
    chooseLocalProjectDirectory: vi.fn(),
    onMigrationProgress: vi.fn((callback: (progress: SessionMigrationProgress) => void) => {
      emitProgress = callback;
      return () => undefined;
    }),
  };

  function Harness() {
    const [current, setStatus] = useState<ActionStatus | null>(null);
    status = current;
    controller = useSessionMigration({
      api,
      environments,
      language: "en",
      setStatus,
      onStarted: () => undefined,
      onMigrated,
      t: (en) => en,
    });
    return null;
  }

  beforeEach(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    api.migrateSession.mockReset();
    onMigrated.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("migrates up to the chosen Turn and keeps the dialog open with the command when the agent could not start", async () => {
    api.migrateSession.mockImplementationOnce(async () => {
      emitProgress({ target: "claude", stage: "writing" } as SessionMigrationProgress);
      return { target: "claude", strategy: "full", targetSessionId: "new-id", launched: false, resumeCommand: "claude --resume new-id" };
    });

    await act(async () => controller.begin(session, { id: "turn-7", turnIndex: 7 } as SessionTurnSummary));
    expect(controller.dialog).toMatchObject({ kind: "select", throughTurnIndex: 7 });
    await act(async () => controller.run("claude", false, "local"));

    expect(api.migrateSession).toHaveBeenCalledWith({ sessionKey: "codex:a", target: "claude", throughTurnId: "turn-7", targetEnvironmentId: "local" });
    expect(onMigrated).toHaveBeenCalledOnce();
    expect(controller.dialog).toMatchObject({ kind: "launch-failed", session });
    expect(controller.progress).toBeNull();
    expect(controller.busy).toBe(false);
    expect(status?.message).toContain("claude --resume new-id");
  });

  it("asks for a Linux project path before migrating into WSL", async () => {
    await act(async () => controller.begin(session));
    await act(async () => controller.run("codex", false, "wsl:ubuntu", "  "));

    expect(api.migrateSession).not.toHaveBeenCalled();
    expect(status).toEqual({ kind: "error", message: "Enter an absolute Linux project path or choose without a project path." });
  });
});
