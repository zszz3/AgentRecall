import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createMcpTemporarySessionCleaner,
  loadMcpSourceSession,
  migrateSessionForMcp,
} from "./mcp-migration";
import { createInMemoryStore } from "./postgres/test-session-store";
import {
  loadClaudeCliSessionRows,
  loadCodeBuddyCliSessionFile,
  loadCodeWizSessions,
  loadCodexSessionRows,
  loadCursorTranscriptFile,
  loadZcodeSessions,
  parseJsonlText,
} from "./session-loader";
import { parseDeepSeekSessionLog, projectDeepSeekSession } from "./deepseek-harness";
import { migrationTargetDescriptor } from "./migration-targets";
import { defaultSettings } from "./platform";
import type { IndexedSession, MigrationTarget, SessionMessage, SessionSource } from "./types";

const temporaryProjectDirectories = new Set<string>();

function makeProjectDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-project-"));
  temporaryProjectDirectories.add(directory);
  return directory;
}

afterAll(() => {
  for (const directory of temporaryProjectDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

async function seedLocalSession(
  store: ReturnType<typeof createInMemoryStore>,
  overrides: Partial<IndexedSession> & { messages?: SessionMessage[] } = {},
): Promise<{ sessionKey: string; projectPath: string }> {
  const projectPath = overrides.projectPath ?? makeProjectDir();
  const sessionKey = overrides.sessionKey ?? "codex:source-1";
  const base: IndexedSession = {
    sessionKey,
    rawId: "source-1",
    source: "codex-cli",
    projectPath,
    filePath: "/tmp/source-1.jsonl",
    originalTitle: "Source Session",
    firstQuestion: "how do I fix the bug",
    timestamp: new Date("2026-06-01T10:00:00Z").getTime(),
    fileMtimeMs: 1,
    fileSize: 100,
    prUrl: null,
    prNumber: null,
    ...overrides,
  };
  const messages = overrides.messages ?? [
    { role: "user", content: "how do I fix the bug", timestamp: "2026-06-01T10:00:00Z", index: 0 },
    { role: "assistant", content: "I will help you fix the bug", timestamp: "2026-06-01T10:01:00Z", index: 1 },
  ];
  await store.upsertIndexedSession(base, messages, [], []);
  return { sessionKey, projectPath };
}



function loadMigratedSessionFileForTest(target: MigrationTarget, filePath: string, sessionId?: string) {
  if (target === "cursor") return loadCursorTranscriptFile(filePath);
  if (target === "deepseek") {
    const log = parseDeepSeekSessionLog(fs.readFileSync(filePath));
    return log ? projectDeepSeekSession(log) : null;
  }

  const descriptor = migrationTargetDescriptor(target);
  if (descriptor.family === "codebuddy") return loadCodeBuddyCliSessionFile(filePath);
  if (descriptor.family === "codewiz") return loadCodeWizSessions(path.dirname(filePath)).find((item) => item.session.rawId === path.basename(filePath, ".jsonl")) ?? loadCodeWizSessions(path.dirname(filePath))[0] ?? null;
  if (descriptor.family === "zcode") {
    const sessions = loadZcodeSessions(path.dirname(path.dirname(path.dirname(filePath))));
    return sessions.find((item) => item.session.rawId === sessionId) ?? sessions[0] ?? null;
  }

  const rows = parseJsonlText(fs.readFileSync(filePath, "utf8"));
  if (descriptor.family === "codex") {
    return loadCodexSessionRows(filePath, rows, { sourceOverride: descriptor.source });
  }
  return loadClaudeCliSessionRows(filePath, rows, { source: descriptor.source });
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => import("node:sqlite").DatabaseSync;
};

/** Creates the minimal ZCode database layout the migration writer requires. */
function createZcodeHomeFixture(homeDir: string): string {
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, path TEXT,
        title TEXT, version TEXT, permission TEXT, trace_id TEXT, task_type TEXT DEFAULT 'interactive', title_source TEXT DEFAULT 'first_input',
        title_message_id TEXT, time_title_updated INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
  return dbPath;
}

const noOpInspect = async () => undefined;

const allMigrationTargetsEnabled = {
  ...defaultSettings,
  includeTclaude: true,
  includeTcodex: true,
  includeDeepSeekCli: true,
};

const targetSources: Record<MigrationTarget, SessionSource> = {
  claude: "claude-cli",
  codex: "codex-cli",
  codebuddy: "codebuddy-cli",
  codewiz: "codewiz-cli",
  cursor: "cursor-agent",
  tclaude: "tclaude-cli",
  tcodex: "tcodex-cli",
  deepseek: "deepseek-cli",
  zcode: "zcode-cli",
};

describe("migrateSessionForMcp — happy path", () => {
  it.each(Object.keys(targetSources) as MigrationTarget[])(
    "migrates a local session to %s, writes a loadable file, indexes it, and returns launched=false",
    async (target) => {
      const store = createInMemoryStore();
      const { sessionKey, projectPath } = await seedLocalSession(store);
      const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
      try {
        if (target === "zcode") createZcodeHomeFixture(homeDir);
        const result = await migrateSessionForMcp(
          { sessionKey, target },
          { store, settings: allMigrationTargetsEnabled, inspectCli: noOpInspect, homeDir },
        );

        // launched must always be false: the MCP server never opens a terminal.
        expect(result.launched).toBe(false);
        expect(result.target).toBe(target);
        expect(result.targetSessionId).toMatch(/^(sess_)?[0-9a-f-]{36}$/i);
        expect(result.strategy).toBe("complete");
        expect(result.resumeCommand).toContain(result.targetSessionId);
        if (target === "zcode") {
          // ZCode has no resume CLI; the hint points at the app's session list.
          expect(result.resumeCommand).toContain("ZCode");
        } else {
          expect(result.resumeCommand).toContain(projectPath);
        }
        if (target === "deepseek") {
          expect(result.resumeCommand).toContain("dsh");
          expect(result.resumeCommand).toContain("--profile");
          expect(result.resumeCommand).toContain("tui");
        }
        expect(result.indexed).toBe(true);
        expect(fs.existsSync(result.targetFilePath)).toBe(true);

        // The target file must be readable by the existing loaders.
        const loaded = loadMigratedSessionFileForTest(target, result.targetFilePath, result.targetSessionId);
        expect(loaded?.messages.length).toBeGreaterThan(0);

        // The migrated session is immediately searchable in the DB.
        const indexedSessionKey = (loaded && "session" in loaded && loaded.session)
          ? (loaded as { session: { sessionKey: string } }).session.sessionKey
          : `${target}:${result.targetSessionId}`;
        const found = await store.getSession(indexedSessionKey);
        expect(found).not.toBeNull();
        expect(found?.source).toBe(targetSources[target]);
      } finally {
        await store.close();
        fs.rmSync(homeDir, { recursive: true, force: true });
        fs.rmSync(projectPath, { recursive: true, force: true });
      }
    },
  );

  it("migrates a Claude source to Codex and registers the native Codex index entry", async () => {
    const store = createInMemoryStore();
    const projectPath = makeProjectDir();
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-claude-to-codex-"));
    const { sessionKey } = await seedLocalSession(store, {
      sessionKey: "claude:source-1",
      rawId: "source-1",
      source: "claude-cli",
      projectPath,
    });
    try {
      const result = await migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect, homeDir },
      );

      expect(result.indexed).toBe(true);
      expect(fs.readFileSync(path.join(homeDir, ".codex", "session_index.jsonl"), "utf8"))
        .toContain(result.targetSessionId);
      expect((await store.listSessionMigrations(sessionKey))[0]).toMatchObject({
        sourceAgent: "claude",
        targetAgent: "codex",
      });
    } finally {
      store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects a disabled optional target before CLI inspection or file writes", async () => {
    const store = createInMemoryStore();
    const { sessionKey, projectPath } = await seedLocalSession(store);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    const inspectCli = vi.fn(noOpInspect);
    try {
      await expect(
        migrateSessionForMcp(
          { sessionKey, target: "tcodex" },
          { store, settings: defaultSettings, inspectCli, homeDir },
        ),
      ).rejects.toThrow("TCodex migration target is disabled in Settings.");
      expect(inspectCli).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(homeDir, ".tcodex"))).toBe(false);
      expect(await store.listSessionMigrations(sessionKey)).toEqual([]);
    } finally {
      await store.close();
      fs.rmSync(homeDir, { recursive: true, force: true });
      fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it("records a session_migrations row", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    try {
      const result = await migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect, homeDir, idFactory: () => "migration-id-1", now: () => 12345 },
      );
      const migrations = await store.listSessionMigrations(sessionKey);
      expect(migrations).toHaveLength(1);
      expect(migrations[0]).toMatchObject({
        id: "migration-id-1",
        sourceSessionKey: sessionKey,
        sourceAgent: "codex",
        targetAgent: "codex",
        targetSessionId: result.targetSessionId,
        targetFilePath: result.targetFilePath,
        strategy: "complete",
        createdAt: 12345,
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("migrateSessionForMcp — long-session compression", () => {
  function longMessages(): SessionMessage[] {
    const messages: SessionMessage[] = [];
    // ~300k chars => ~75k tokens, well over the 60k limit.
    const big = "x".repeat(15_000);
    for (let i = 0; i < 40; i += 1) {
      messages.push({ role: "user", content: big, timestamp: `2026-06-01T10:0${i % 10}:00Z`, index: i * 2 });
      messages.push({ role: "assistant", content: big, timestamp: `2026-06-01T10:0${i % 10}:01Z`, index: i * 2 + 1 });
    }
    return messages;
  }

  const VALID_HANDOFF = `<analysis>
按时间顺序梳理：用户要求修复刷新令牌过期的 bug。
</analysis>
<summary>
## 用户原始目标
用户在排查一个偶发的刷新令牌过期问题，怀疑是令牌缓存的过期时间设置不合理，需要定位相关代码并验证修复方案是否覆盖所有边界条件。这个问题在高峰时段会触发，导致用户被意外登出。
## 约束与用户纠正
迁移必须保留完整 Turn，不允许通过本地字符裁剪静默丢失中间历史；用户要求使用设置中明确选择的摘要模型。
## 已确定的决定
选择将本地缓存 TTL 调整为 25 分钟并增加 60 秒的提前刷新缓冲，而非彻底重写缓存层，以最小化改动范围并保持与现有调用方接口完全兼容，降低回归风险。
## 已完成工作
分析了 src/auth/refresh.ts 中的令牌刷新逻辑，确认缓存 TTL 默认值为 30 分钟，与上游身份服务的令牌有效窗口不匹配，导致令牌在临界点被复用而上游已经将其标记为失效。同时复现了过期场景并编写了单元测试覆盖刷新失败后的重试路径与降级策略。
## 相关产物
修改 src/auth/refresh.ts 调整 TTL 与缓冲；新增测试 src/auth/refresh.test.ts；运行 npm test 验证全绿。
## 当前状态
核心修复与单元测试已经完成，最近一次对话确认：
> how do I fix the bug
## 遗留问题
需要确认多实例部署下缓存一致性的影响，可能需要引入分布式锁避免并发刷新。
## 下一步
在预发环境验证令牌刷新窗口，并补充集成测试覆盖并发刷新与上游短暂不可用的场景。
</summary>`;

  it("uses ai-compressed strategy when the compressor succeeds", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store, { messages: longMessages() });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    const compress = vi.fn().mockResolvedValue(VALID_HANDOFF);
    try {
      const result = await migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect, homeDir, compressor: compress },
      );
      expect(result.strategy).toBe("ai-compressed");
      expect(compress).toHaveBeenCalledOnce();
      expect(result.launched).toBe(false);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects instead of locally truncating when compression fails", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store, { messages: longMessages() });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    const compress = vi.fn().mockRejectedValue(new Error("provider down"));
    try {
      await expect(migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect, homeDir, compressor: compress },
      )).rejects.toThrow(/summary model failed/i);
      expect(compress).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects instead of locally truncating when no compressor is available", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store, { messages: longMessages() });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    try {
      await expect(migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect, homeDir, compressor: null },
      )).rejects.toThrow(/summary model/i);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("uses the configured complete migration threshold", async () => {
    const store = createInMemoryStore();
    const belowDefaultMessages = Array.from({ length: 40 }, (_, index): SessionMessage => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(6_000),
      timestamp: `2026-06-01T10:00:${String(index % 60).padStart(2, "0")}Z`,
      index,
    }));
    const { sessionKey } = await seedLocalSession(store, { messages: belowDefaultMessages });
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    const compress = vi.fn().mockResolvedValue(VALID_HANDOFF);
    try {
      const result = await migrateSessionForMcp(
        { sessionKey, target: "codex" },
        {
          store,
          settings: { ...defaultSettings, migrationCompleteTokenLimit: 50_000 },
          inspectCli: noOpInspect,
          homeDir,
          compressor: compress,
        },
      );

      expect(result.strategy).toBe("ai-compressed");
      expect(compress).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("migrateSessionForMcp — custom provider", () => {
  it("builds the compressor from a configured custom summary endpoint", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-mig-home-"));
    try {
      // Provide a complete custom provider so resolveSummaryEndpoint returns a
      // non-null endpoint, exercising the custom-provider detection path.
      const settings = {
        ...defaultSettings,
        summarySource: "custom" as const,
        summaryApiConfig: {
          ...defaultSettings.summaryApiConfig,
          activeProvider: "custom" as const,
          customBaseUrl: "https://api.example.com/v1",
          customModel: "gpt-test",
          customApiKey: "sk-test",
          customApiFormat: "openai_chat" as const,
        },
      };
      const result = await migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings, inspectCli: noOpInspect, homeDir },
      );
      // Short session => complete strategy regardless of compressor availability.
      expect(result.strategy).toBe("complete");
      expect(result.indexed).toBe(true);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("migrateSessionForMcp — temporary session cleanup", () => {
  it("deletes a temporary codex:* session record produced during compression", async () => {
    const store = createInMemoryStore();
    // Seed a real session + a dirty temporary codex session that an ephemeral
    // codex exec run would leave behind.
    await seedLocalSession(store, { sessionKey: "codex:real" });
    await store.upsertIndexedSession(
      {
        sessionKey: "codex:temp-ephemeral",
        rawId: "temp-ephemeral",
        source: "codex-cli",
        projectPath: "/tmp",
        filePath: "/tmp/temp.jsonl",
        originalTitle: "Ephemeral",
        firstQuestion: "summarize this",
        timestamp: Date.now(),
        fileMtimeMs: 2,
        fileSize: 10,
        prUrl: null,
        prNumber: null,
      },
      [{ role: "user", content: "summarize this", timestamp: "2026-06-01T10:00:00Z", index: 0 }],
      [],
      [],
    );
    expect(await store.getSession("codex:temp-ephemeral")).not.toBeNull();

    const cleaner = createMcpTemporarySessionCleaner(store);
    cleaner("codex:temp-ephemeral");
    await vi.waitFor(async () => {
      expect(await store.getSession("codex:temp-ephemeral")).toBeNull();
    });

    // The real session is untouched.
    expect(await store.getSession("codex:real")).not.toBeNull();
  });

  it("does not throw when cleaning a non-existent session", () => {
    const store = createInMemoryStore();
    const cleaner = createMcpTemporarySessionCleaner(store);
    expect(() => cleaner("codex:never-existed")).not.toThrow();
  });
});

describe("migrateSessionForMcp — error cases", () => {
  it("rejects when the session does not exist", async () => {
    const store = createInMemoryStore();
    await expect(
      migrateSessionForMcp(
        { sessionKey: "codex:missing", target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect },
      ),
    ).rejects.toThrow("Session not found");
  });

  it("rejects a remote session", async () => {
    const store = createInMemoryStore();
    const projectPath = makeProjectDir();
    // Register an SSH environment so hydrateRow resolves the session as remote.
    await store.upsertEnvironment({
      id: "ssh-env-1",
      kind: "ssh",
      label: "Remote Build Server",
      host: "build.example.com",
      user: "ci",
      enabled: true,
    });
    // Seed a session belonging to that SSH environment.
    await store.upsertIndexedSession(
      {
        sessionKey: "codex:remote-1",
        rawId: "remote-1",
        source: "codex-cli",
        projectPath,
        filePath: "/tmp/remote.jsonl",
        originalTitle: "Remote",
        firstQuestion: "remote work",
        timestamp: Date.now(),
        fileMtimeMs: 1,
        fileSize: 10,
        prUrl: null,
        prNumber: null,
        environmentId: "ssh-env-1",
        environmentKind: "ssh",
      },
      [{ role: "user", content: "remote work", timestamp: "2026-06-01T10:00:00Z", index: 0 }],
      [],
      [],
    );
    await expect(
      migrateSessionForMcp(
        { sessionKey: "codex:remote-1", target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect },
      ),
    ).rejects.toThrow("Remote session migration is not supported");
  });

  it("rejects when the project path does not exist", async () => {
    const store = createInMemoryStore();
    await seedLocalSession(store, { projectPath: "/this/path/definitely/does/not/exist" });
    await expect(
      migrateSessionForMcp(
        { sessionKey: "codex:source-1", target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect },
      ),
    ).rejects.toThrow("does not exist");
  });

  it("rejects when the CLI version check fails", async () => {
    const store = createInMemoryStore();
    const { sessionKey } = await seedLocalSession(store);
    const failingInspect = async () => {
      throw new Error("Codex CLI binary not found: codex");
    };
    await expect(
      migrateSessionForMcp(
        { sessionKey, target: "codex" },
        { store, settings: defaultSettings, inspectCli: failingInspect },
      ),
    ).rejects.toThrow("binary not found");
  });

  it("validates the source session is local before any work", async () => {
    const store = createInMemoryStore();
    await expect(loadMcpSourceSession(store, "codex:missing")).rejects.toThrow("Session not found");
  });

  it("rejects an empty project path", async () => {
    const store = createInMemoryStore();
    await store.upsertIndexedSession(
      {
        sessionKey: "codex:no-path",
        rawId: "no-path",
        source: "codex-cli",
        projectPath: "",
        filePath: "/tmp/x.jsonl",
        originalTitle: "No Path",
        firstQuestion: "q",
        timestamp: Date.now(),
        fileMtimeMs: 1,
        fileSize: 10,
        prUrl: null,
        prNumber: null,
      },
      [{ role: "user", content: "q", timestamp: "2026-06-01T10:00:00Z", index: 0 }],
      [],
      [],
    );
    await expect(
      migrateSessionForMcp(
        { sessionKey: "codex:no-path", target: "codex" },
        { store, settings: defaultSettings, inspectCli: noOpInspect },
      ),
    ).rejects.toThrow("no project path");
  });
});
