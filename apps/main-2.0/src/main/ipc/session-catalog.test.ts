import { describe, expect, test, vi } from "vitest";

import type { SessionCatalogService } from "../services/session-catalog-service";
import { registerSessionCatalogIpc } from "./session-catalog";

describe("Session catalog IPC Runtime owner boundary", () => {
  test("accepts an exact bounded lookup and rejects malformed owner references", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const resolveRuntimeInvocationSession = vi.fn(async () => ({
      status: "found" as const,
      session: { sessionKey: "codex:one" },
    }));
    registerSessionCatalogIpc({
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
        return undefined as never;
      },
    }, {
      resolveRuntimeInvocationSession,
    } as unknown as SessionCatalogService);
    const handler = handlers.get("session:resolve-runtime-owner");
    expect(handler).toBeTypeOf("function");

    await expect(handler?.({}, {
      surface: "workflow",
      role: "node",
      ownerReference: { workflowId: "workflow-1", runId: "run-1" },
    }))
      .resolves.toEqual({ status: "found", session: { sessionKey: "codex:one" } });
    expect(resolveRuntimeInvocationSession).toHaveBeenCalledWith({
      surface: "workflow",
      role: "node",
      ownerReference: { workflowId: "workflow-1", runId: "run-1" },
    });
    expect(() => handler?.({}, [])).toThrow(/must be an object/i);
    expect(() => handler?.({}, { ownerReference: { workflowId: 1 } })).toThrow(/invalid field/i);
    expect(() => handler?.({}, { ownerReference: {} })).toThrow(/between 1 and 32 fields/i);
    expect(() => handler?.({}, { surface: "unknown", ownerReference: { runId: "1" } })).toThrow(/invalid surface/i);
  });
});
