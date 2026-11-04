import { describe, expect, test } from "vitest";
import { isPersistedAppStateV5 } from "./agent-hub-persisted-migrations";

function state(version: number) {
  return { version, workDir: "C:/repo", sessions: [], messages: [], events: [], tasks: [], taskMessages: [], taskEvents: [] };
}

describe("AgentHub persistence validation", () => {
  test("accepts only the current V5 state", () => {
    expect(isPersistedAppStateV5(state(5))).toBe(true);
    expect(isPersistedAppStateV5(state(4))).toBe(false);
  });

  test("accepts V5 state containing retired Agent Team, Task, and Workflow collections", () => {
    expect(isPersistedAppStateV5({
      ...state(5),
      teams: [{ id: "team-1" }],
      teamRuns: [{ id: "run-1" }],
      tasks: [{ id: "task-1" }],
      workflowStore: { workflows: [{ workflowId: "wf-1" }] },
      workflowNodeConversations: {},
    })).toBe(true);
  });
});
