import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceError } from "@agentrecall/workspace-core";

export interface SessionBackendRequestOptions {
  packagePath?: string;
  userDataPath?: string;
  homeDir?: string;
  nodePath?: string;
  start?: boolean;
  timeoutMs?: number;
}

export type SessionBackendRequester = (
  action: "search" | "get" | "status" | "stop",
  body?: Record<string, unknown>,
  options?: SessionBackendRequestOptions,
) => Promise<unknown>;

export interface DesktopSearchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  packagePath?: string;
  requestSessionBackend?: SessionBackendRequester;
  fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_USER_DATA_DIR_NAME = "agent-recall-v2";

export function resolveDesktopUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.AGENT_RECALL_USER_DATA_DIR) {
    return path.resolve(env.AGENT_RECALL_USER_DATA_DIR);
  }
  if (env.AGENT_RECALL_APP_DATA_DIR) {
    return path.resolve(env.AGENT_RECALL_APP_DATA_DIR, DEFAULT_USER_DATA_DIR_NAME);
  }
  const homeDir = path.resolve(env.AGENT_RECALL_HOME_DIR || env.HOME || env.USERPROFILE || os.homedir());
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", DEFAULT_USER_DATA_DIR_NAME);
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), DEFAULT_USER_DATA_DIR_NAME);
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, ".config"), DEFAULT_USER_DATA_DIR_NAME);
}

export function resolveDesktopBridgePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.AGENT_RECALL_MCP_BRIDGE) {
    return path.resolve(env.AGENT_RECALL_MCP_BRIDGE);
  }
  return path.join(resolveDesktopUserDataDir(env, platform), "automation-mcp-bridge.json");
}

export function resolvePackageRoot(explicitRoot?: string): string {
  if (explicitRoot) return path.resolve(explicitRoot);
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, "bin", "session-backend-client.cjs"))) {
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new WorkspaceError("BACKEND_UNAVAILABLE", "未找到本地会话后台客户端，请重新构建或重新安装 agent-recall。");
    }
    directory = parent;
  }
  return directory;
}

function loadSessionBackendRequester(packagePath?: string): {
  packageRoot: string;
  requestSessionBackend: SessionBackendRequester;
} {
  const packageRoot = resolvePackageRoot(packagePath);
  const clientPath = path.join(packageRoot, "bin", "session-backend-client.cjs");
  const mod = createRequire(import.meta.url)(clientPath) as {
    requestSessionBackend?: SessionBackendRequester;
  };
  if (typeof mod.requestSessionBackend !== "function") {
    throw new WorkspaceError("BACKEND_UNAVAILABLE", "本地会话后台客户端接口无效，请重新安装 agent-recall。");
  }
  return { packageRoot, requestSessionBackend: mod.requestSessionBackend };
}

async function backgroundSession(
  action: "search" | "get",
  args: Record<string, unknown>,
  options: DesktopSearchOptions,
): Promise<unknown> {
  const allowedFields = action === "search"
    ? new Set(["query", "scope", "source", "project", "limit"])
    : new Set(["sessionKey", "scope", "offset", "maxMessages", "turnIndex"]);
  if (Object.keys(args).some((key) => !allowedFields.has(key))) {
    throw new WorkspaceError(
      "DESKTOP_REQUIRED",
      "所选会话读取选项需要运行 AgentRecall 桌面端；无窗口模式支持基础搜索及 offset/limit/turn-index 分页读取。",
    );
  }

  const body: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (key === "scope") continue;
    if (args[key] !== undefined) body[key] = args[key];
  }

  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = path.resolve(env.AGENT_RECALL_HOME_DIR || env.HOME || env.USERPROFILE || os.homedir());
  const userDataPath = resolveDesktopUserDataDir(env, platform);
  const requester = options.requestSessionBackend;
  const resolved = requester
    ? { packageRoot: options.packagePath ? path.resolve(options.packagePath) : undefined, requestSessionBackend: requester }
    : loadSessionBackendRequester(options.packagePath);

  try {
    return await resolved.requestSessionBackend(action, body, {
      ...(resolved.packageRoot ? { packagePath: resolved.packageRoot } : {}),
      userDataPath,
      homeDir,
      nodePath: env.AGENT_RECALL_NODE_PATH || process.execPath,
    });
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/exceeds the 1 MiB limit/i.test(message)) {
      throw new WorkspaceError("RESULT_TOO_LARGE", "搜索结果过大，请缩小范围。");
    }
    if ((error instanceof Error && "code" in error && error.code === "ETIMEDOUT")
      || /timed out|did not become ready/i.test(message)) {
      throw new WorkspaceError("BACKEND_TIMEOUT", "会话搜索后台启动或请求超时，请运行 agent-recall backend status 检查后台状态后重试。");
    }
    throw new WorkspaceError("SEARCH_FAILED", message.slice(0, 2000));
  }
}

function connectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ECONNREFUSED") return true;
  return error.cause !== undefined && connectionRefused(error.cause);
}

export async function desktopSearch(
  kind: "session" | "resource",
  action: "search" | "get",
  args: Record<string, unknown>,
  options: DesktopSearchOptions = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const localSession = kind === "session"
    && args.scope !== "team"
    && !(typeof args.sessionKey === "string" && args.sessionKey.startsWith("shared:"));

  const file = resolveDesktopBridgePath(env, platform);
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (localSession) return backgroundSession(action, args, options);
      throw new WorkspaceError("DESKTOP_UNAVAILABLE", "团队或资源检索需要先启动 AgentRecall 桌面端。");
    }
    throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无法读取或格式无效，请重启 AgentRecall 桌面端。");
  }

  if (!value || typeof value !== "object") {
    throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 AgentRecall 桌面端。");
  }
  const record = value as Record<string, unknown>;
  if (
    record.host !== "127.0.0.1"
    || !Number.isInteger(record.port)
    || Number(record.port) < 1
    || Number(record.port) > 65535
    || typeof record.token !== "string"
    || !/^[a-f0-9]{64}$/.test(record.token)
  ) {
    throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 AgentRecall 桌面端。");
  }

  let response: Response;
  try {
    response = await fetchImpl(
      `http://127.0.0.1:${record.port}/mcp/gateway/${kind === "session" ? "sessions" : "resources"}/${action}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${record.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      },
    );
  } catch (error) {
    if (localSession && connectionRefused(error)) {
      return backgroundSession(action, args, options);
    }
    throw new WorkspaceError("DESKTOP_UNAVAILABLE", "本地搜索连接失败或超时，请确认 AgentRecall 桌面端正在运行。");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new WorkspaceError("INVALID_RESPONSE", "本地搜索未返回数据。");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new WorkspaceError("RESULT_TOO_LARGE", "搜索结果过大，请缩小范围。");
      }
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }

  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkspaceError("INVALID_RESPONSE", "本地搜索返回格式无效，请重启 AgentRecall 桌面端后重试。");
  }

  if (!response.ok) {
    const error = result && typeof result === "object" && "error" in result ? result.error : null;
    throw new WorkspaceError(
      "SEARCH_FAILED",
      typeof error === "string"
        ? error.slice(0, 2000)
        : `搜索或读取失败（${response.status}），请检查输入、团队开关及 MCP 工具开关。`,
    );
  }
  return result;
}
