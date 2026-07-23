import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { RemoteSessionDetailSnapshot } from "../core/remote-session-sync";
import type { SessionMigrationProgress, SessionMigrationResult } from "../core/types";
import { createRemoteSessionsApi } from "../preload/remote-sessions";
import { IpcInputError } from "../shared/ipc/contract";
import { REMOTE_SESSIONS_IPC } from "../shared/ipc/remote-sessions";
import { registerRemoteSessionsIpc, type RemoteSessionsIpcService } from "./ipc/remote-sessions";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function migrationResult(target: "claude" | "codex" = "codex"): SessionMigrationResult {
  return {
    target,
    targetSessionId: "restored-session",
    targetFilePath: "/tmp/restored.jsonl",
    strategy: "complete",
    resumeCommand: `${target} resume restored-session`,
    indexed: true,
    launched: true,
  };
}

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

function createService(): RemoteSessionsIpcService {
  return {
    getStatus: vi.fn(async () => ({ kind: "ready" as const, setupSql: "select 1" })),
    copySetupSql: vi.fn(),
    getHookStatus: vi.fn(() => ({
      installed: true,
      claude: true,
      codex: true,
      pending: 0,
      lastProcessedAt: null,
      lastError: null,
    })),
    installHooks: vi.fn(() => ({
      installed: true,
      claude: true,
      codex: true,
      pending: 0,
      lastProcessedAt: null,
      lastError: null,
    })),
    uninstallHooks: vi.fn(() => ({
      installed: false,
      claude: false,
      codex: false,
      pending: 0,
      lastProcessedAt: null,
      lastError: null,
    })),
    upload: vi.fn(async () => ({ status: "uploaded" as const, remoteSession: {} as never })),
    list: vi.fn(async () => []),
    listSyncItems: vi.fn(async () => []),
    getDetail: vi.fn(async () => ({} as RemoteSessionDetailSnapshot)),
    previewAttachment: vi.fn(async () => ({ kind: "image" as const, data: "data:image/png;base64,eA==" })),
    chooseProject: vi.fn(async () => "/tmp/project"),
    restore: vi.fn(async (_remoteId, target, _projectPath, onProgress) => {
      onProgress({ sessionKey: "remote-1", target, stage: "writing" });
      return migrationResult(target);
    }),
    restoreToSource: vi.fn(async (_remoteId, target, onProgress) => {
      onProgress({ sessionKey: "remote-1", target, stage: "indexing" });
      return migrationResult(target);
    }),
    delete: vi.fn(async () => true),
    deleteMany: vi.fn(async (remoteIds) => ({
      requested: remoteIds.length,
      deletedIds: remoteIds,
      missingIds: [],
      failures: [],
    })),
  };
}

describe("Remote sessions IPC", () => {
  it("registers every contract, normalizes optional input, and forwards restore progress", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerRemoteSessionsIpc(ipc, service);
    const send = vi.fn();
    const event = { sender: { send } } as unknown as IpcMainInvokeEvent;

    expect([...handlers.keys()].sort()).toEqual(
      Object.values(REMOTE_SESSIONS_IPC).map((contract) => contract.channel).sort(),
    );

    await handlers.get(REMOTE_SESSIONS_IPC.getStatus.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.copySetupSql.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.getHookStatus.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.installHooks.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.uninstallHooks.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.upload.channel)?.(event, " session-key ");
    await handlers.get(REMOTE_SESSIONS_IPC.upload.channel)?.(event, "session-key", true);
    await handlers.get(REMOTE_SESSIONS_IPC.list.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.list.channel)?.(event, " query ");
    await handlers.get(REMOTE_SESSIONS_IPC.listSyncItems.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.getDetail.channel)?.(event, " remote-1 ");
    await handlers.get(REMOTE_SESSIONS_IPC.previewAttachment.channel)?.(
      event,
      `sessions/${"a".repeat(32)}/upload.attachments/image.png`,
      "b".repeat(64),
      "image/png",
      "image",
    );
    await handlers.get(REMOTE_SESSIONS_IPC.chooseProject.channel)?.(event);
    await handlers.get(REMOTE_SESSIONS_IPC.restore.channel)?.(event, " remote-1 ", "codex", " /tmp/project ");
    await handlers.get(REMOTE_SESSIONS_IPC.restoreToSource.channel)?.(event, "remote-1", "claude");
    await handlers.get(REMOTE_SESSIONS_IPC.delete.channel)?.(event, " remote-1 ");
    await handlers.get(REMOTE_SESSIONS_IPC.deleteMany.channel)?.(event, [" remote-1 ", "remote-2"]);

    expect(service.upload).toHaveBeenNthCalledWith(1, " session-key ", false);
    expect(service.upload).toHaveBeenNthCalledWith(2, "session-key", true);
    expect(service.list).toHaveBeenNthCalledWith(1, "");
    expect(service.list).toHaveBeenNthCalledWith(2, " query ");
    expect(service.getDetail).toHaveBeenCalledWith("remote-1");
    expect(service.restore).toHaveBeenCalledWith("remote-1", "codex", " /tmp/project ", expect.any(Function));
    expect(service.deleteMany).toHaveBeenCalledWith(["remote-1", "remote-2"]);
    expect(send).toHaveBeenNthCalledWith(1, "session:migration-progress", {
      sessionKey: "remote-1",
      target: "codex",
      stage: "writing",
    } satisfies SessionMigrationProgress);
    expect(send).toHaveBeenNthCalledWith(2, "session:migration-progress", {
      sessionKey: "remote-1",
      target: "claude",
      stage: "indexing",
    } satisfies SessionMigrationProgress);
  });

  it("rejects malformed or oversized input before calling the service", () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerRemoteSessionsIpc(ipc, service);
    const event = { sender: { send: vi.fn() } } as unknown as IpcMainInvokeEvent;

    expect(() => handlers.get(REMOTE_SESSIONS_IPC.getStatus.channel)?.(event, true)).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.upload.channel)?.(event, "bad\0key")).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.list.channel)?.(event, "q".repeat(2_001))).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.getDetail.channel)?.(event, "   ")).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.restore.channel)?.(event, "remote-1", "tclaude", "/tmp/project")).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.restore.channel)?.(event, "remote-1", "codex", "/tmp/bad\0path")).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.deleteMany.channel)?.(event, ["remote-1", 2])).toThrow(IpcInputError);
    expect(() => handlers.get(REMOTE_SESSIONS_IPC.deleteMany.channel)?.(
      event,
      Array.from({ length: 501 }, () => "remote-id"),
    )).toThrow(IpcInputError);

    expect(service.getStatus).not.toHaveBeenCalled();
    expect(service.upload).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
    expect(service.getDetail).not.toHaveBeenCalled();
    expect(service.restore).not.toHaveBeenCalled();
    expect(service.deleteMany).not.toHaveBeenCalled();
  });

  it("removes every registered handler through its disposer", () => {
    const { ipc, handlers, removed } = createMainRegistrar();
    const dispose = registerRemoteSessionsIpc(ipc, createService());
    dispose();

    expect(handlers.size).toBe(0);
    expect(removed.sort()).toEqual(
      Object.values(REMOTE_SESSIONS_IPC).map((contract) => contract.channel).sort(),
    );
  });

  it("builds the existing preload API from the shared contracts", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createRemoteSessionsApi({ invoke } as unknown as Parameters<typeof createRemoteSessionsApi>[0]);

    await api.getRemoteSessionStatus();
    await api.copyRemoteSessionSetupSql();
    await api.getSessionSyncHookStatus();
    await api.installSessionSyncHooks();
    await api.uninstallSessionSyncHooks();
    await api.uploadRemoteSession("session-1");
    await api.uploadRemoteSession("session-2", true);
    await api.listRemoteSessions();
    await api.listRemoteSessions("query");
    await api.listSessionSyncItems();
    await api.getRemoteSessionDetail("remote-1");
    await api.chooseRemoteRestoreProject();
    await api.restoreRemoteSession("remote-1", "codex", "/tmp/project");
    await api.restoreRemoteSessionToSourceEnvironment("remote-2", "claude");
    await api.deleteRemoteSession("remote-1");
    await api.deleteRemoteSessions(["remote-1", "remote-2"]);

    expect(invoke.mock.calls).toEqual([
      [REMOTE_SESSIONS_IPC.getStatus.channel],
      [REMOTE_SESSIONS_IPC.copySetupSql.channel],
      [REMOTE_SESSIONS_IPC.getHookStatus.channel],
      [REMOTE_SESSIONS_IPC.installHooks.channel],
      [REMOTE_SESSIONS_IPC.uninstallHooks.channel],
      [REMOTE_SESSIONS_IPC.upload.channel, "session-1", undefined],
      [REMOTE_SESSIONS_IPC.upload.channel, "session-2", true],
      [REMOTE_SESSIONS_IPC.list.channel, undefined],
      [REMOTE_SESSIONS_IPC.list.channel, "query"],
      [REMOTE_SESSIONS_IPC.listSyncItems.channel],
      [REMOTE_SESSIONS_IPC.getDetail.channel, "remote-1"],
      [REMOTE_SESSIONS_IPC.chooseProject.channel],
      [REMOTE_SESSIONS_IPC.restore.channel, "remote-1", "codex", "/tmp/project"],
      [REMOTE_SESSIONS_IPC.restoreToSource.channel, "remote-2", "claude"],
      [REMOTE_SESSIONS_IPC.delete.channel, "remote-1"],
      [REMOTE_SESSIONS_IPC.deleteMany.channel, ["remote-1", "remote-2"]],
    ]);
  });
});
