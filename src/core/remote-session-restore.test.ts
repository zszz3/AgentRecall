import { describe, expect, it, vi } from "vitest";
import { restoreRemotePortableSession } from "./remote-session-restore";
import type { PortableSession } from "./types";

const PORTABLE: PortableSession = {
  sourceSessionKey: "codex:abc",
  sourceAgent: "codex",
  title: "Fix auth",
  projectPath: "/device-a/repo",
  startedAt: "2026-07-03T10:00:00.000Z",
  messages: [
    { role: "user", content: "broken auth", timestamp: "2026-07-03T10:00:00.000Z", index: 0 },
    { role: "assistant", content: "fixed auth", timestamp: "2026-07-03T10:01:00.000Z", index: 1 },
  ],
};

describe("restoreRemotePortableSession", () => {
  it("restores a remote portable session with the selected local project path", async () => {
    const write = vi.fn(async (_target, session: PortableSession) => ({
      sessionId: "target-session",
      filePath: "/target/session.jsonl",
      projectPath: session.projectPath,
    }));
    const record = vi.fn();
    const refreshIndex = vi.fn();
    const launch = vi.fn();

    const result = await restoreRemotePortableSession({
      remoteId: "remote-1",
      portable: PORTABLE,
      target: "claude",
      localProjectPath: "/device-b/repo",
      deps: {
        inspectCli: vi.fn(),
        prepare: async (session) => ({ session, strategy: "complete" }),
        write,
        record,
        refreshIndex,
        launch,
        resumeCommand: (_target, sessionId, projectPath) => `cd ${projectPath} && claude --resume ${sessionId}`,
        fallbackResumeCommand: () => "claude --resume target-session",
        idFactory: () => "migration-id",
        now: () => 123,
        projectPathExists: async () => true,
        projectPathIsDirectory: async () => true,
      },
    });

    expect(write).toHaveBeenCalledWith("claude", expect.objectContaining({ projectPath: "/device-b/repo" }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionKey: "remote:remote-1",
      sourceAgent: "codex",
      targetAgent: "claude",
    }));
    expect(refreshIndex).toHaveBeenCalledWith("claude", "/target/session.jsonl");
    expect(launch).toHaveBeenCalledWith("claude", "target-session", "/device-b/repo");
    expect(result).toMatchObject({
      target: "claude",
      targetSessionId: "target-session",
      strategy: "complete",
      launched: true,
      indexed: true,
    });
  });

  it("rejects a missing local project path before writing", async () => {
    const write = vi.fn();
    await expect(
      restoreRemotePortableSession({
        remoteId: "remote-1",
        portable: PORTABLE,
        target: "codex",
        localProjectPath: "/missing",
        deps: {
          inspectCli: vi.fn(),
          prepare: async (session) => ({ session, strategy: "complete" }),
          write,
          record: vi.fn(),
          refreshIndex: vi.fn(),
          launch: vi.fn(),
          resumeCommand: () => "codex resume target-session",
          fallbackResumeCommand: () => "codex resume target-session",
          idFactory: () => "migration-id",
          now: () => 123,
          projectPathExists: async () => false,
          projectPathIsDirectory: async () => false,
        },
      }),
    ).rejects.toThrow("does not exist");
    expect(write).not.toHaveBeenCalled();
  });
});
