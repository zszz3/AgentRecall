import { describe, expect, it, vi } from "vitest";
import { loadWslSessionDetailPayload, type RemoteSessionFilePayload } from "./remote-session-loader";
import { remoteSessionKey } from "./session-environment";
import { createInMemoryStore } from "./postgres/test-session-store";
import type { SessionEnvironment } from "./types";
import { WslSessionIndexer } from "./wsl-session-indexer";

async function environment(store: ReturnType<typeof createInMemoryStore>): Promise<SessionEnvironment> {
  return store.upsertEnvironment({ id: "wsl-ubuntu", kind: "wsl", label: "WSL · Ubuntu", wslDistribution: "Ubuntu", enabled: true });
}

function payload(): RemoteSessionFilePayload {
  return {
    kind: "codex-session",
    source: "codex-cli",
    path: "/home/me/.codex/sessions/rollout.jsonl",
    mtimeMs: 10,
    size: 20,
    content: [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-26T10:00:00Z", payload: { id: "wsl-session", cwd: "/repo" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-26T10:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "background WSL indexing" }] } }),
    ].join("\n"),
  };
}

describe("WslSessionIndexer", () => {
  it("retries a transient WSL transport failure on the next pass", async () => {
    const store = createInMemoryStore();
    const current = await environment(store);
    const session = {
      sessionKey: remoteSessionKey(current, "codex-cli", "wsl-session"), rawId: "wsl-session", source: "codex-cli" as const,
      projectPath: "/repo", filePath: "/home/me/.codex/sessions/rollout.jsonl", originalTitle: "WSL", firstQuestion: "question",
      timestamp: 1, fileMtimeMs: 10, fileSize: 20, prUrl: null, prNumber: null, environmentId: current.id,
      environmentKind: "wsl" as const, environmentLabel: current.label,
    };
    await store.upsertIndexedSessionSummary(session, 1);
    const fetch = vi.fn<() => Promise<RemoteSessionFilePayload>>()
      .mockRejectedValueOnce(new Error("WSL distribution is not running"))
      .mockResolvedValueOnce(payload());
    const indexer = new WslSessionIndexer({ store, fetchSessionFile: fetch, loadSession: loadWslSessionDetailPayload });
    try {
      await indexer.request(current);
      await indexer.request(current);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await store.searchSessions({ query: "background WSL" })).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("cancels a queued pass without fetching files and can be reused", async () => {
    const store = createInMemoryStore();
    const current = await environment(store);
    const session = {
      sessionKey: remoteSessionKey(current, "codex-cli", "cancelled"), rawId: "cancelled", source: "codex-cli" as const,
      projectPath: "/repo", filePath: "/home/me/.codex/sessions/cancelled.jsonl", originalTitle: "cancelled", firstQuestion: "question",
      timestamp: Date.now(), fileMtimeMs: 10, fileSize: 20, prUrl: null, prNumber: null, environmentId: current.id,
      environmentKind: "wsl" as const, environmentLabel: current.label,
    };
    await store.upsertIndexedSessionSummary(session, 1);
    const fetchSessionFile = vi.fn(async () => payload());
    const onComplete = vi.fn();
    const indexer = new WslSessionIndexer({ store, fetchSessionFile, loadSession: loadWslSessionDetailPayload, onComplete });
    try {
      indexer.cancel(current.id);
      await indexer.request(current);
      expect(fetchSessionFile).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenLastCalledWith(current, expect.objectContaining({ cancelled: true }));
      await indexer.request(current);
      expect(fetchSessionFile).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });});
