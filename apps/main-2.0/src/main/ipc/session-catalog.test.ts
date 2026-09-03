import { describe, expect, test, vi } from "vitest";

import type { SessionCatalogService } from "../services/session-catalog-service";
import { registerSessionCatalogIpc } from "./session-catalog";

describe("Session catalog IPC Runtime owner boundary", () => {
  test("accepts a bounded string map and rejects malformed owner references", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const findByRuntimeInvocationOwner = vi.fn(async () => ({ sessionKey: "codex:one" }));
    registerSessionCatalogIpc({
      handle: (channel, listener) => {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
        return undefined as never;
      },
    }, {
      findByRuntimeInvocationOwner,
    } as unknown as SessionCatalogService);
    const handler = handlers.get("session:find-by-runtime-owner");
    expect(handler).toBeTypeOf("function");

    await expect(handler?.({}, { workflowId: "workflow-1", runId: "run-1" }))
      .resolves.toEqual({ sessionKey: "codex:one" });
    expect(findByRuntimeInvocationOwner).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      runId: "run-1",
    });
    expect(() => handler?.({}, [])).toThrow(/must be an object/i);
    expect(() => handler?.({}, { workflowId: 1 })).toThrow(/invalid field/i);
    expect(() => handler?.({}, {})).toThrow(/between 1 and 32 fields/i);
  });
});
