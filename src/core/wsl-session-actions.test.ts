import { describe, expect, it, vi } from "vitest";
import { deleteWslSessionFile } from "./wsl-session-actions";
import type { SessionEnvironment } from "./types";

const environment: SessionEnvironment = {
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
  syncState: "watching",
  lastSyncedAt: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("WSL session actions", () => {
  it("deletes the absolute Linux session path inside the selected distribution", async () => {
    const runCommand = vi.fn(async () => "");

    await deleteWslSessionFile(environment, "/home/admin/.codex/sessions/2026/task's.jsonl", runCommand);

    expect(runCommand).toHaveBeenCalledWith(
      environment,
      `rm -f -- '/home/admin/.codex/sessions/2026/task'"'"'s.jsonl'`,
    );
  });

  it("rejects non-absolute paths before invoking WSL", async () => {
    const runCommand = vi.fn(async () => "");

    await expect(deleteWslSessionFile(environment, "relative/session.jsonl", runCommand)).rejects.toThrow(
      "WSL session path must be absolute",
    );
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("keeps remote deletion failures visible to the caller", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("rm failed");
    });

    await expect(deleteWslSessionFile(environment, "/home/admin/session.jsonl", runCommand)).rejects.toThrow("rm failed");
  });
});
