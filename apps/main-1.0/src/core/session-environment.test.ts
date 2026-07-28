import { describe, expect, it } from "vitest";
import { canDeleteSessionLocally } from "./session-environment";

describe("session environment", () => {
  it("allows deleting cached SSH records without allowing deletion of available SSH sources", () => {
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: false })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: true })).toBe(false);
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev" })).toBe(false);
    expect(canDeleteSessionLocally({ environmentKind: "local", environmentId: "local" })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "wsl", environmentId: "ubuntu" })).toBe(true);
  });
});
