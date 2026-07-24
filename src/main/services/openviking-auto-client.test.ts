import { describe, expect, it, vi } from "vitest";

import type { OpenVikingClientPort } from "./openviking-client";
import { AutoStartingOpenVikingClient } from "./openviking-auto-client";

describe("AutoStartingOpenVikingClient", () => {
  it("starts the managed runtime before forwarding and reuses the gateway", async () => {
    const downstream = {
      searchMemories: vi.fn(async () => []),
      deleteWorkspaceUser: vi.fn(async () => undefined),
    } as unknown as OpenVikingClientPort;
    const ensureRunning = vi.fn(async () => undefined);
    const getConnection = vi.fn(async () => ({
      baseUrl: "http://127.0.0.1:21933",
      rootApiKey: "root-key",
    }));
    const createClient = vi.fn(() => downstream);
    const client = new AutoStartingOpenVikingClient({
      ensureRunning,
      getConnection,
      createClient,
    });
    const auth = { accountId: "agent-recall", userId: "workspace_one", apiKey: "user-key" };

    await client.searchMemories(auth, "query", 8);
    await client.deleteWorkspaceUser("agent-recall", "workspace_one");

    expect(ensureRunning).toHaveBeenCalledTimes(2);
    expect(getConnection).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:21933",
      rootApiKey: "root-key",
    });
    expect(downstream.searchMemories).toHaveBeenCalledWith(auth, "query", 8);
    expect(downstream.deleteWorkspaceUser).toHaveBeenCalledWith("agent-recall", "workspace_one");
  });

  it("replaces the cached gateway when the runtime endpoint changes", async () => {
    let port = 21933;
    const createClient = vi.fn(() => ({
      health: vi.fn(async () => undefined),
    }) as unknown as OpenVikingClientPort);
    const client = new AutoStartingOpenVikingClient({
      ensureRunning: async () => undefined,
      getConnection: async () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        rootApiKey: "root-key",
      }),
      createClient,
    });

    await client.health();
    port = 21934;
    await client.health();

    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
