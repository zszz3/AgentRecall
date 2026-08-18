import { describe, expect, it } from "vitest";
import { canDeleteSessionLocally } from "./session-environment";
import { isReadOnlySessionSource, sessionSourceDescriptor } from "./session-sources";

describe("session deletion environment policy", () => {
  it("treats DeepSeek Harness source artifacts as read-only", () => {
    expect(isReadOnlySessionSource("deepseek-harness")).toBe(true);
    expect(sessionSourceDescriptor("deepseek-harness").label).toBe("DeepSeek Harness");
    expect(canDeleteSessionLocally({
      environmentKind: "local",
      environmentId: "local",
      source: "deepseek-harness",
      sourceAvailable: true,
    })).toBe(false);
  });
});
