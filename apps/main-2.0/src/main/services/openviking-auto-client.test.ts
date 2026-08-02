import { describe, expect, it, vi } from "vitest";

import type { OpenVikingClientPort } from "./openviking-client";
import { AutoStartingOpenVikingClient } from "./openviking-auto-client";

describe("AutoStartingOpenVikingClient", () => {
  it("starts the managed runtime before forwarding and reuses the gateway", async () => {
    const downstream = {
      searchMemories: vi.fn(async () => []),
      deleteWorkspaceUser: vi.fn(async () => undefined),
      commitSession: vi.fn(async () => ({ taskId: "task-1" })),
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
    const auth = { accountId: "agent-recall-v2", userId: "workspace_one", apiKey: "user-key" };

    await client.searchMemories(auth, "query", 8);
    await client.commitSession(auth, "session-1", 10);
    await client.deleteWorkspaceUser(auth);

    expect(ensureRunning).toHaveBeenCalledTimes(3);
    expect(getConnection).toHaveBeenCalledTimes(3);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:21933",
      rootApiKey: "root-key",
    });
    expect(downstream.searchMemories).toHaveBeenCalledWith(auth, "query", 8);
    expect(downstream.commitSession).toHaveBeenCalledWith(auth, "session-1", 10);
    expect(downstream.deleteWorkspaceUser).toHaveBeenCalledWith(auth);
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
