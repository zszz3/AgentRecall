import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresDatabase } from "../../core/postgres/database";
import { PostgresMemoryCardRepository } from "../../core/postgres/memory-card-repository";
import { POSTGRES_MIGRATIONS } from "../../core/postgres/schema";
import { PGliteTestPool } from "../../core/postgres/test-pglite";
import { ExperienceCardService, type ExperienceCardSettings } from "./experience-card-service";

const ENABLED_AT = "2026-11-01T00:00:00.000Z";

describe("ExperienceCardService", () => {
  let database: PostgresDatabase;
  let repository: PostgresMemoryCardRepository;
  let settings: ExperienceCardSettings;

  beforeEach(async () => {
    database = new PostgresDatabase(new PGliteTestPool(), { migrationLock: false, migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    repository = new PostgresMemoryCardRepository(database);
    settings = { experienceCardsEnabled: true, experienceCardsChannelId: "api-1", experienceCardsEnabledAt: ENABLED_AT };
  });

  afterEach(async () => {
    await database.close();
  });

  async function addSession(sessionKey: string, startedAt = "2026-11-05T00:00:00.000Z"): Promise<void> {
    await database.query(`
      insert into agent_recall.sessions (
        session_key, raw_id, source, environment_id, project_path, file_path,
        original_title, first_question, started_at, file_mtime_ms, file_size, indexed_at
      ) values ($1, $1, 'codex-cli', 'local', '/repo', '/fixture/' || $1 || '.jsonl', 'Title ' || $1, 'Question', now(), 1, 1, now())
    `, [sessionKey]);
    await database.query(`
      insert into agent_recall.session_turns (
        id, session_key, turn_index, status, started_at, user_text, assistant_text, tool_text, search_text, tool_names, derivation_version
      ) values ($1 || ':0', $1, 0, 'completed', $2, 'git push rejected in ' || $1, 'fetch then rebase', 'error: rejected', 'x', '{shell}', 7)
    `, [sessionKey, startedAt]);
  }

  function service(runExtraction: ExperienceCardService["dependencies"]["runExtraction"]) {
    return new ExperienceCardService({
      repository: async () => repository,
      settings: () => settings,
      runExtraction,
      now: () => new Date("2026-11-10T12:00:00.000Z"),
    });
  }

  const createReply = JSON.stringify({
    operations: [{ op: "create", ref: "n1", kind: "experience", problem: "git push rejected", solution: "fetch then rebase", failedAttempts: [], keywords: ["git"] }],
  });

  it("does nothing while turned off or without a selected channel", async () => {
    await addSession("s1");
    const run = vi.fn();
    const subject = service(run);
    settings = { ...settings, experienceCardsEnabled: false };
    await subject.afterIndexRun();
    await subject.afterIndexRun();
    settings = { ...settings, experienceCardsEnabled: true, experienceCardsChannelId: "" };
    await subject.afterIndexRun();
    await subject.afterIndexRun();
    expect(run).not.toHaveBeenCalled();
  });

  it("extracts a Session after one unchanged index pass and stores the card with its source", async () => {
    await addSession("s1");
    const run = vi.fn(async (_channel: string, _prompt: string, _session: string, _signal: AbortSignal) => ({ output: createReply, model: "m1" }));
    const subject = service(run);
    await subject.afterIndexRun();
    expect(run).not.toHaveBeenCalled();
    await subject.afterIndexRun();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toBe("api-1");
    expect(run.mock.calls[0]![1]).toContain("git push rejected in s1");
    expect(run.mock.calls[0]![2]).toBe("s1");
    const cards = await repository.listCards({ includeSuperseded: false });
    expect(cards).toMatchObject([{ problem: "git push rejected", model: "m1", sources: [{ sessionKey: "s1", firstTurnIndex: 0, lastTurnIndex: 0 }] }]);
    expect(await repository.extractionState("s1")).toMatchObject({ status: "succeeded", lastExtractedTurnIndex: 0 });
    // Runtimes do not report token usage for one-shot calls, so the total stays unknown instead of zero.
    expect(await subject.status()).toMatchObject({ activeCards: 1, processedSessions: 1, processedToday: 1, inputTokens: null, outputTokens: null });
    const edited = await subject.editCard(cards[0]!.id, { problem: "push rejected", solution: "rebase", failedAttempts: [], keywords: [] });
    expect(edited).toMatchObject({ problem: "push rejected", solution: "rebase" });
    await subject.deleteCard(cards[0]!.id);
    await expect(subject.editCard(cards[0]!.id, { problem: "p", solution: "s", failedAttempts: [], keywords: [] })).rejects.toThrow(/no longer exists/);
  });

  it("processes at most three Sessions per index run", async () => {
    for (const key of ["a", "b", "c", "d"]) await addSession(key);
    const run = vi.fn(async () => ({ output: "{\"operations\":[]}", model: "m1" }));
    const subject = service(run);
    await subject.afterIndexRun();
    await subject.afterIndexRun();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("records an invalid reply as a failure without storing cards", async () => {
    await addSession("s1");
    const subject = service(async () => ({ output: "Sure! Here are your cards.", model: "m1" }));
    await subject.afterIndexRun();
    await subject.afterIndexRun();
    expect(await repository.listCards({ includeSuperseded: true })).toEqual([]);
    expect(await repository.extractionState("s1")).toMatchObject({ status: "failed", attempts: 1, lastError: expect.stringMatching(/JSON/) });
    expect(await subject.status()).toMatchObject({ running: false, failures: [{ sessionKey: "s1", attempts: 1 }] });
    await expect(subject.retryFailed("s1")).resolves.toBe(1);
    expect((await subject.status()).failures).toEqual([]);
  });

  it("runs one extraction at a time and aborts it on stop without recording a failure", async () => {
    await addSession("s1");
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const run = vi.fn((_channel: string, _prompt: string, _session: string, signal: AbortSignal) => {
      started();
      return new Promise<{ output: string; model: string }>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const subject = service(run);
    await subject.afterIndexRun();
    const first = subject.afterIndexRun();
    await startedPromise;
    expect((await subject.status()).running).toBe(true);
    await subject.afterIndexRun();
    expect(run).toHaveBeenCalledTimes(1);
    await subject.stop();
    await first;
    expect((await subject.status()).running).toBe(false);
    expect(await repository.extractionState("s1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("aborts the running extraction when extraction is turned off", async () => {
    await addSession("s1");
    let aborted = false;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const subject = service((_channel, _prompt, _session, signal) => {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
    });
    await subject.afterIndexRun();
    const run = subject.afterIndexRun();
    await startedPromise;
    settings = { ...settings, experienceCardsEnabled: false };
    subject.settingsChanged();
    await run;
    expect(aborted).toBe(true);
  });
});
