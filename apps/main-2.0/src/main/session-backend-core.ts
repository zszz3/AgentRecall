import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { defaultSettings, mergeAppSettings, type AppSettings } from "../core/platform";
import { OPTIONAL_SESSION_SOURCE_DESCRIPTORS, sessionSourcesForOptionalSetting } from "../core/session-sources";
import type { SearchOptions } from "../core/types";
import type { IndexStatus } from "../core/indexer";
import { PostgresDatabase, redactPostgresConnectionText } from "../core/postgres/database";
import { POSTGRES_MIGRATIONS } from "../core/postgres/schema";
import { SessionStore } from "../core/session-store";
import { createIndexRunCoordinator } from "../core/index-run-coordinator";
import { LocalSessionIndexService } from "./services/local-session-index-service";
import { startPostgresRuntime, type PostgresRuntime } from "./postgres/managed-postgres";
import type { SessionIndexWorkerOptions } from "./session-index-worker-protocol";
import { SessionBackendRequestError, type SessionBackend } from "./session-backend-host";

const searchInput = z.object({
  query: z.string().trim().max(1000).default(""),
  scope: z.literal("local").optional(),
  source: z.string().max(100).optional(), project: z.string().max(32768).optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
const readInput = z.object({
  sessionKey: z.string().trim().min(1).max(4096),
  offset: z.number().int().min(0).max(200000).default(0),
  maxMessages: z.number().int().min(1).max(200).default(40),
}).strict();

async function readObject(file: string): Promise<Record<string, unknown>> {
  let contents: string;
  try { contents = await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error("搜索设置文件过大，请在桌面设置中检查配置。");
  const result: unknown = JSON.parse(contents);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("搜索设置文件无效，请在桌面设置中检查配置。");
  return result as Record<string, unknown>;
}

/** Reads the same settings files as Electron without loading Electron or writing defaults. */
export async function readSessionBackendSettings(userDataPath: string): Promise<AppSettings> {
  const raw = await readObject(path.join(userDataPath, "config.json"));
  for (const key of ["sessionSearchMcpEnabled", ...OPTIONAL_SESSION_SOURCE_DESCRIPTORS.map((item) => item.optionalSetting)]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`搜索设置 ${key} 必须为布尔值。`);
  }
  return mergeAppSettings(defaultSettings, raw);
}

async function assertToolEnabled(userDataPath: string, settings: AppSettings, tool: string): Promise<void> {
  const runtime = await readObject(path.join(userDataPath, "mcp-runtime.json"));
  if (runtime.disabledTools !== undefined && (!Array.isArray(runtime.disabledTools) || !runtime.disabledTools.every((item) => typeof item === "string"))) {
    throw new Error("会话 MCP 工具设置无效，请在桌面设置中检查配置。");
  }
  if (!settings.sessionSearchMcpEnabled || (runtime.disabledTools as string[] | undefined)?.includes(tool)) {
    throw new SessionBackendRequestError(403, `会话 MCP 工具已关闭：${tool}。请在 AgentRecall 设置中启用后重试。`);
  }
}

/** Owns only local indexing and read APIs; no models, workflow engine or remote synchronisation. */
export async function createSessionBackend(options: { userDataPath: string; homeDir: string; workerPath: string }): Promise<SessionBackend> {
  let runtime: PostgresRuntime | null = null;
  let database: PostgresDatabase | null = null;
  let indexer: LocalSessionIndexService | null = null;
  try {
    // A legacy desktop does not participate in the service lease. Do not adopt
    // its database: its Quit handler can stop PostgreSQL underneath this service.
    const desktop = await readObject(path.join(options.homeDir, ".agent-recall-v2", "app-process.json"));
    if (Number.isSafeInteger(desktop.pid) && Number(desktop.pid) > 0 && Number(desktop.pid) !== Number(process.env.AGENT_RECALL_SESSION_DESKTOP_PID)) {
      let alive = false;
      try { process.kill(Number(desktop.pid), 0); alive = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      if (alive) throw new Error("旧版桌面仍在运行，请先退出 AgentRecall，再启动独立搜索后台。");
    }
    runtime = await startPostgresRuntime({ userDataPath: options.userDataPath, adoptExisting: true });
    database = PostgresDatabase.connect(runtime.connectionUrl, { migrations: POSTGRES_MIGRATIONS });
    await database.initialize();
    const store = new SessionStore(database, Promise.resolve(), path.join(options.userDataPath, "session-attachments"));
    indexer = new LocalSessionIndexService(options.workerPath, { connectionUrl: runtime.connectionUrl, userDataPath: options.userDataPath });
    const ownedIndexer = indexer;
    const ownedDatabase = database;
    const ownedRuntime = runtime;
    const prune = async (settings: AppSettings) => {
      const disabled = OPTIONAL_SESSION_SOURCE_DESCRIPTORS.flatMap((item) => settings[item.optionalSetting] ? [] : sessionSourcesForOptionalSetting(item.optionalSetting));
      await store.deleteSessionsBySource([...new Set(disabled)]);
    };
    const coordinator = createIndexRunCoordinator<IndexStatus>({
      afterRun: async () => { if (!stopped) await prune(await readSessionBackendSettings(options.userDataPath)); },
    });
    let current: IndexStatus = { running: false, indexed: 0, skipped: 0, total: 0, lastIndexedAt: null, error: null };
    let stopped = false;
    let stopping: Promise<void> | null = null;
    const refresh = (retryFailures = false): Promise<IndexStatus> => coordinator.request(async () => {
      if (stopped) throw new Error("搜索后台正在退出，请重试。");
      const settings = await readSessionBackendSettings(options.userDataPath);
      await prune(settings);
      const loadOptions: SessionIndexWorkerOptions = { homeDir: options.homeDir };
      for (const item of OPTIONAL_SESSION_SOURCE_DESCRIPTORS) loadOptions[item.optionalSetting] = settings[item.optionalSetting];
      current = { ...current, running: true, error: null };
      try {
        current = await ownedIndexer.run(loadOptions, retryFailures, {
          onProgress: (status) => { current = { ...status, lastIndexedAt: current.lastIndexedAt }; },
          onEnvironmentsChanged: () => undefined, // The desktop reloads environment state after its refresh request.
        });
        return current;
      } catch (error) {
        current = { ...current, running: false, error: redactPostgresConnectionText(error instanceof Error ? error.message : String(error)) };
        throw new Error(current.error!);
      }
    });
    return {
      connectionUrl: runtime.connectionUrl,
      refresh,
      status: () => ({ ...current }),
      search: async (input) => {
        const parsed = searchInput.safeParse(input);
        if (!parsed.success) throw new SessionBackendRequestError(400, "搜索参数无效，请检查字段、范围和结果数量。");
        const args = parsed.data;
        await assertToolEnabled(options.userDataPath, await readSessionBackendSettings(options.userDataPath), "search_sessions");
        const status = await refresh();
        if (status.error) throw new Error(`索引未完成：${status.error}`);
        const sessions = await store.searchSessions({ query: args.query, source: args.source as SearchOptions["source"], projectPath: args.project, limit: args.limit, excludeSubagents: true });
        return sessions.map((session) => ({ sessionKey: session.sessionKey, title: session.displayTitle, source: session.source,
          project: session.projectPath, timestamp: session.timestamp, summary: (session.aiSummary ?? session.firstQuestion)?.slice(0, 600) ?? null }));
      },
      get: async (input) => {
        const parsed = readInput.safeParse(input);
        if (!parsed.success) throw new SessionBackendRequestError(400, "读取参数无效，请检查 sessionKey 和消息分页。");
        const args = parsed.data;
        const settings = await readSessionBackendSettings(options.userDataPath);
        await assertToolEnabled(options.userDataPath, settings, "get_session");
        const status = await refresh();
        if (status.error) throw new Error(`索引未完成：${status.error}`);
        const session = await store.getSession(args.sessionKey);
        if (!session) throw new SessionBackendRequestError(404, "会话不存在，请重新搜索。");
        if (OPTIONAL_SESSION_SOURCE_DESCRIPTORS.some((item) => item.id === session.source && !settings[item.optionalSetting])) {
          throw new SessionBackendRequestError(403, "该会话来源已在设置中关闭。");
        }
        const messages = await store.getMessages(args.sessionKey, args.offset, args.maxMessages);
        return { sessionKey: session.sessionKey, title: session.displayTitle, source: session.source, project: session.projectPath,
          timestamp: session.timestamp, summary: session.aiSummary, totalMessages: session.messageCount,
          messages: messages.map((message) => ({ role: message.role, content: message.content })) };
      },
      close: () => {
        stopped = true;
        stopping ??= (async () => {
          try { await ownedIndexer.stop(); }
          finally { try { await ownedDatabase.close(); } finally { await ownedRuntime.stop(); } }
        })();
        return stopping;
      },
    };
  } catch (error) {
    try { await indexer?.stop(); }
    finally { try { await database?.close(); } finally { await runtime?.stop(); } }
    throw error;
  }
}
