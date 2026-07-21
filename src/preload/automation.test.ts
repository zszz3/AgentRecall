import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_CHANNELS } from "../shared/ipc/automation";
import { createAutomationApi } from "./automation";

describe("createAutomationApi", () => {
  it("maps Runtime, MCP, and Workflow calls to prefixed channels", async () => {
    const ipc = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const api = createAutomationApi(ipc as never);

    await api.saveModelChannels([]);
    await api.listMcpServers();
    await api.createWorkflowDraft({ title: "Ship" });

    expect(ipc.invoke).toHaveBeenNthCalledWith(1, AUTOMATION_CHANNELS.runtimeSaveChannels, []);
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, AUTOMATION_CHANNELS.mcpList);
    expect(ipc.invoke).toHaveBeenNthCalledWith(3, AUTOMATION_CHANNELS.workflowDraftCreate, { title: "Ship" });
  });

  it("unsubscribes snapshot listeners with the same callback", () => {
    const ipc = { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() };
    const api = createAutomationApi(ipc as never);
    const unsubscribe = api.onSnapshot(() => undefined);
    const listener = ipc.on.mock.calls[0]?.[1];

    unsubscribe();

    expect(ipc.removeListener).toHaveBeenCalledWith(AUTOMATION_CHANNELS.snapshotChanged, listener);
  });
});
