import { describe, expect, it } from "vitest";
import { canDeleteSessionLocally, isSharedSessionSourceDatabase } from "./session-environment";

describe("session environment", () => {
  it("allows deleting cached SSH records without allowing deletion of available SSH sources", () => {
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: false })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev", sourceAvailable: true })).toBe(false);
    expect(canDeleteSessionLocally({ environmentKind: "ssh", environmentId: "dev" })).toBe(false);
    expect(canDeleteSessionLocally({ environmentKind: "local", environmentId: "local" })).toBe(true);
    expect(canDeleteSessionLocally({ environmentKind: "wsl", environmentId: "ubuntu" })).toBe(true);
    expect(canDeleteSessionLocally({
      environmentKind: "local",
      environmentId: "local",
      source: "pi-cli",
    })).toBe(false);
    expect(canDeleteSessionLocally({
      environmentKind: "local",
      environmentId: "local",
      source: "workbuddy-cli",
    })).toBe(false);
    expect(canDeleteSessionLocally({
      environmentKind: "local",
      environmentId: "local",
      source: "kimi-cli",
    })).toBe(false);
  });

  it("identifies shared multi-session source databases", () => {
    expect(isSharedSessionSourceDatabase({ source: "hermes", filePath: "/home/user/.hermes/state.db" })).toBe(true);
    expect(isSharedSessionSourceDatabase({ source: "opencode-cli", filePath: "/tmp/opencode.db" })).toBe(true);
    expect(isSharedSessionSourceDatabase({ source: "cursor-agent", filePath: "/tmp/state.vscdb" })).toBe(true);
    expect(isSharedSessionSourceDatabase({ source: "codex-cli", filePath: "/tmp/rollout.jsonl" })).toBe(false);
  });
});
