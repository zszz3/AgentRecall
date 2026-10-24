import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("main process session query wiring", () => {
  it("does not lazily create query workers after shutdown has started", () => {
    expect(source).toContain("if (quitStarted || localSessionWorkersStopping)");
    expect(source).toMatch(
      /function createLocalSessionQueryService\(\): LocalSessionQueryService \{\s+assertLocalSessionWorkersCanStart\(\);/,
    );
    expect(source).toMatch(
      /function sessionCatalogQueries\(\): LocalSessionQueryService \{\s+assertLocalSessionWorkersCanStart\(\);/,
    );
    expect(source).toMatch(
      /function sessionStatsQueries\(\): LocalSessionQueryService \{[\s\S]*?assertLocalSessionWorkersCanStart\(\);\s+localSessionStatsQueryService \?\?=/,
    );
  });
});
