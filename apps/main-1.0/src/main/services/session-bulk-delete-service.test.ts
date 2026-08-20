import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
  SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
  type SessionBulkDeleteRequest,
  type SessionBulkDeleteTarget,
} from "../../core/session-bulk-delete";
import type { SessionStore } from "../../core/session-store";
import type { SessionEnvironment, SessionSource } from "../../core/types";
import { SessionBulkDeleteService } from "./session-bulk-delete-service";

function target(sessionKey: string, overrides: Partial<SessionBulkDeleteTarget> = {}): SessionBulkDeleteTarget {
  return {
    sessionKey, cascadeRootSessionKey: sessionKey, orphanedParentSessionId: null, rawId: sessionKey,
    source: "codex-cli", filePath: "missing.jsonl", isSubagent: false, parentSessionId: null,
    ancestorRawIds: [],
    sourceAvailable: false, favorited: false, lastActivityAt: 100,
    environmentId: "local", environmentKind: "local", ...overrides,
  };
}

function createStore(targets: SessionBulkDeleteTarget[], environments: SessionEnvironment[] = []) {
  return {
    getSessionDeletionTargets: vi.fn(() => targets),
    listEnvironments: vi.fn(() => environments),
    deleteSessionRecords: vi.fn((keys: readonly string[]) => [...keys]),
  } as unknown as SessionStore;
}

describe("SessionBulkDeleteService", () => {
  it("previews an empty cleanup scope without failing", () => {
    const store = createStore([]);
    expect(new SessionBulkDeleteService(store).preview({ sessionKeys: [], liveSessionKeys: [], inactiveBefore: 200 })).toMatchObject({
      requestedCount: 0,
      deletableCount: 0,
      skipped: [],
    });
  });

  it("previews protected sessions from one target lookup", () => {
    const targets = [
      target("old"),
      target("live"),
      target("favorite", { favorited: true }),
      target("recent", { lastActivityAt: 500 }),
      target("pi", { source: "pi-cli" }),
      target("kimi", { source: "kimi-cli" }),
      target("hermes", { source: "hermes" as SessionSource }),
      target("opencode", { source: "opencode-cli" }),
      target("codewiz", { source: "codewiz-cli" }),
      target("cursor", { source: "cursor-agent", filePath: "synthetic/state.vscdb", sourceAvailable: true }),
    ];
    const store = createStore(targets);
    const preview = new SessionBulkDeleteService(store).preview({
      sessionKeys: [...targets.map((item) => item.sessionKey), "missing"],
      liveSessionKeys: ["live"], inactiveBefore: 200, protectFavorites: false,
    });
    expect(preview.deletableCount).toBe(1);
    expect(preview.skipped.map((item) => item.reason)).toEqual([
      "live", "favorite", "recent", "read-only", "read-only",
      "shared-database", "shared-database", "shared-database", "shared-database", "not-found",
    ]);
    expect(store.getSessionDeletionTargets).toHaveBeenCalledTimes(1);
  });

  it("allows an explicitly selected favorite when favorite protection is disabled", () => {
    const store = createStore([target("favorite", { favorited: true })]);
    const preview = new SessionBulkDeleteService(store).preview({
      sessionKeys: ["favorite"], liveSessionKeys: [], protectFavorites: false,
    });
    expect(preview.deletableCount).toBe(1);
    expect(preview.skipped).toEqual([]);
  });

  it("fails closed when live sessions could not be checked until separately confirmed", async () => {
    const store = createStore([target("closed")]);
    const service = new SessionBulkDeleteService(store);
    const request: SessionBulkDeleteRequest = {
      sessionKeys: ["closed"],
      liveSessionKeys: [],
      liveSessionCheckFailed: true,
    };

    expect(service.preview(request)).toMatchObject({
      deletableCount: 1,
      liveSessionCheckFailed: true,
    });
    await expect(service.delete(request)).rejects.toThrow(
      SESSION_DELETE_LIVE_CHECK_CONFIRMATION_REQUIRED_MESSAGE,
    );
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();

    await expect(service.delete({
      ...request,
      confirmed: true,
      allowUnverifiedLiveSessions: true,
    })).resolves.toMatchObject({
      deletedSessionKeys: ["closed"],
      liveSessionCheckFailed: true,
    });
  });

  it("treats WorkBuddy source files as read-only", async () => {
    const store = createStore([target("workbuddy:session", { source: "workbuddy-cli", sourceAvailable: true })]);
    const service = new SessionBulkDeleteService(store);
    const request = {
      sessionKeys: ["workbuddy:session"],
      liveSessionKeys: [],
    };
    expect(service.preview(request)).toMatchObject({
      deletableCount: 0,
      skipped: [{ sessionKey: "workbuddy:session", reason: "read-only", message: "WorkBuddy session source files are read-only." }],
    });
    await expect(service.delete(request)).resolves.toMatchObject({ deletedSessionKeys: [], failed: [] });
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("previews and deletes an entire descendant tree as one unit", async () => {
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const store = createStore(targets);
    const service = new SessionBulkDeleteService(store);

    expect(service.preview({ sessionKeys: ["parent"], liveSessionKeys: [] })).toMatchObject({
      requestedCount: 1,
      matchedCount: 1,
      expandedCount: 2,
      deletableCount: 2,
    });
    await expect(service.delete({
      sessionKeys: ["parent"],
      liveSessionKeys: [],
      confirmed: true,
    })).resolves.toMatchObject({
      deletedSessionKeys: ["parent", "child"],
      failed: [],
    });
    expect(store.deleteSessionRecords).toHaveBeenCalledWith(["parent", "child"], false);
  });

  it("marks a related family even when both parent and child were explicitly selected", () => {
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
      target("child", {
        cascadeRootSessionKey: "child",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const preview = new SessionBulkDeleteService(createStore(targets)).preview({
      sessionKeys: ["parent", "child"],
      liveSessionKeys: [],
    });

    expect(preview).toMatchObject({
      requestedCount: 2,
      expandedCount: 2,
      deletableCount: 2,
      hasRelatedSessions: true,
    });
  });

  it("detects the open session when it is an expanded descendant", () => {
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const preview = new SessionBulkDeleteService(createStore(targets)).preview({
      sessionKeys: ["parent"],
      liveSessionKeys: [],
      openSessionKey: "child",
    });

    expect(preview.includesOpenSession).toBe(true);
    expect(preview.hasRelatedSessions).toBe(true);
  });

  it("requires final confirmation when a safe nine-session preview grows risky or reaches ten", async () => {
    const nineTargets = Array.from({ length: 9 }, (_, index) => target(`session-${index}`));
    const relatedChild = target("related-child", {
      cascadeRootSessionKey: "session-0",
      rawId: "related-child",
      isSubagent: true,
      parentSessionId: "session-0",
    });
    const store = createStore([]);
    vi.mocked(store.getSessionDeletionTargets)
      .mockReturnValueOnce(nineTargets)
      .mockReturnValueOnce([...nineTargets, relatedChild]);
    const service = new SessionBulkDeleteService(store);
    const request = {
      sessionKeys: nineTargets.map((item) => item.sessionKey),
      liveSessionKeys: [],
    };

    expect(service.preview(request)).toMatchObject({
      deletableCount: 9,
      hasRelatedSessions: false,
    });
    await expect(service.delete(request)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();

    const tenTargets = [...nineTargets, target("session-9")];
    const tenStore = createStore(tenTargets);
    const tenService = new SessionBulkDeleteService(tenStore);
    const tenRequest = {
      sessionKeys: tenTargets.map((item) => item.sessionKey),
      liveSessionKeys: [],
    };
    await expect(tenService.delete(tenRequest)).rejects.toThrow(
      SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE,
    );
    await expect(tenService.delete({ ...tenRequest, confirmed: true })).resolves.toMatchObject({
      deletedSessionKeys: tenTargets.map((item) => item.sessionKey),
    });
  });

  it("strictly validates bulk confirmation and open-session request fields", () => {
    const service = new SessionBulkDeleteService(createStore([]));
    expect(() => service.preview({
      sessionKeys: [],
      liveSessionKeys: [],
      confirmed: "yes",
    } as unknown as SessionBulkDeleteRequest)).toThrow("The bulk deletion confirmation option is invalid.");
    expect(() => service.preview({
      sessionKeys: [],
      liveSessionKeys: [],
      openSessionKey: 42,
    } as unknown as SessionBulkDeleteRequest)).toThrow("The open session key is invalid.");
  });

  it("requires confirmation when the final single-session preflight discovers a descendant", async () => {
    const parent = target("parent");
    const child = target("child", {
      cascadeRootSessionKey: "parent",
      rawId: "child",
      isSubagent: true,
      parentSessionId: "parent",
    });
    const store = createStore([]);
    vi.mocked(store.getSessionDeletionTargets)
      .mockReturnValueOnce([parent])
      .mockReturnValueOnce([parent, child]);
    const service = new SessionBulkDeleteService(store);
    const request = { sessionKeys: ["parent"], liveSessionKeys: [] };

    expect(service.preview(request).expandedCount).toBe(1);
    await expect(service.delete(request, { requireSingleSession: true }))
      .rejects.toThrow(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("allows a confirmed single-session request to delete its expanded tree", async () => {
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const store = createStore(targets);
    const service = new SessionBulkDeleteService(store);
    const request = { sessionKeys: ["parent"], liveSessionKeys: [] };
    const preview = service.preview(request);

    await expect(service.delete(
      request,
      { confirmed: true, confirmationFingerprint: preview.confirmationFingerprint, requireSingleSession: true },
    )).resolves.toMatchObject({
      deletedSessionKeys: ["parent", "child"],
      failed: [],
    });
  });

  it("keeps the whole tree when a descendant is live", () => {
    const targets = [
      target("parent"),
      target("child", { cascadeRootSessionKey: "parent", isSubagent: true, parentSessionId: "parent" }),
    ];
    const preview = new SessionBulkDeleteService(createStore(targets)).preview({
      sessionKeys: ["parent"],
      liveSessionKeys: ["child"],
    });

    expect(preview.deletableCount).toBe(0);
    expect(preview.expandedCount).toBe(2);
    expect(preview.skipped).toMatchObject([{ sessionKey: "child", reason: "live" }]);
  });

  it("only allows live deletion after confirmation explicitly permits it", async () => {
    const request = { sessionKeys: ["live"], liveSessionKeys: ["live"] };
    const service = new SessionBulkDeleteService(createStore([target("live")]));
    const preview = service.preview(request);
    await expect(new SessionBulkDeleteService(createStore([target("live")])).delete(
      request,
      { confirmed: true, requireSingleSession: true },
    )).rejects.toThrow(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    await expect(new SessionBulkDeleteService(createStore([target("live")])).delete(
      request,
      { allowLiveSessions: true, requireSingleSession: true },
    )).rejects.toThrow(SESSION_DELETE_CONFIRMATION_REQUIRED_MESSAGE);
    await expect(service.delete(
      request,
      {
        confirmed: true,
        allowLiveSessions: true,
        confirmationFingerprint: preview.confirmationFingerprint,
        requireSingleSession: true,
      },
    )).resolves.toMatchObject({
      deletedSessionKeys: ["live"],
      skipped: [],
      failed: [],
    });
  });

  it("allows confirmed live deletion for descendant and ancestor live matches", async () => {
    const family = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        rawId: "child",
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    const familyService = new SessionBulkDeleteService(createStore(family));
    const familyRequest = { sessionKeys: ["parent"], liveSessionKeys: ["child"] };
    const familyPreview = familyService.preview(familyRequest);
    await expect(familyService.delete(
      familyRequest,
      {
        confirmed: true,
        allowLiveSessions: true,
        confirmationFingerprint: familyPreview.confirmationFingerprint,
        requireSingleSession: true,
      },
    )).resolves.toMatchObject({
      deletedSessionKeys: ["parent", "child"],
      skipped: [],
    });

    const child = target("child", {
      rawId: "child",
      isSubagent: true,
      parentSessionId: "parent",
      ancestorRawIds: ["parent"],
    });
    const childService = new SessionBulkDeleteService(createStore([child]));
    const childRequest = { sessionKeys: ["child"], liveSessionKeys: ["codex:parent"] };
    const childPreview = childService.preview(childRequest);
    await expect(childService.delete(
      childRequest,
      {
        confirmed: true,
        allowLiveSessions: true,
        confirmationFingerprint: childPreview.confirmationFingerprint,
        requireSingleSession: true,
      },
    )).resolves.toMatchObject({
      deletedSessionKeys: ["child"],
      skipped: [],
    });
  });

  it("does not let live-session permission bypass other deletion protections", async () => {
    const targets = [
      target("favorite", { favorited: true }),
      target("recent", { lastActivityAt: 500 }),
      target("pi", { source: "pi-cli" }),
      target("remote", { environmentId: "remote", environmentKind: "ssh" }),
      target("shared", { source: "hermes" }),
    ];
    const store = createStore(targets);
    const service = new SessionBulkDeleteService(store);
    const request = {
      sessionKeys: targets.map((item) => item.sessionKey),
      liveSessionKeys: targets.map((item) => item.sessionKey),
      inactiveBefore: 200,
      protectFavorites: true,
    };
    const preview = service.preview(request);
    const result = await service.delete({
      ...request,
      confirmed: true,
      confirmationFingerprint: preview.confirmationFingerprint,
    }, {
      confirmed: true,
      allowLiveSessions: true,
    });

    expect(result.deletedSessionKeys).toEqual([]);
    expect(result.skipped.map((issue) => issue.reason)).toEqual([
      "favorite",
      "recent",
      "read-only",
      "remote-source",
      "shared-database",
    ]);
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("does not let an explicitly requested descendant bypass a blocked ancestor tree", () => {
    const targets = [
      target("parent"),
      target("child", { cascadeRootSessionKey: "parent", isSubagent: true, parentSessionId: "parent" }),
      target("child", { isSubagent: true, parentSessionId: "parent" }),
    ];
    const preview = new SessionBulkDeleteService(createStore(targets)).preview({
      sessionKeys: ["parent", "child"],
      liveSessionKeys: ["parent"],
    });

    expect(preview.deletableCount).toBe(0);
    expect(preview.skipped).toMatchObject([{ sessionKey: "parent", reason: "live" }]);
  });

  it("keeps a directly requested subtree when one of its ancestors is live", () => {
    const preview = new SessionBulkDeleteService(createStore([target("child", {
      rawId: "child",
      isSubagent: true,
      parentSessionId: "parent",
      ancestorRawIds: ["parent"],
    })])).preview({
      sessionKeys: ["child"],
      liveSessionKeys: ["codex:parent"],
    });

    expect(preview.deletableCount).toBe(0);
    expect(preview.skipped).toMatchObject([{ sessionKey: "child", reason: "live" }]);
  });

  it("matches live WSL sessions by source family and raw id", () => {
    const remoteKey = "wsl:ubuntu:codex-cli:remote-live";
    const preview = new SessionBulkDeleteService(createStore([target(remoteKey, {
      rawId: "remote-live",
      environmentId: "ubuntu",
      environmentKind: "wsl",
    })])).preview({
      sessionKeys: [remoteKey],
      liveSessionKeys: ["codex:remote-live"],
    });

    expect(preview.deletableCount).toBe(0);
    expect(preview.skipped).toMatchObject([{ sessionKey: remoteKey, reason: "live" }]);
  });

  it("ignores unresolved local family guards", () => {
    const preview = new SessionBulkDeleteService(createStore([target("claude:closed", {
      rawId: "closed",
      source: "claude-cli",
    })])).preview({
      sessionKeys: ["claude:closed"],
      liveSessionKeys: ["claude:*"],
    });

    expect(preview.deletableCount).toBe(1);
    expect(preview.skipped).toEqual([]);
  });

  it("ignores unresolved remote family guards", () => {
    const remoteKey = "wsl:ubuntu:claude-cli:closed";
    const service = new SessionBulkDeleteService(createStore([target(remoteKey, {
      rawId: "closed",
      source: "claude-cli",
      environmentId: "ubuntu",
      environmentKind: "wsl",
    })]));

    expect(service.preview({
      sessionKeys: [remoteKey],
      liveSessionKeys: ["debian\0claude:*"],
    }).deletableCount).toBe(1);
    expect(service.preview({
      sessionKeys: [remoteKey],
      liveSessionKeys: ["ubuntu\0claude:*"],
    }).deletableCount).toBe(1);
  });

  it("refuses WSL deletion when the environment is disabled and therefore was not scanned", async () => {
    const remoteKey = "wsl:ubuntu:claude-cli:closed";
    const store = createStore([target(remoteKey, {
      rawId: "closed",
      source: "claude-cli",
      filePath: "/home/me/.claude/projects/repo/closed.jsonl",
      sourceAvailable: true,
      environmentId: "ubuntu",
      environmentKind: "wsl",
    })], [{ id: "ubuntu", kind: "wsl", enabled: false } as SessionEnvironment]);

    await expect(new SessionBulkDeleteService(store).delete({
      sessionKeys: [remoteKey],
      liveSessionKeys: [],
    })).resolves.toMatchObject({
      deletedSessionKeys: [],
      failed: [{ sessionKey: remoteKey, reason: "delete-failed", message: "WSL environment is disabled." }],
    });
    expect(store.deleteSessionRecords).not.toHaveBeenCalled();
  });

  it("keeps source files untouched when the cascade root is cache-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cached-tree-delete-"));
    const targets = [
      target("parent"),
      target("child", {
        cascadeRootSessionKey: "parent",
        sourceAvailable: true,
        filePath: root,
        isSubagent: true,
        parentSessionId: "parent",
      }),
    ];
    try {
      await expect(new SessionBulkDeleteService(createStore(targets)).delete({
        sessionKeys: ["parent"],
        liveSessionKeys: [],
        confirmed: true,
      })).resolves.toMatchObject({ deletedSessionKeys: ["parent", "child"], failed: [] });
      expect(fs.existsSync(root)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans available sibling artifacts when an orphan family root is cache-only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-cached-orphan-delete-"));
    const sessionDirectory = path.join(root, "missing-parent");
    const subagentsDirectory = path.join(sessionDirectory, "subagents");
    const childFile = path.join(subagentsDirectory, "agent-child.jsonl");
    fs.mkdirSync(subagentsDirectory, { recursive: true });
    fs.writeFileSync(childFile, "fixture", "utf8");
    const targets = [
      target("orphan-root", {
        cascadeRootSessionKey: "orphan-root",
        orphanedParentSessionId: "missing-parent",
        source: "claude-cli",
        isSubagent: true,
        parentSessionId: "missing-parent",
      }),
      target("orphan-child", {
        cascadeRootSessionKey: "orphan-root",
        orphanedParentSessionId: "missing-parent",
        source: "claude-cli",
        sourceAvailable: true,
        filePath: childFile,
        isSubagent: true,
        parentSessionId: "missing-parent",
      }),
    ];

    try {
      await expect(new SessionBulkDeleteService(createStore(targets)).delete({
        sessionKeys: [],
        liveSessionKeys: [],
        includeOrphanedSubagents: true,
        confirmed: true,
      })).resolves.toMatchObject({ deletedSessionKeys: ["orphan-root", "orphan-child"], failed: [] });
      expect(fs.existsSync(subagentsDirectory)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requests orphaned subagent trees without explicit session keys", () => {
    const orphan = target("orphan", { isSubagent: true, parentSessionId: "missing" });
    const store = createStore([orphan]);

    expect(new SessionBulkDeleteService(store).preview({
      sessionKeys: [],
      liveSessionKeys: [],
      includeOrphanedSubagents: true,
    })).toMatchObject({ requestedCount: 1, matchedCount: 1, deletableCount: 1 });
    expect(store.getSessionDeletionTargets).toHaveBeenCalledWith([], true);
  });

  it("keeps failures retryable and deletes successful indexes in one batch", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-recall-bulk-delete-"));
    const targets = [target("cached"), target("directory", { sourceAvailable: true, filePath: root })];
    const store = createStore(targets);
    try {
      const result = await new SessionBulkDeleteService(store).delete({ sessionKeys: ["cached", "directory"], liveSessionKeys: [] });
      expect(result.deletedSessionKeys).toEqual(["cached"]);
      expect(result.failed).toMatchObject([{ sessionKey: "directory", reason: "delete-failed" }]);
      expect(store.getSessionDeletionTargets).toHaveBeenCalledTimes(1);
      expect(store.deleteSessionRecords).toHaveBeenCalledTimes(1);
      expect(store.deleteSessionRecords).toHaveBeenCalledWith(["cached"], false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
