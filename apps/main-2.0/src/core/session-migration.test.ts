import { describe, expect, it, vi } from "vitest";
import {
  collectMigrationDescendants,
  migrateSession,
  portableSessionFrom,
  sshMigrationTarget,
  type SessionMigrationDependencies,
} from "./session-migration";
import type { PortableSession, SessionMessage, SessionSearchResult, SessionSource } from "./types";

function session(source: SessionSource): SessionSearchResult {
  return {
    sessionKey: `${source}:remote:1`,
    rawId: "1",
    source,
    projectPath: "/srv/repo",
    filePath: "/home/remote/session.jsonl",
    originalTitle: "Original",
    firstQuestion: "Question",
    displayTitle: "Display",
    timestamp: Date.parse("2026-08-08T00:00:00Z"),
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    environmentId: "ssh-1",
    environmentKind: "ssh",
    environmentLabel: "Server",
    tokenUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
    customTitle: null,
    favorited: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 1,
    aiSummary: null,
    aiSummaryStale: false,
  };
}

const messages: SessionMessage[] = [
  { role: "user", content: "hello", timestamp: "2026-08-08T00:00:00Z", index: 0 },
];

describe("session migration descendants", () => {
  it("keeps every indexed descendant instead of silently truncating large trees", () => {
    const root = {
      ...session("codex-cli"),
      rawId: "root",
      sessionKey: "codex:root",
      environmentId: "local",
      environmentKind: "local",
    } as SessionSearchResult;
    const descendants = Array.from({ length: 201 }, (_, index) => ({
      ...root,
      sessionKey: `codex:child-${index}`,
      rawId: `child-${index}`,
      isSubagent: true,
      parentSessionId: "root",
      timestamp: root.timestamp + index,
    } as SessionSearchResult));

    expect(collectMigrationDescendants(root, descendants)).toHaveLength(201);
  });
});

describe("SSH session migration policy", () => {
  it.each([
    ["claude-cli", "codex"],
    ["codex-cli", "claude"],
    ["claude-app", null],
    ["codex-app", null],
    ["tclaude-cli", null],
    ["tcodex-cli", null],
    ["hermes", null],
  ] as const)("maps SSH source %s to the supported remote target %s", (source, expected) => {
    expect(sshMigrationTarget(source)).toBe(expected);
  });

  it("rejects SSH portable conversion unless the desktop flow opts in", () => {
    expect(() => portableSessionFrom(session("claude-cli"), messages)).toThrow(
      "SSH session migration is not supported yet.",
    );
  });

  it("allows a guarded SSH source to become a portable session", () => {
    expect(portableSessionFrom(session("claude-cli"), messages, { allowSsh: true })).toMatchObject({
      sourceAgent: "claude",
      projectPath: "/srv/repo",
    });
  });

  it("normalizes a missing project path for migration", () => {
    expect(portableSessionFrom({ ...session("claude-cli"), projectPath: "   " }, messages, { allowSsh: true })).toMatchObject({
      projectPath: "",
    });
  });
});

describe("subagent migration", () => {
  it("treats a directly selected ZCode subagent as a root task", async () => {
    const source = {
      ...session("cursor-agent"),
      environmentId: "local",
      environmentKind: "local",
      isSubagent: true,
      parentSessionId: "source-parent",
    } as SessionSearchResult;
    const write = vi.fn<SessionMigrationDependencies["write"]>(async () => ({
      sessionId: "target-session",
      filePath: "/tmp/target-session",
    }));
    const deps: SessionMigrationDependencies = {
      inspectCli: vi.fn(),
      prepare: vi.fn<SessionMigrationDependencies["prepare"]>(async (portable) => ({ session: portable, strategy: "complete" })),
      write,
      record: vi.fn(),
      refreshIndex: vi.fn(),
      launch: vi.fn(),
      resumeCommand: vi.fn(() => "Open ZCode"),
      fallbackResumeCommand: vi.fn(() => "Open ZCode"),
      idFactory: vi.fn(() => "record-id"),
      now: vi.fn(() => 1),
      projectPathExists: vi.fn(() => true),
      projectPathIsDirectory: vi.fn(() => true),
    };

    await migrateSession({ source, messages, target: "zcode", deps });

    expect(write).toHaveBeenCalledWith("zcode", expect.objectContaining({
      isSubagent: false,
      parentSessionId: null,
    }));
  });

  it("writes nested child sessions and omits system completion messages from the parent", async () => {
    const root = {
      ...session("cursor-agent"),
      sessionKey: "cursor:root",
      rawId: "root",
      environmentId: "local",
      environmentKind: "local",
      projectPath: "/repo",
    } as SessionSearchResult;
    const subagents: PortableSession[] = [{
      sourceSessionKey: "cursor:child",
      sourceSessionId: "child",
      sourceAgent: "cursor",
      title: "Child",
      projectPath: "/repo",
      startedAt: "2026-08-08T00:00:02Z",
      messages: [{ role: "assistant", content: "child result", timestamp: "2026-08-08T00:00:03Z", index: 0 }],
      isSubagent: true,
      parentSessionId: "root",
    }];
    const targetIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ];
    const write = vi.fn<SessionMigrationDependencies["write"]>(async (_target, _portable, targetSessionId) => ({
      sessionId: targetSessionId!,
      filePath: `/tmp/${targetSessionId}.jsonl`,
    }));
    const deps: SessionMigrationDependencies = {
      inspectCli: vi.fn(),
      prepare: vi.fn<SessionMigrationDependencies["prepare"]>(async (portable) => ({ session: portable, strategy: "complete" })),
      write,
      record: vi.fn(),
      refreshIndex: vi.fn(),
      launch: vi.fn(),
      resumeCommand: vi.fn(() => "codex resume"),
      fallbackResumeCommand: vi.fn(() => "codex resume"),
      idFactory: vi.fn(() => "record-id"),
      targetSessionIdFactory: vi.fn(() => targetIds.shift()!),
      now: vi.fn(() => 1),
      projectPathExists: vi.fn(() => true),
      projectPathIsDirectory: vi.fn(() => true),
    };

    const result = await migrateSession({
      source: root,
      messages: [
        messages[0],
        {
          role: "user",
          content: "<system_notification><task>kind: subagent title: Child</task></system_notification>",
          timestamp: "2026-08-08T00:00:03Z",
          index: 1,
        },
      ],
      subagents,
      target: "codex",
      deps,
    });

    expect(result.restoredSubagentCount).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]?.[1].messages.map((entry) => entry.content)).toEqual(["hello"]);
    expect(write.mock.calls[0]?.[1].subagents).toEqual([
      expect.objectContaining({ sourceSessionId: "10000000-0000-4000-8000-000000000002", subagentDepth: 1 }),
    ]);
    expect(write.mock.calls[1]?.[1]).toMatchObject({
      parentSessionId: "10000000-0000-4000-8000-000000000001",
      subagentDepth: 1,
    });
  });

  it("merges Cursor task metadata with its complete transcript before Codex migration", async () => {
    const root = {
      ...session("cursor-agent"),
      sessionKey: "cursor:root",
      rawId: "root",
      environmentId: "local",
      environmentKind: "local",
      projectPath: "/repo",
    } as SessionSearchResult;
    const startedAt = "2026-08-08T00:00:04Z";
    const subagents: PortableSession[] = [{
      sourceSessionKey: "cursor:66b05627-84d3-4789-b3df-772bf1bb04ad",
      sourceSessionId: "66b05627-84d3-4789-b3df-772bf1bb04ad",
      sourceAgent: "cursor",
      title: "Read documentation",
      projectPath: "/repo",
      startedAt,
      messages: [
        { role: "user", content: "full request", timestamp: startedAt, index: 0 },
        { role: "assistant", content: "full result", timestamp: "", index: 1 },
      ],
      isSubagent: true,
      parentSessionId: "root",
    }, {
      sourceSessionKey: "cursor:task-9026680a-0962-4466-a9b8-8e2efa96e19f",
      sourceSessionId: "task-9026680a-0962-4466-a9b8-8e2efa96e19f",
      sourceAgent: "cursor",
      title: "Read documentation",
      projectPath: "/repo",
      startedAt,
      messages: [{ role: "assistant", content: "summary only", timestamp: startedAt, index: 0 }],
      isSubagent: true,
      parentSessionId: "coordinator",
    }, {
      sourceSessionKey: "cursor:coordinator",
      sourceSessionId: "coordinator",
      sourceAgent: "cursor",
      title: "Coordinator",
      projectPath: "/repo",
      startedAt: "2026-08-08T00:00:02Z",
      messages: [{ role: "assistant", content: "coordinate", timestamp: "2026-08-08T00:00:03Z", index: 0 }],
      isSubagent: true,
      parentSessionId: "root",
    }];
    const targetIds = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    const write = vi.fn<SessionMigrationDependencies["write"]>(async (_target, _portable, targetSessionId) => ({
      sessionId: targetSessionId!,
      filePath: `/tmp/${targetSessionId}.jsonl`,
    }));
    const deps: SessionMigrationDependencies = {
      inspectCli: vi.fn(),
      prepare: vi.fn<SessionMigrationDependencies["prepare"]>(async (portable) => ({ session: portable, strategy: "complete" })),
      write,
      record: vi.fn(),
      refreshIndex: vi.fn(),
      launch: vi.fn(),
      resumeCommand: vi.fn(() => "codex resume"),
      fallbackResumeCommand: vi.fn(() => "codex resume"),
      idFactory: vi.fn(() => "record-id"),
      targetSessionIdFactory: vi.fn(() => targetIds.shift()!),
      now: vi.fn(() => 1),
      projectPathExists: vi.fn(() => true),
      projectPathIsDirectory: vi.fn(() => true),
    };

    const result = await migrateSession({
      source: root,
      messages: [...messages, {
        role: "assistant",
        content: "[full](66b05627-84d3-4789-b3df-772bf1bb04ad) [metadata](task-9026680a-0962-4466-a9b8-8e2efa96e19f) [docs](https://example.com)",
        timestamp: "2026-08-08T00:00:06Z",
        index: 1,
      }],
      subagents,
      target: "codex",
      deps,
    });

    expect(result.restoredSubagentCount).toBe(2);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[0]?.[1].subagents).toEqual([
      expect.objectContaining({ sourceSessionId: "10000000-0000-4000-8000-000000000002" }),
    ]);
    expect(write.mock.calls[0]?.[1].messages.at(-1)?.content).toBe(
      "[full](10000000-0000-4000-8000-000000000003) [metadata](10000000-0000-4000-8000-000000000003) [docs](https://example.com)",
    );
    expect(write.mock.calls[1]?.[1].subagents).toEqual([
      expect.objectContaining({ sourceSessionId: "10000000-0000-4000-8000-000000000003" }),
    ]);
    expect(write.mock.calls[2]?.[1]).toMatchObject({
      sourceSessionId: "66b05627-84d3-4789-b3df-772bf1bb04ad",
      parentSessionId: "10000000-0000-4000-8000-000000000002",
      messages: [
        expect.objectContaining({ content: "full request" }),
        expect.objectContaining({ content: "full result" }),
      ],
    });
  });
});
