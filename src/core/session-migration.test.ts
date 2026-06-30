import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_TOKEN_LIMIT,
  estimatePortableSessionTokens,
  migrateSession,
  migrationAgentForSource,
  portableSessionFrom,
  supportedMigrationTargets,
} from "./session-migration";
import type { PreparedMigrationSession } from "./session-migration-compression";
import type { WrittenMigratedSession } from "./session-migration-writers";
import type { SessionMessage, SessionSearchResult, SessionSource } from "./types";

function session(
  source: SessionSource,
  overrides: Partial<SessionSearchResult> = {},
): SessionSearchResult {
  return {
    sessionKey: `${source}:1`,
    rawId: "1",
    source,
    projectPath: "/repo",
    filePath: "/tmp/source.jsonl",
    originalTitle: "Original",
    firstQuestion: "Question",
    displayTitle: "Display",
    timestamp: Date.parse("2026-06-23T00:00:00Z"),
    fileMtimeMs: 0,
    fileSize: 0,
    prUrl: null,
    prNumber: null,
    environmentId: "local",
    environmentKind: "local",
    environmentLabel: "Local",
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    customTitle: null,
    favorited: false,
    pinned: false,
    hidden: false,
    tags: [],
    matchSnippet: null,
    lastOpenedAt: null,
    lastResumedAt: null,
    lastActivityAt: 0,
    messageCount: 2,
    aiSummary: null,
    aiSummaryStale: false,
    ...overrides,
  };
}

const messages: SessionMessage[] = [
  { role: "user", content: "你好", timestamp: "2026-06-23T00:00:00Z", index: 9 },
  { role: "assistant", content: "hello", timestamp: "2026-06-23T00:00:01Z", index: 15 },
];

function longMessages(): SessionMessage[] {
  return [
    {
      role: "user",
      content: "a".repeat(MIGRATION_TOKEN_LIMIT * 4 + 1),
      timestamp: "2026-06-23T00:00:00Z",
      index: 0,
    },
    {
      role: "assistant",
      content: "tail",
      timestamp: "2026-06-23T00:00:01Z",
      index: 1,
    },
  ];
}

function writtenMigration(
  overrides: Partial<WrittenMigratedSession> = {},
): WrittenMigratedSession {
  return {
    sessionId: "target-session-1",
    filePath: "/tmp/target-session-1.jsonl",
    ...overrides,
  };
}

function createDependencies() {
  const callOrder: string[] = [];
  const seenRecords: unknown[] = [];
  const inspectCli = vi.fn(async () => {
    callOrder.push("inspectCli");
  });
  const prepare = vi.fn(
    async (portable): Promise<PreparedMigrationSession> => {
      callOrder.push("prepare");
      return {
        session: portable,
        strategy: "complete",
      };
    },
  );
  const write = vi.fn(async () => {
    callOrder.push("write");
    return writtenMigration();
  });
  const record = vi.fn(async (entry) => {
    callOrder.push("record");
    seenRecords.push(entry);
  });
  const refreshIndex = vi.fn(async () => {
    callOrder.push("refreshIndex");
  });
  const launch = vi.fn(async () => {
    callOrder.push("launch");
  });
  const resumeCommand = vi.fn(() => {
    callOrder.push("resumeCommand");
    return "codex resume target-session-1 --cwd /repo";
  });
  const fallbackResumeCommand = vi.fn(
    (target: string, sessionId: string, projectPath: string) => {
      callOrder.push("fallbackResumeCommand");
      return `cd '${projectPath}' && ${target} resume ${sessionId}`;
    },
  );
  const projectPathExists = vi.fn(async () => true);
  const projectPathIsDirectory = vi.fn(async () => true);
  const onProgress = vi.fn((event) => {
    callOrder.push(`progress:${event.stage}`);
  });
  const idFactory = vi.fn(() => "record-uuid-1");
  const now = vi.fn(() => 1_719_100_800_000);

  return {
    deps: {
      inspectCli,
      prepare,
      write,
      record,
      refreshIndex,
      launch,
      resumeCommand,
      fallbackResumeCommand,
      projectPathExists,
      projectPathIsDirectory,
      onProgress,
      idFactory,
      now,
    },
    callOrder,
    seenRecords,
    inspectCli,
    prepare,
    write,
    record,
    refreshIndex,
    launch,
    resumeCommand,
    fallbackResumeCommand,
    projectPathExists,
    projectPathIsDirectory,
    onProgress,
    idFactory,
    now,
  };
}

describe("session migration model", () => {
  it.each([
    ["claude-cli", "claude"],
    ["claude-app", "claude"],
    ["claude-internal", "claude"],
    ["codex-cli", "codex"],
    ["codex-app", "codex"],
    ["codex-internal", "codex"],
    ["codebuddy-cli", "codebuddy"],
    ["openclaw", null],
    ["hermes", null],
    ["opencode-cli", null],
    ["cursor-agent", null],
    ["trae", null],
  ] as const)("maps %s to %s", (source, expected) => {
    expect(migrationAgentForSource(source)).toBe(expected);
  });

  it.each([
    ["claude-cli", ["claude", "codex", "codebuddy"]],
    ["codex-app", ["claude", "codex", "codebuddy"]],
    ["codebuddy-cli", ["claude", "codex", "codebuddy"]],
    ["hermes", []],
  ] as const)("returns ordered migration targets for %s", (source, expected) => {
    expect(supportedMigrationTargets(source)).toEqual(expected);
  });

  it("normalizes a local session and copies only user and assistant messages", () => {
    const input = [
      messages[0],
      {
        role: "system",
        content: "do not copy",
        timestamp: "2026-06-23T00:00:00.500Z",
        index: 10,
      },
      messages[1],
    ] as SessionMessage[];

    expect(portableSessionFrom(session("claude-cli"), input)).toEqual({
      sourceSessionKey: "claude-cli:1",
      sourceAgent: "claude",
      title: "Display",
      projectPath: "/repo",
      startedAt: "2026-06-23T00:00:00.000Z",
      messages: [
        { role: "user", content: "你好", timestamp: "2026-06-23T00:00:00Z", index: 0 },
        { role: "assistant", content: "hello", timestamp: "2026-06-23T00:00:01Z", index: 1 },
      ],
    });
  });

  it.each([
    { environmentKind: "ssh", environmentId: "remote" },
    { environmentKind: "local", environmentId: "imported-local" },
  ] as const)("rejects a non-local session", (environment) => {
    expect(() => portableSessionFrom(session("claude-cli", environment), messages)).toThrow(
      "Remote session migration is not supported yet.",
    );
  });

  it("rejects an unsupported source", () => {
    expect(() => portableSessionFrom(session("hermes"), messages)).toThrow(
      "Session source hermes cannot be migrated.",
    );
  });

  it.each(["", "   "])("rejects an empty project path", (projectPath) => {
    expect(() => portableSessionFrom(session("claude-cli", { projectPath }), messages)).toThrow(
      "Session has no project path.",
    );
  });

  it("estimates tokens from Unicode JavaScript character length and rounds up", () => {
    const portable = portableSessionFrom(session("claude-cli"), [
      { role: "user", content: "你好🙂a", timestamp: "2026-06-23T00:00:00Z", index: 0 },
    ]);

    expect("你好🙂a".length).toBe(5);
    expect(estimatePortableSessionTokens(portable)).toBe(2);
    expect(MIGRATION_TOKEN_LIMIT).toBe(60_000);
  });
});

describe("migrateSession", () => {
  it.each([
    ["claude-cli", "claude"],
    ["claude-cli", "codex"],
    ["claude-cli", "codebuddy"],
    ["codex-cli", "claude"],
    ["codex-cli", "codex"],
    ["codex-cli", "codebuddy"],
    ["codebuddy-cli", "claude"],
    ["codebuddy-cli", "codex"],
    ["codebuddy-cli", "codebuddy"],
  ] as const)("migrates %s to %s", async (source, target) => {
    const { deps, write, launch, refreshIndex, seenRecords } = createDependencies();

    const result = await migrateSession({
      source: session(source),
      messages,
      target,
      deps,
    });

    expect(result).toEqual({
      target,
      targetSessionId: "target-session-1",
      targetFilePath: "/tmp/target-session-1.jsonl",
      strategy: "complete",
      resumeCommand: "codex resume target-session-1 --cwd /repo",
      indexed: true,
      launched: true,
    });
    expect(write).toHaveBeenCalledOnce();
    expect(refreshIndex).toHaveBeenCalledWith(target, "/tmp/target-session-1.jsonl");
    expect(launch).toHaveBeenCalledOnce();
    expect(seenRecords).toEqual([
      {
        id: "record-uuid-1",
        sourceSessionKey: `${source}:1`,
        sourceAgent: migrationAgentForSource(source),
        targetAgent: target,
        targetSessionId: "target-session-1",
        targetFilePath: "/tmp/target-session-1.jsonl",
        strategy: "complete",
        createdAt: 1_719_100_800_000,
      },
    ]);
  });

  it.each([
    [
      "unsupported source",
      session("hermes"),
      "codex",
      "Session source hermes cannot be migrated.",
    ],
    [
      "remote session",
      session("claude-cli", { environmentKind: "ssh", environmentId: "remote" }),
      "codex",
      "Remote session migration is not supported yet.",
    ],
    [
      "empty project path",
      session("claude-cli", { projectPath: "   " }),
      "codex",
      "Session has no project path.",
    ],
  ] as const)(
    "rejects %s before inspect or write",
    async (_label, sourceSession, target, expectedMessage) => {
      const { deps, inspectCli, write, record, refreshIndex, launch } = createDependencies();

      await expect(
        migrateSession({
          source: sourceSession,
          messages,
          target,
          deps,
        }),
      ).rejects.toThrow(expectedMessage);

      expect(inspectCli).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      expect(refreshIndex).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("rejects an invalid target before inspect or write", async () => {
    const { deps, inspectCli, write } = createDependencies();

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "hermes" as never,
        deps,
      }),
    ).rejects.toThrow("Migration target hermes is not supported.");

    expect(inspectCli).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects when the project path does not exist before inspect or write", async () => {
    const { deps, inspectCli, write, projectPathExists, projectPathIsDirectory } =
      createDependencies();
    projectPathExists.mockResolvedValue(false);

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "codex",
        deps,
      }),
    ).rejects.toThrow("Session project path does not exist: /repo");

    expect(projectPathExists).toHaveBeenCalledWith("/repo");
    expect(projectPathIsDirectory).not.toHaveBeenCalled();
    expect(inspectCli).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects when the project path is not a directory before inspect or write", async () => {
    const { deps, inspectCli, write, projectPathIsDirectory } = createDependencies();
    projectPathIsDirectory.mockResolvedValue(false);

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "codex",
        deps,
      }),
    ).rejects.toThrow("Session project path is not a directory: /repo");

    expect(inspectCli).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("fails fast when the CLI preflight fails and does not write any file", async () => {
    const { deps, inspectCli, prepare, write, record, refreshIndex, launch } =
      createDependencies();
    inspectCli.mockRejectedValue(new Error("codex CLI is not installed"));

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "codex",
        deps,
      }),
    ).rejects.toThrow("codex CLI is not installed");

    expect(prepare).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(refreshIndex).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("does not emit compressing for a short session", async () => {
    const { deps, onProgress } = createDependencies();

    await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(onProgress.mock.calls.map(([event]) => event.stage)).toEqual([
      "reading",
      "writing",
      "indexing",
      "launching",
    ]);
  });

  it("emits compressing for a long session", async () => {
    const { deps, onProgress, prepare } = createDependencies();
    prepare.mockImplementation(async (portable) => ({
      session: portable,
      strategy: "locally-truncated",
    }));

    const result = await migrateSession({
      source: session("claude-cli"),
      messages: longMessages(),
      target: "codex",
      deps,
    });

    expect(result.strategy).toBe("locally-truncated");
    expect(onProgress.mock.calls.map(([event]) => event.stage)).toEqual([
      "reading",
      "compressing",
      "writing",
      "indexing",
      "launching",
    ]);
  });

  it("isolates progress callback errors and preserves the exact stage order", async () => {
    const { deps, callOrder, onProgress } = createDependencies();
    onProgress.mockImplementation((event) => {
      callOrder.push(`progress:${event.stage}`);
      if (event.stage === "compressing") {
        throw new Error("observer failed");
      }
    });

    await migrateSession({
      source: session("claude-cli"),
      messages: longMessages(),
      target: "codex",
      deps,
    });

    expect(callOrder).toEqual([
      "progress:reading",
      "inspectCli",
      "progress:compressing",
      "prepare",
      "progress:writing",
      "write",
      "record",
      "resumeCommand",
      "progress:indexing",
      "refreshIndex",
      "progress:launching",
      "launch",
    ]);
  });

  it("rejects on prepare failure before writing", async () => {
    const { deps, write, record, refreshIndex, launch, prepare } = createDependencies();
    prepare.mockRejectedValue(new Error("compression provider failed"));

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "codex",
        deps,
      }),
    ).rejects.toThrow("compression provider failed");

    expect(write).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(refreshIndex).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects on writer failure and does not record, index, or launch", async () => {
    const { deps, write, record, refreshIndex, launch } = createDependencies();
    write.mockRejectedValue(new Error("disk full"));

    await expect(
      migrateSession({
        source: session("claude-cli"),
        messages,
        target: "codex",
        deps,
      }),
    ).rejects.toThrow("disk full");

    expect(record).not.toHaveBeenCalled();
    expect(refreshIndex).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("keeps the written file when recording metadata fails and still indexes and launches", async () => {
    const { deps, record, refreshIndex, launch } = createDependencies();
    record.mockRejectedValue(new Error("database unavailable"));

    const result = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(result.indexed).toBe(true);
    expect(result.launched).toBe(true);
    expect(result.warning).toContain("Failed to record migration metadata: database unavailable");
    expect(refreshIndex).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("returns indexed=false with a warning when refreshIndex fails and still launches", async () => {
    const { deps, refreshIndex, launch } = createDependencies();
    refreshIndex.mockRejectedValue(new Error("index busy"));

    const result = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(result.indexed).toBe(false);
    expect(result.launched).toBe(true);
    expect(result.warning).toContain("Failed to refresh session index: index busy");
    expect(launch).toHaveBeenCalledOnce();
  });

  it("returns launched=false with resumeCommand and a warning when launch fails", async () => {
    const { deps, launch, resumeCommand } = createDependencies();
    launch.mockRejectedValue(new Error("terminal unavailable"));

    const result = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(result.indexed).toBe(true);
    expect(result.launched).toBe(false);
    expect(result.resumeCommand).toBe("codex resume target-session-1 --cwd /repo");
    expect(result.warning).toContain("Failed to launch target session: terminal unavailable");
    expect(resumeCommand).toHaveBeenCalledWith("codex", "target-session-1", "/repo");
  });

  it("records before attempting resumeCommand and downgrades resumeCommand failure to injected cwd-preserving fallback", async () => {
    const {
      deps,
      callOrder,
      record,
      refreshIndex,
      launch,
      resumeCommand,
      fallbackResumeCommand,
      seenRecords,
    } = createDependencies();
    resumeCommand.mockImplementation(() => {
      callOrder.push("resumeCommand");
      throw new Error("resume formatter failed");
    });

    const result = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(record).toHaveBeenCalledOnce();
    expect(seenRecords).toEqual([
      expect.objectContaining({
        sourceSessionKey: "claude-cli:1",
        targetSessionId: "target-session-1",
        targetFilePath: "/tmp/target-session-1.jsonl",
      }),
    ]);
    expect(callOrder.indexOf("record")).toBeLessThan(callOrder.indexOf("resumeCommand"));
    expect(result.targetFilePath).toBe("/tmp/target-session-1.jsonl");
    expect(callOrder.indexOf("resumeCommand")).toBeLessThan(callOrder.indexOf("fallbackResumeCommand"));
    expect(result.resumeCommand).toBe("cd '/repo' && codex resume target-session-1");
    expect(result.indexed).toBe(true);
    expect(result.launched).toBe(true);
    expect(result.warning).toContain("Failed to build resume command: resume formatter failed");
    expect(fallbackResumeCommand).toHaveBeenCalledWith("codex", "target-session-1", "/repo");
    expect(refreshIndex).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  it("preserves a project path with leading and trailing spaces across validation, write, record, fallback formatting, and launch", async () => {
    const rawProjectPath = "  /tmp/repo with spaces/  ";
    const {
      deps,
      projectPathExists,
      projectPathIsDirectory,
      prepare,
      write,
      launch,
      record,
      resumeCommand,
      fallbackResumeCommand,
    } = createDependencies();
    resumeCommand.mockImplementation(() => {
      throw new Error("resume formatter failed");
    });

    const result = await migrateSession({
      source: session("claude-cli", { projectPath: rawProjectPath }),
      messages,
      target: "codex",
      deps,
    });

    expect(projectPathExists).toHaveBeenCalledWith(rawProjectPath);
    expect(projectPathIsDirectory).toHaveBeenCalledWith(rawProjectPath);
    expect(prepare.mock.calls[0]?.[0].projectPath).toBe(rawProjectPath);
    expect(write).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ projectPath: rawProjectPath }),
    );
    expect(record.mock.calls[0]?.[0].targetFilePath).toBe("/tmp/target-session-1.jsonl");
    expect(record.mock.calls[0]?.[0].sourceSessionKey).toBe("claude-cli:1");
    expect(resumeCommand).toHaveBeenCalledWith("codex", "target-session-1", rawProjectPath);
    expect(fallbackResumeCommand).toHaveBeenCalledWith("codex", "target-session-1", rawProjectPath);
    expect(launch).toHaveBeenCalledWith("codex", "target-session-1", rawProjectPath);
    expect(result.resumeCommand).toBe(`cd '${rawProjectPath}' && codex resume target-session-1`);
  });

  it("merges multiple non-fatal warnings without overwriting earlier ones", async () => {
    const { deps, record, refreshIndex, launch } = createDependencies();
    record.mockRejectedValue(new Error("database unavailable"));
    refreshIndex.mockRejectedValue(new Error("index busy"));
    launch.mockRejectedValue(new Error("terminal unavailable"));

    const result = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps,
    });

    expect(result.indexed).toBe(false);
    expect(result.launched).toBe(false);
    expect(result.warning).toBe(
      [
        "Failed to record migration metadata: database unavailable",
        "Failed to refresh session index: index busy",
        "Failed to launch target session: terminal unavailable",
      ].join("\n"),
    );
  });

  it("allows repeated migrations of the same source session", async () => {
    const first = createDependencies();
    const second = createDependencies();
    first.write.mockResolvedValueOnce(
      writtenMigration({ sessionId: "target-session-1", filePath: "/tmp/target-session-1.jsonl" }),
    );
    second.write.mockResolvedValueOnce(
      writtenMigration({ sessionId: "target-session-2", filePath: "/tmp/target-session-2.jsonl" }),
    );
    first.idFactory.mockReturnValueOnce("record-uuid-1");
    second.idFactory.mockReturnValueOnce("record-uuid-2");
    first.now.mockReturnValueOnce(1000);
    second.now.mockReturnValueOnce(2000);

    const firstResult = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps: first.deps,
    });
    const secondResult = await migrateSession({
      source: session("claude-cli"),
      messages,
      target: "codex",
      deps: second.deps,
    });

    expect(firstResult.targetSessionId).toBe("target-session-1");
    expect(secondResult.targetSessionId).toBe("target-session-2");
    expect(first.seenRecords).toEqual([
      expect.objectContaining({ id: "record-uuid-1", createdAt: 1000 }),
    ]);
    expect(second.seenRecords).toEqual([
      expect.objectContaining({ id: "record-uuid-2", createdAt: 2000 }),
    ]);
  });
});
