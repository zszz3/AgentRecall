import { afterEach, describe, expect, it } from "vitest";

import { createInMemoryStore } from "../core/sqlite/test-session-store";
import type { SessionStore } from "../core/session-store";
import { searchLocalKnowledge } from "./session-backend-search";

describe("local session search response", () => {
  let store: SessionStore;

  afterEach(async () => {
    await store.close();
  });

  it("puts active experience cards with their dated sources before matching sessions", async () => {
    store = createInMemoryStore();
    await store.upsertIndexedSession({
      sessionKey: "codex-cli:s1", rawId: "s1", source: "codex-cli", projectPath: "/repo", filePath: "/fixture/s1.jsonl",
      originalTitle: "Push fix", firstQuestion: "git push rejected", timestamp: Date.parse("2026-11-05T00:00:00.000Z"),
      fileMtimeMs: 1, fileSize: 1, prUrl: null, prNumber: null,
    }, [
      { role: "user", content: "git push rejected", timestamp: "2026-11-05T00:00:00.000Z", index: 0 },
      { role: "assistant", content: "fetch then rebase", timestamp: "2026-11-05T00:00:01.000Z", index: 1 },
    ]);
    const repository = await store.memoryCardRepository();
    const [oldCard] = await repository.applyExtraction({
      sessionKey: "codex-cli:s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "m", now: "2026-11-06T00:00:00.000Z",
      operations: [{ op: "create", ref: "a", kind: "experience", problem: "git push rejected", solution: "force push", failedAttempts: [], keywords: [] }],
    });
    await repository.applyExtraction({
      sessionKey: "codex-cli:s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [oldCard!], model: "m", now: "2026-11-07T00:00:00.000Z",
      operations: [
        { op: "create", ref: "b", kind: "experience", problem: "git push rejected by remote", solution: "fetch then rebase", failedAttempts: ["force push"], keywords: ["git"] },
        { op: "supersede", id: oldCard!, replacedBy: "b" },
      ],
    });

    const result = await searchLocalKnowledge(store, { query: "push rejected", limit: 20 });

    expect(Object.keys(result)).toEqual(["cards", "sessions"]);
    expect(result.cards).toEqual([expect.objectContaining({
      kind: "experience",
      problem: "git push rejected by remote",
      solution: "fetch then rebase",
      failedAttempts: ["force push"],
      project: "/repo",
      sources: [{ sessionKey: "codex-cli:s1", firstTurnIndex: 0, lastTurnIndex: 0, lastTurnAt: "2026-11-05T00:00:00.000Z" }],
    })]);
    expect(result.sessions.map((session) => session.sessionKey)).toEqual(["codex-cli:s1"]);
    expect((await searchLocalKnowledge(store, { query: "", limit: 20 })).cards).toEqual([]);
  });
});
