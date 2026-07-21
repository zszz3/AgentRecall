import { describe, expect, test } from "vitest";
import { isPersistedAppStateV5 } from "./agent-hub-persisted-migrations";

function state(version: number) {
  return { version, workDir: "C:/repo", sessions: [], messages: [], events: [], tasks: [], taskMessages: [], taskEvents: [], teams: [], teamRuns: [] };
}

describe("persisted app state validation", () => {
  test("accepts only the current V5 state", () => {
    expect(isPersistedAppStateV5(state(5))).toBe(true);
    expect(isPersistedAppStateV5(state(4))).toBe(false);
  });
});
