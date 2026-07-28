import { describe, expect, it } from "vitest";
import { canDeleteSessionLocally } from "./session-environment";

describe("session environment policy", () => {
  it("allows deleting SSH caches without allowing remote source deletion", () => {
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: false })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: true })).toBe(false);
    expect(canDeleteSessionLocally({ environmentKind: "local", environmentId: "local" })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "wsl", environmentId: "ubuntu" })).toBe(true);
  });
});
