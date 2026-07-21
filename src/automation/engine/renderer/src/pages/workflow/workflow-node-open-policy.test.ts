import { describe, expect, test } from "vitest";
import { workflowNodeOpenTarget } from "./workflow-node-open-policy";

describe("workflow node open policy", () => {
  test("opens every LLM node in the agent conversation window", () => {
    expect(workflowNodeOpenTarget("llm")).toBe("agent");
  });

  test("opens script nodes in a dedicated script surface", () => {
    expect(workflowNodeOpenTarget("script")).toBe("script");
  });
});
