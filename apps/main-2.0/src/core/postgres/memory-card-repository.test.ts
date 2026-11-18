import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PostgresDatabase } from "./database";
import { PostgresMemoryCardRepository } from "./memory-card-repository";
import { POSTGRES_MIGRATIONS } from "./schema";
import { PGliteTestPool } from "./test-pglite";

const ENABLED_AT = "2026-11-01T00:00:00.000Z";
const NOW = "2026-11-10T12:00:00.000Z";

describe("PostgreSQL experience cards", () => {
  let database: PostgresDatabase;
  let repository: PostgresMemoryCardRepository;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    repository = new PostgresMemoryCardRepository(database);
  });

  afterEach(async () => {
    await database.close();
  });

  async function addSession(sessionKey: string, projectPath = "/repo"): Promise<void> {
    await database.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at
      ) values ($1, $1, 'codex-cli', 'local', $2, '/fixture/' || $1 || '.jsonl',
        'Title ' || $1, 'Question', now(), 1, 1, now())
    `, [sessionKey, projectPath]);
  }

  async function addTurn(sessionKey: string, turnIndex: number, startedAt: string, options: {
    status?: string; user?: string; assistant?: string; tool?: string;
  } = {}): Promise<void> {
    await database.query(`
      insert into agent_recall.session_turns (
        id, session_key, turn_index, status, started_at, user_text, assistant_text, tool_text, search_text, tool_names, derivation_version
      ) values ($1 || ':' || $2::text, $1, $2::integer, $3, $4, $5, $6, $7, $5 || ' ' || $6, '{shell}', 7)
    `, [sessionKey, turnIndex, options.status ?? "completed", startedAt,
      options.user ?? `question ${turnIndex}`, options.assistant ?? `answer ${turnIndex}`, options.tool ?? ""]);
  }

  async function createCard(sessionKey: string, problem: string, keywords: string[] = []): Promise<string> {
    const [id] = await repository.applyExtraction({
      sessionKey, projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "test", now: NOW,
      operations: [{ op: "create", ref: "a", kind: "experience", problem, solution: "first fix", failedAttempts: ["retry blindly"], keywords }],
    });
    return id!;
  }

  it("creates cards with sources and advances the extraction cursor in one write", async () => {
    await addSession("s1");
    const ids = await repository.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 2, lastTurnIndex: 4, candidateIds: [], model: "gpt", now: NOW,
      operations: [{ op: "create", ref: "a", kind: "decision", problem: "Workflow removal", solution: "Remove it", failedAttempts: [], keywords: ["workflow"] }],
    });
    const cards = await repository.listCards({ includeSuperseded: false });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: ids[0], kind: "decision", problem: "Workflow removal", status: "active", model: "gpt",
      sources: [{ sessionKey: "s1", firstTurnIndex: 2, lastTurnIndex: 4 }],
    });
    expect(await repository.extractionState("s1")).toMatchObject({ lastExtractedTurnIndex: 4, status: "succeeded", attempts: 0 });
  });

  it("records an empty batch as processed without output", async () => {
    await addSession("s1");
    await repository.applyExtraction({ sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 1, candidateIds: [], model: "m", now: NOW, operations: [] });
    expect(await repository.extractionState("s1")).toMatchObject({ lastExtractedTurnIndex: 1, status: "succeeded_no_output" });
  });

  it("merges an update field by field instead of rewriting the card", async () => {
    await addSession("s1");
    await addSession("s2");
    const id = await createCard("s1", "git push denied", ["git", "ssh"]);
    await repository.applyExtraction({
      sessionKey: "s2", projectPath: "/repo", firstTurnIndex: 3, lastTurnIndex: 5, candidateIds: [id], model: "m", now: NOW,
      operations: [{ op: "update", id, solution: "use https", failedAttempts: ["retry blindly", "reset keys"], keywords: ["SSH", "https"] }],
    });
    const [card] = await repository.listCards({ includeSuperseded: false });
    expect(card).toMatchObject({
      problem: "git push denied",
      solution: "use https",
      previousSolution: "first fix",
      failedAttempts: ["retry blindly", "reset keys"],
      keywords: ["git", "ssh", "https"],
    });
    expect(card!.sources.map((source) => source.sessionKey).sort()).toEqual(["s1", "s2"]);
  });

  it("confirms a card with a source dated by its last Turn without changing the card", async () => {
    await addSession("s1");
    await addSession("s2");
    const id = await createCard("s1", "git push denied");
    await addTurn("s2", 4, "2026-11-12T08:00:00.000Z");
    await repository.applyExtraction({
      sessionKey: "s2", projectPath: "/repo", firstTurnIndex: 3, lastTurnIndex: 4, candidateIds: [id], model: "other", now: "2026-11-12T09:00:00.000Z",
      operations: [{ op: "confirm", id }],
    });
    const [card] = await repository.listCards({ includeSuperseded: false });
    expect(card).toMatchObject({ solution: "first fix", previousSolution: null, model: "test", updatedAt: NOW });
    // The first source has no indexed Turn row, so its date falls back to when it was recorded.
    expect(card!.sources).toEqual([
      { sessionKey: "s1", firstTurnIndex: 0, lastTurnIndex: 0, lastTurnAt: NOW },
      { sessionKey: "s2", firstTurnIndex: 3, lastTurnIndex: 4, lastTurnAt: "2026-11-12T08:00:00.000Z" },
    ]);
  });

  it("marks a superseded card and hides it from search", async () => {
    await addSession("s1");
    const old = await createCard("s1", "build with tool A", ["build"]);
    const [created] = await repository.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 1, lastTurnIndex: 1, candidateIds: [old], model: "m", now: NOW,
      operations: [
        { op: "create", ref: "next", kind: "decision", problem: "build with tool B", solution: "switch", failedAttempts: [], keywords: ["build"] },
        { op: "supersede", id: old, replacedBy: "next" },
      ],
    });
    const all = await repository.listCards({ includeSuperseded: true });
    expect(all.find((card) => card.id === old)).toMatchObject({ status: "superseded", supersededBy: created });
    expect((await repository.searchActiveCards({ query: "build" })).map((card) => card.id)).toEqual([created]);
  });

  it("rolls back every write when one operation targets a missing card", async () => {
    await addSession("s1");
    await expect(repository.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: ["missing"], model: "m", now: NOW,
      operations: [
        { op: "create", ref: "a", kind: "experience", problem: "p", solution: "s", failedAttempts: [], keywords: [] },
        { op: "update", id: "missing", failedAttempts: [], keywords: [] },
      ],
    })).rejects.toThrow(/missing/);
    expect(await repository.listCards({ includeSuperseded: true })).toEqual([]);
    expect(await repository.extractionState("s1")).toBeNull();
  });

  it("deletes a card only after its last source Session leaves the index", async () => {
    await addSession("s1");
    await addSession("s2");
    const id = await createCard("s1", "shared problem");
    await repository.applyExtraction({
      sessionKey: "s2", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [id], model: "m", now: NOW,
      operations: [{ op: "update", id, failedAttempts: [], keywords: [] }],
    });
    await database.query("delete from agent_recall.sessions where session_key = 's1'");
    expect((await repository.listCards({ includeSuperseded: true }))[0]?.sources.map((source) => source.sessionKey)).toEqual(["s2"]);
    await database.query("delete from agent_recall.sessions where session_key = 's2'");
    expect(await repository.listCards({ includeSuperseded: true })).toEqual([]);
  });

  it("finds similar active cards only in the same project", async () => {
    await addSession("s1");
    await addSession("other", "/other");
    const id = await createCard("s1", "Permission denied (publickey)", ["git"]);
    await repository.applyExtraction({
      sessionKey: "other", projectPath: "/other", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "m", now: NOW,
      operations: [{ op: "create", ref: "a", kind: "experience", problem: "publickey elsewhere", solution: "x", failedAttempts: [], keywords: [] }],
    });
    const similar = await repository.findSimilarCards("/repo", ["publickey", "unrelated"], 10);
    expect(similar.map((card) => card.id)).toEqual([id]);
  });

  it("matches Chinese substrings in card search", async () => {
    await addSession("s1");
    const id = await createCard("s1", "索引刷新后搜索结果为空");
    expect((await repository.searchActiveCards({ query: "搜索结果" })).map((card) => card.id)).toEqual([id]);
  });

  it("returns cards containing at least half of the search terms, most matched terms first", async () => {
    await addSession("s1");
    const two = await createCard("s1", "git push hangs");
    const all = await createCard("s1", "git push rejected over ssh");
    await createCard("s1", "git clone is slow");
    expect((await repository.searchActiveCards({ query: "git push ssh" })).map((card) => card.id)).toEqual([all, two]);
  });

  it("ranks a recently confirmed card before an equally matching older one", async () => {
    await addSession("s1");
    const confirmed = await createCard("s1", "vite port in use");
    const [other] = await repository.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "m", now: "2026-11-10T13:00:00.000Z",
      operations: [{ op: "create", ref: "a", kind: "experience", problem: "vite port changed", solution: "read the new port", failedAttempts: [], keywords: [] }],
    });
    await repository.applyExtraction({
      sessionKey: "s1", projectPath: "/repo", firstTurnIndex: 1, lastTurnIndex: 1, candidateIds: [confirmed], model: "m", now: "2026-11-11T00:00:00.000Z",
      operations: [{ op: "confirm", id: confirmed }],
    });
    expect((await repository.searchActiveCards({ query: "vite port" })).map((card) => card.id)).toEqual([confirmed, other]);
  });

  describe("scheduling", () => {
    it("waits one index pass without changes before a Session becomes ready", async () => {
      await addSession("s1");
      await addTurn("s1", 0, "2026-11-05T00:00:00.000Z");
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["s1"]);
      await addTurn("s1", 1, "2026-11-05T01:00:00.000Z");
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["s1"]);
    });

    it("ignores turns before the enable time, running turns and extracted turns", async () => {
      await addSession("old");
      await addTurn("old", 0, "2026-10-01T00:00:00.000Z");
      await addSession("running");
      await addTurn("running", 0, "2026-11-05T00:00:00.000Z", { status: "running" });
      await addSession("done");
      await addTurn("done", 0, "2026-11-05T00:00:00.000Z");
      await repository.applyExtraction({ sessionKey: "done", projectPath: "/repo", firstTurnIndex: 0, lastTurnIndex: 0, candidateIds: [], model: "m", now: NOW, operations: [] });
      for (let pass = 0; pass < 2; pass += 1) {
        expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
      }
    });

    it("returns at most the limit, newest first", async () => {
      for (const [index, key] of ["a", "b", "c", "d"].entries()) {
        await addSession(key);
        await addTurn(key, 0, `2026-11-0${index + 2}T00:00:00.000Z`);
      }
      await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 });
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["d", "c", "b"]);
    });

    it("backs off after failures, stops at the limit and resumes on manual retry", async () => {
      await addSession("s1");
      await addTurn("s1", 0, "2026-11-05T00:00:00.000Z");
      await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 });
      const options = { maxAttempts: 2, baseDelayMs: 60_000 };
      await repository.recordExtractionFailure("s1", "model offline", NOW, options);
      expect(await repository.extractionState("s1")).toMatchObject({ status: "failed", attempts: 1, nextRetryAt: "2026-11-10T12:01:00.000Z", lastError: "model offline" });
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual([]);
      const later = "2026-11-10T12:02:00.000Z";
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: later, limit: 3 })).toEqual(["s1"]);
      await repository.recordExtractionFailure("s1", "model offline", later, options);
      expect(await repository.extractionState("s1")).toMatchObject({ status: "failed", attempts: 2, nextRetryAt: null });
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: "2026-12-01T00:00:00.000Z", limit: 3 })).toEqual([]);
      await repository.retryFailedExtractions(NOW);
      expect(await repository.pickExtractionSessions({ enabledAt: ENABLED_AT, now: NOW, limit: 3 })).toEqual(["s1"]);
    });

    it("loads only new turns after the cursor and enable time", async () => {
      await addSession("s1");
      await addTurn("s1", 0, "2026-10-01T00:00:00.000Z");
      await addTurn("s1", 1, "2026-11-05T00:00:00.000Z", { user: "fix push", assistant: "done", tool: "error: denied" });
      const input = await repository.loadExtractionInput("s1", ENABLED_AT);
      expect(input).toMatchObject({ sessionKey: "s1", projectPath: "/repo", title: "Title s1", source: "codex-cli" });
      expect(input!.turns).toEqual([{
        turnIndex: 1, startedAt: "2026-11-05T00:00:00.000Z", userText: "fix push", assistantText: "done", toolText: "error: denied", toolNames: ["shell"],
      }]);
    });
  });
});
