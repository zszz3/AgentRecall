import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import type { NativeAutomationService } from "./services/automation-service";
import { registerAutomationIpc } from "./ipc/automation";

function setup() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
  };
  const hub = {
    saveModelChannels: vi.fn(async (value) => ({ channels: value })),
    updateConfiguredAgents: vi.fn((value) => ({ configuredAgents: value })),
    createWorkflowDraft: vi.fn((value) => ({ workflowDraft: value })),
    sendWorkflowDraftReply: vi.fn(async (value) => ({ workflowDraft: value })),
  };
  const registry = {
    upsert: vi.fn(async (value) => value),
    list: vi.fn(async () => []),
    recordTest: vi.fn(),
    delete: vi.fn(),
  };
  const service = {
    requireReady: vi.fn(async () => undefined),
    health: vi.fn(() => ({ state: "ready" })),
    snapshot: vi.fn(() => ({ workDir: "/repo" })),
    subscribe: vi.fn(() => () => undefined),
    hub: vi.fn(() => hub),
    mcpRegistry: vi.fn(() => registry),
    mcpAgents: vi.fn(() => ({})),
  } as unknown as NativeAutomationService;
  registerAutomationIpc({ ipc: ipc as never, service, send: vi.fn() });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { handlers, invoke, hub, registry, service };
}

describe("registerAutomationIpc", () => {
  it("registers only AgentRecall-prefixed automation channels", () => {
    const { handlers } = setup();
    expect([...handlers.keys()].length).toBeGreaterThan(30);
    expect([...handlers.keys()].every((channel) => channel.startsWith("automation:"))).toBe(true);
  });

  it("validates and delegates runtime channel saves", async () => {
    const { invoke, hub } = setup();
    const channels = [{ id: "codex-local", label: "Codex", agentId: "codex", models: [] }];

    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, channels)).resolves.toEqual({ channels });
    expect(hub.saveModelChannels).toHaveBeenCalledWith(channels);
    await expect(invoke(AUTOMATION_CHANNELS.runtimeSaveChannels, [{ id: "" }])).rejects.toThrow(/id/i);
  });

  it("rejects unsafe MCP URLs before touching the registry", async () => {
    const { invoke, registry } = setup();
    const server = {
      id: "docs",
      name: "Docs",
      transport: "http",
      url: "file:///tmp/secrets",
      args: [],
      env: {},
      enabled: true,
      tools: [],
      status: "untested",
      createdAt: 1,
      updatedAt: 1,
    };

    await expect(invoke(AUTOMATION_CHANNELS.mcpSave, server)).rejects.toThrow(/http/i);
    expect(registry.upsert).not.toHaveBeenCalled();
  });

  it("bounds workflow planning input at the IPC boundary", async () => {
    const { invoke, hub } = setup();

    await expect(invoke(AUTOMATION_CHANNELS.workflowDraftSend, {
      workflowId: "wf-1",
      reply: "x".repeat(200_001),
    })).rejects.toThrow(/too big|too long|maximum/i);
    expect(hub.sendWorkflowDraftReply).not.toHaveBeenCalled();
  });
});
