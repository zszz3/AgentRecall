import { describe, expect, test } from "vitest";
import { clearWorkflowNodeInputDraft, updateWorkflowNodeInputDrafts } from "./workflow-node-input-controller";

describe("workflow node input drafts", () => {
  test("keeps drafts isolated by node surface scope", () => {
    const first = updateWorkflowNodeInputDrafts({}, "agent:research", "message", "hello");
    const second = updateWorkflowNodeInputDrafts(first, "script:transform", "body", "{\"ok\":true}");
    expect(second).toEqual({
      "agent:research": { message: "hello" },
      "script:transform": { body: "{\"ok\":true}" },
    });
  });

  test("keeps every field entered in the same request form", () => {
    const first = updateWorkflowNodeInputDrafts({}, "script:request", "query", "openai");
    const second = updateWorkflowNodeInputDrafts(first, "script:request", "authorization", "Bearer token");
    const third = updateWorkflowNodeInputDrafts(second, "script:request", "body", "{\"limit\":10}");
    expect(third["script:request"]).toEqual({ query: "openai", authorization: "Bearer token", body: "{\"limit\":10}" });
  });

  test("clears only the successfully submitted node draft", () => {
    const drafts = {
      "agent:research": { message: "hello" },
      "script:transform": { body: "{}" },
    };
    expect(clearWorkflowNodeInputDraft(drafts, "agent:research")).toEqual({
      "script:transform": { body: "{}" },
    });
  });
});
