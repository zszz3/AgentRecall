import { describe, expect, it } from "vitest";
import { canDeleteSessionLocally } from "./session-environment";

describe("session environment", () => {
  it("treats externally managed Kimi sessions as read-only", () => {
    expect(canDeleteSessionLocally({
      environmentKind: "local",
      environmentId: "local",
      source: "kimi-cli",
    })).toBe(false);
  });
});
