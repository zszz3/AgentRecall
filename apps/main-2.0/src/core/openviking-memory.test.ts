import { describe, expect, it } from "vitest";
import {
  importTurnFingerprint,
  normalizeWorkspacePath,
  workspaceUserId,
} from "./openviking-memory";
import { isOpenVikingMemoryTransient } from "./openviking-memory-lifecycle";

describe("OpenViking workspace identity", () => {
  it("derives a deterministic, account-safe user ID from a stable workspace identity", () => {
    const identity = "repo:github.com/acme/app";

    expect(workspaceUserId(identity)).toMatch(/^workspace_[a-f0-9]{24}$/);
    expect(workspaceUserId(identity)).toBe(workspaceUserId(identity));
    expect(workspaceUserId("repo:github.com/acme/other")).not.toBe(workspaceUserId(identity));
  });

  it("normalizes directory paths without applying POSIX rules to Windows paths", () => {
    expect(normalizeWorkspacePath("/Users/me/project/../project/")).toBe("/Users/me/project");
    expect(normalizeWorkspacePath("C:\\Users\\me\\project\\..\\project\\", "win32")).toBe(
      "C:\\Users\\me\\project",
    );
  });

  it("fingerprints the same imported turn consistently and separates changed content", () => {
    const first = importTurnFingerprint({
      source: "codex-cli",
      sessionId: "session-1",
      turnIndex: 2,
      user: "question",
      assistant: "answer",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(importTurnFingerprint({
      source: "codex-cli",
      sessionId: "session-1",
      turnIndex: 2,
      user: "question",
      assistant: "answer",
    })).toBe(first);
    expect(importTurnFingerprint({
      source: "codex-cli",
      sessionId: "session-1",
      turnIndex: 2,
      user: "question",
      assistant: "changed",
    })).not.toBe(first);
  });

  it("polls only while runtime preparation or imports are actively progressing", () => {
    const snapshot = {
      runtime: { state: "running" as const },
      model: { model: "BAAI/bge-small-zh-v1.5" as const, installed: true },
      workspaces: [{
        id: "workspace-1",
        userId: "workspace_abcd",
        rootPath: "/repo",
        identity: "path:one",
        displayName: "repo",
        managed: true,
        importState: "idle" as const,
        importedTurns: 0,
        totalTurns: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
      }],
    };

    expect(isOpenVikingMemoryTransient(snapshot, false)).toBe(false);
    expect(isOpenVikingMemoryTransient({
      ...snapshot,
      workspaces: [{ ...snapshot.workspaces[0], importState: "queued" }],
    }, false)).toBe(true);
    expect(isOpenVikingMemoryTransient({
      ...snapshot,
      runtime: { state: "starting" },
    }, false)).toBe(true);
    expect(isOpenVikingMemoryTransient(snapshot, true)).toBe(true);
  });
});
