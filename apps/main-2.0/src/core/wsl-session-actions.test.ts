import { describe, expect, it, vi } from "vitest";
import type { SessionEnvironment } from "./types";
import { deleteWslSessionFiles, deleteWslSessionSources } from "./wsl-session-actions";

const environment: SessionEnvironment = {
  id: "wsl-ubuntu", kind: "wsl", label: "Ubuntu", wslDistribution: "Ubuntu",
  hostAlias: null, host: null, user: null, port: null, authMode: "none", identityFile: null,
  enabled: true, syncState: "idle", lastSyncedAt: null, lastError: null, createdAt: 1, updatedAt: 1,
};

describe("deleteWslSessionFiles", () => {
  it("deletes all paths in one remote command", async () => {
    const run = vi.fn(async (_environment: SessionEnvironment, _command: string) => "");
    await deleteWslSessionFiles(environment, ["/home/me/one.jsonl", "/home/me/two's.jsonl"], run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toContain("'/home/me/one.jsonl' '/home/me/two'\"'\"'s.jsonl'");
  });

  it("deletes Claude companion artifacts with explicit safe paths", async () => {
    const run = vi.fn(async (_environment: SessionEnvironment, _command: string) => "");
    await deleteWslSessionSources(environment, [{
      source: "claude-cli",
      rawId: "parent",
      filePath: "/home/me/.claude/projects/repo/parent.jsonl",
      isSubagent: false,
    }], run);

    expect(run.mock.calls[0][1]).toContain("rm -f -- '/home/me/.claude/projects/repo/parent.jsonl'");
    expect(run.mock.calls[0][1]).toContain("rm -rf -- '/home/me/.claude/projects/repo/parent/subagents'");
    expect(run.mock.calls[0][1]).toContain("'/home/me/.claude/projects/repo/parent/tool-results'");
    expect(run.mock.calls[0][1].indexOf("if [ -d")).toBeLessThan(run.mock.calls[0][1].indexOf("rm -f"));
  });

  it("checks that an orphaned Claude parent source is absent before deletion", async () => {
    const run = vi.fn(async (_environment: SessionEnvironment, _command: string) => "");
    await deleteWslSessionSources(environment, [{
      source: "claude-cli",
      rawId: "child",
      filePath: "/home/me/.claude/projects/repo/missing-parent/subagents/agent-child.jsonl",
      isSubagent: true,
      orphanedParentSessionId: "missing-parent",
    }], run);

    const command = run.mock.calls[0][1];
    expect(command).toContain("if [ -e '/home/me/.claude/projects/repo/missing-parent.jsonl' ]");
    expect(command.indexOf("missing-parent.jsonl")).toBeLessThan(command.indexOf("rm -f"));
  });
});
