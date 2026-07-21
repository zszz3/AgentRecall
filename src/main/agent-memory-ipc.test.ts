import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createAgentMemoryApi } from "../preload/agent-memory";
import { AGENT_MEMORY_IPC } from "../shared/ipc/agent-memory";
import { IpcInputError } from "../shared/ipc/contract";
import { registerAgentMemoryIpc, type AgentMemoryIpcService } from "./ipc/agent-memory";
import type { IpcMainRegistrar } from "./ipc/register-ipc-handler";

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createMainRegistrar() {
  const handlers = new Map<string, RegisteredHandler>();
  const ipc = {
    handle(channel: string, listener: RegisteredHandler) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  } as unknown as IpcMainRegistrar;
  return { ipc, handlers };
}

function createService(): AgentMemoryIpcService & Record<keyof AgentMemoryIpcService, ReturnType<typeof vi.fn>> {
  return {
    choose: vi.fn(async () => ({
      rootPath: "/repo", selectedDirectoryPath: "/repo/apps/web", selectedDirectory: "apps/web",
      files: [], directories: ["", "apps", "apps/web"], scannedAt: 1,
    })),
    refresh: vi.fn(async () => null),
    read: vi.fn(async () => ({
      relativePath: "AGENTS.md", scopeDirectory: "", name: "AGENTS.md", kind: "agents" as const,
      size: 0, modifiedAt: 1, content: "",
    })),
    save: vi.fn(async () => ({
      relativePath: "AGENTS.md", scopeDirectory: "", name: "AGENTS.md", kind: "agents" as const,
      size: 8, modifiedAt: 2, content: "# Memory",
    })),
    create: vi.fn(async () => ({
      relativePath: "CLAUDE.md", scopeDirectory: "", name: "CLAUDE.md", kind: "claude" as const,
      size: 0, modifiedAt: 2, content: "",
    })),
    effectiveContext: vi.fn(async () => ({ target: "codex" as const, sources: [], content: "" })),
    previewSync: vi.fn(async () => ({
      id: "preview-1", sourceRelativePath: "AGENTS.md", items: [],
    })),
    applySync: vi.fn(async () => ({
      snapshot: {
        rootPath: "/repo", selectedDirectoryPath: "/repo/apps/web", selectedDirectory: "apps/web",
        files: [], directories: ["", "apps", "apps/web"], scannedAt: 2,
      },
      undoId: "undo-1",
      changedPaths: ["apps/web/CLAUDE.md"],
    })),
    undoSync: vi.fn(async () => ({
      rootPath: "/repo", selectedDirectoryPath: "/repo/apps/web", selectedDirectory: "apps/web",
      files: [], directories: ["", "apps", "apps/web"], scannedAt: 3,
    })),
  };
}

describe("Agent memory IPC", () => {
  it("registers shared contracts and delegates validated requests", async () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerAgentMemoryIpc(ipc, service);
    const event = {} as IpcMainInvokeEvent;

    await handlers.get(AGENT_MEMORY_IPC.choose.channel)?.(event);
    await handlers.get(AGENT_MEMORY_IPC.refresh.channel)?.(event);
    await handlers.get(AGENT_MEMORY_IPC.read.channel)?.(event, "AGENTS.md");
    await handlers.get(AGENT_MEMORY_IPC.save.channel)?.(event, "AGENTS.md", "# Memory");
    await handlers.get(AGENT_MEMORY_IPC.create.channel)?.(event, {
      kind: "cursor",
      fileName: " ui ",
    });
    await handlers.get(AGENT_MEMORY_IPC.effectiveContext.channel)?.(event, "codex");
    await handlers.get(AGENT_MEMORY_IPC.previewSync.channel)?.(event, "AGENTS.md", ["claude", "cursor"]);
    await handlers.get(AGENT_MEMORY_IPC.applySync.channel)?.(event, "preview-1");
    await handlers.get(AGENT_MEMORY_IPC.undoSync.channel)?.(event, "undo-1");

    expect(service.choose).toHaveBeenCalledOnce();
    expect(service.refresh).toHaveBeenCalledOnce();
    expect(service.read).toHaveBeenCalledWith("AGENTS.md");
    expect(service.save).toHaveBeenCalledWith("AGENTS.md", "# Memory");
    expect(service.create).toHaveBeenCalledWith({ kind: "cursor", fileName: "ui" });
    expect(service.effectiveContext).toHaveBeenCalledWith("codex");
    expect(service.previewSync).toHaveBeenCalledWith("AGENTS.md", ["claude", "cursor"]);
    expect(service.applySync).toHaveBeenCalledWith("preview-1");
    expect(service.undoSync).toHaveBeenCalledWith("undo-1");
  });

  it("rejects unknown fields and oversized content before calling the service", () => {
    const { ipc, handlers } = createMainRegistrar();
    const service = createService();
    registerAgentMemoryIpc(ipc, service);
    const event = {} as IpcMainInvokeEvent;

    expect(() => handlers.get(AGENT_MEMORY_IPC.create.channel)?.(event, {
      kind: "agents",
      arbitraryPath: "/tmp/secret",
    })).toThrow(IpcInputError);
    expect(() => handlers.get(AGENT_MEMORY_IPC.save.channel)?.(event, "AGENTS.md", "x".repeat(1_048_577))).toThrow(IpcInputError);
    expect(() => handlers.get(AGENT_MEMORY_IPC.previewSync.channel)?.(event, "AGENTS.md", [])).toThrow(IpcInputError);
    expect(service.create).not.toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
    expect(service.previewSync).not.toHaveBeenCalled();
  });

  it("builds preload calls from the same contracts", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createAgentMemoryApi({ invoke } as unknown as Parameters<typeof createAgentMemoryApi>[0]);

    await api.chooseAgentMemoryDirectory();
    await api.refreshAgentMemories();
    await api.readAgentMemory("AGENTS.md");
    await api.saveAgentMemory("AGENTS.md", "# Memory");
    await api.createAgentMemory({ kind: "claude" });
    await api.getAgentMemoryEffectiveContext("cursor");
    await api.previewAgentMemorySync("AGENTS.md", ["claude", "cursor"]);
    await api.applyAgentMemorySync("preview-1");
    await api.undoAgentMemorySync("undo-1");

    expect(invoke.mock.calls).toEqual([
      [AGENT_MEMORY_IPC.choose.channel],
      [AGENT_MEMORY_IPC.refresh.channel],
      [AGENT_MEMORY_IPC.read.channel, "AGENTS.md"],
      [AGENT_MEMORY_IPC.save.channel, "AGENTS.md", "# Memory"],
      [AGENT_MEMORY_IPC.create.channel, { kind: "claude" }],
      [AGENT_MEMORY_IPC.effectiveContext.channel, "cursor"],
      [AGENT_MEMORY_IPC.previewSync.channel, "AGENTS.md", ["claude", "cursor"]],
      [AGENT_MEMORY_IPC.applySync.channel, "preview-1"],
      [AGENT_MEMORY_IPC.undoSync.channel, "undo-1"],
    ]);
  });
});
