import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CORE_SESSION_SOURCES } from "../shared/product-profile";
import { SessionStore } from "./session-store";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

const storeSource = readFileSync(new URL("./store/sessions.ts", import.meta.url), "utf8");
const SESSION_COUNT = 10_000;
const TARGET_INDEX = SESSION_COUNT - 1;
const CORE_SESSION_COUNT = 8_000;
const PAGE_LIMIT = 20;
const QUERY_BUDGET_MS = 2_000;
const HIGH_CARDINALITY_QUERY_BUDGET_MS = 200;

function sourceBlock(startNeedle: string, endNeedle: string): string {
  const start = storeSource.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = storeSource.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return storeSource.slice(start, end);
}

function createTenThousandSessionStore(): SessionStore {
  const db = new DatabaseSync(":memory:");
  const store = new SessionStore(db);
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      session_key, raw_id, source, environment_id, project_path, file_path,
      original_title, first_question, timestamp, file_mtime_ms, file_size,
      message_count, indexed_at
    )
    VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, 100, 1, ?)
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (session_key, message_index, role, content, timestamp)
    VALUES (?, 0, 'user', ?, '2026-07-25T00:00:00.000Z')
  `);
  const insertFts = db.prepare(`
    INSERT INTO session_fts (session_key, title, first_question, content_text, project_path)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    for (let index = 0; index < SESSION_COUNT; index++) {
      const source = index % 5 === 0
        ? "openclaw"
        : CORE_SESSION_SOURCES[index % CORE_SESSION_SOURCES.length];
      const sessionKey = `${source}:benchmark-${index}`;
      const projectPath = `/benchmark/project-${index % 50}`;
      const title = `Routine benchmark session ${index}`;
      const content = index === TARGET_INDEX
        ? "Routine benchmark deterministic needle appears only in this transcript."
        : `Routine benchmark transcript number ${index} with ordinary searchable content.`;
      insertSession.run(
        sessionKey,
        `benchmark-${index}`,
        source,
        projectPath,
        `/synthetic/benchmark-${index}.jsonl`,
        title,
        title,
        index + 1,
        index + 1,
        index + 1,
      );
      insertMessage.run(sessionKey, content);
      insertFts.run(sessionKey, title, title, content, projectPath);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    store.close();
    throw error;
  }
  return store;
}

describe("SessionStore search performance", () => {
  it("pushes empty-query sorting and limits down to SQLite", () => {
    const candidatesBlock = sourceBlock("private getCandidatePage(", "private querySearchCandidatePage");

    expect(candidatesBlock).toContain("LIMIT ?");
    expect(candidatesBlock).toContain("ORDER BY ${sessionSortSql(options.sortBy)}");
    expect(storeSource).toContain("favorited DESC");
  });

  it("ranks and limits scoped FTS candidates before hydration and snippets", () => {
    const candidatesBlock = sourceBlock("private querySearchCandidatePage(", "private countCandidateRows");
    const searchBlock = sourceBlock("searchSessionPage(options", "clearSearchIndex()");

    expect(candidatesBlock).toContain("WHERE session_fts MATCH ?");
    expect(candidatesBlock).toContain("COUNT(*) OVER () AS total_count");
    expect(candidatesBlock).toContain("ORDER BY ${orderSql}");
    expect(candidatesBlock).toContain("LIMIT ?");
    expect(candidatesBlock).not.toContain("findSnippet");
    expect(storeSource).not.toContain("private findSnippet(");
    expect(searchBlock).not.toContain(".sort(");
    expect(searchBlock).not.toContain(".slice(");
  });

  it(
    "finds and hydrates a unique official-source result in a deterministic 10k corpus",
    () => {
      const store = createTenThousandSessionStore();
      try {
        const options = {
          query: "deterministic needle",
          environmentId: "local",
          allowedSources: CORE_SESSION_SOURCES,
          limit: PAGE_LIMIT,
        } as const;

        // Warm the prepared statements and SQLite page cache before measuring.
        expect(store.searchSessionPage(options).totalCount).toBe(1);
        const durations: number[] = [];
        let page = store.searchSessionPage(options);
        for (let iteration = 0; iteration < 5; iteration++) {
          const startedAt = performance.now();
          page = store.searchSessionPage(options);
          durations.push(performance.now() - startedAt);
        }

        expect(page).toMatchObject({
          totalCount: 1,
          hasMore: false,
          sessions: [{
            sessionKey: `codex-app:benchmark-${TARGET_INDEX}`,
            source: "codex-app",
          }],
        });
        expect(page.sessions[0].matchSnippet).toContain("deterministic needle");
        const maxDurationMs = Math.max(...durations);
        console.info(
          `[search benchmark] 10k corpus: max ${maxDurationMs.toFixed(1)} ms, samples ${durations
            .map((duration) => duration.toFixed(1))
            .join(", ")} ms`,
        );
        expect(
          maxDurationMs,
          `10k scoped FTS search exceeded ${QUERY_BUDGET_MS} ms`,
        ).toBeLessThan(QUERY_BUDGET_MS);
      } finally {
        store.close();
      }
    },
    30_000,
  );

  it(
    "hydrates only the final page for a high-cardinality 10k FTS query",
    () => {
      const store = createTenThousandSessionStore();
      const environments = (store as unknown as {
        environments: { getEnvironment(environmentId: string): unknown };
      }).environments;
      try {
        const options = {
          query: "routine benchmark",
          environmentId: "local",
          allowedSources: CORE_SESSION_SOURCES,
          limit: PAGE_LIMIT,
        } as const;

        // Warm SQLite before observing the deterministic hydration count.
        expect(store.searchSessionPage(options).totalCount).toBe(CORE_SESSION_COUNT);
        const getEnvironment = vi.spyOn(environments, "getEnvironment");
        const startedAt = performance.now();
        const page = store.searchSessionPage(options);
        const durationMs = performance.now() - startedAt;

        expect(page).toMatchObject({
          totalCount: CORE_SESSION_COUNT,
          hasMore: true,
        });
        expect(page.sessions).toHaveLength(PAGE_LIMIT);
        expect(page.sessions.every((session) =>
          CORE_SESSION_SOURCES.includes(session.source as (typeof CORE_SESSION_SOURCES)[number]))).toBe(true);
        expect(getEnvironment).toHaveBeenCalledTimes(PAGE_LIMIT);
        console.info(
          `[search benchmark] 10k high-cardinality corpus: ${durationMs.toFixed(1)} ms, `
          + `${page.totalCount} matches, ${getEnvironment.mock.calls.length} hydrated`,
        );
        expect(
          durationMs,
          `10k high-cardinality scoped FTS search exceeded ${HIGH_CARDINALITY_QUERY_BUDGET_MS} ms`,
        ).toBeLessThan(HIGH_CARDINALITY_QUERY_BUDGET_MS);
        getEnvironment.mockRestore();
      } finally {
        vi.restoreAllMocks();
        store.close();
      }
    },
    30_000,
  );
});
