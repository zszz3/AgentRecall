import { describe, expect, test } from "vitest";
import { isWorkflowRunNodeStatus } from "./agent-hub-persistence";
import { isPersistedAppStateV5 } from "./agent-hub-persisted-migrations";

function state(version: number) {
  return { version, workDir: "C:/repo", sessions: [], messages: [], events: [], tasks: [], taskMessages: [], taskEvents: [] };
}

describe("AgentHub persistence validation", () => {
  test("accepts the durable status for a human-approved review result", () => {
    expect(isWorkflowRunNodeStatus("completed_with_override")).toBe(true);
  });

  test("accepts only the current V5 state", () => {
    expect(isPersistedAppStateV5(state(5))).toBe(true);
    expect(isPersistedAppStateV5(state(4))).toBe(false);
  });

  test("accepts V5 state containing legacy Agent Team collections", () => {
    expect(isPersistedAppStateV5({ ...state(5), teams: [{ id: "team-1" }], teamRuns: [{ id: "run-1" }] })).toBe(true);
  });

  test("rejects a non-array workflow conversation collection", () => {
    expect(isPersistedAppStateV5({ ...state(5), workflowNodeConversations: {} })).toBe(false);
  });
});
