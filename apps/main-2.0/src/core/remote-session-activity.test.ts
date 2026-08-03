import { describe, expect, it } from "vitest";
import { loadRemoteLiveSessions } from "./remote-session-activity";
import type { SessionEnvironment } from "./types";

const wslEnvironment: SessionEnvironment = {
  id: "wsl-ubuntu",
  kind: "wsl",
  label: "Ubuntu",
  wslDistribution: "Ubuntu",
  hostAlias: null,
  host: null,
  user: null,
  port: null,
  authMode: "none",
  identityFile: null,
  enabled: true,
  syncState: "idle",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
};

describe("remote live session deletion guards", () => {
  it("loads Claude sessions from WSL", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () =>
      '{"family":"claude","rawId":"remote-claude","pid":43}')).resolves.toEqual([
      { family: "claude", rawId: "remote-claude", pid: 43, environmentId: "wsl-ubuntu" },
    ]);
  });

  it("fails closed when WSL inspection fails", async () => {
    await expect(loadRemoteLiveSessions([wslEnvironment], async () => {
      throw new Error("offline");
    })).rejects.toThrow("Could not inspect live sessions in WSL environment Ubuntu: offline");
  });
});
