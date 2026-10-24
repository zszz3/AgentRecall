import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, type ExecFileException } from "node:child_process";
import { WorkspaceError } from "@agentrecall/workspace-core";

async function installedV2Launcher(): Promise<string> {
  const environmentPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  for (const entry of environmentPath.split(path.delimiter).filter(Boolean)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    for (const candidate of [path.join(directory, "agent-recall-v2"), path.join(directory, "node_modules", "agent-recall-v2", "bin", "agent-recall.cjs"), path.join(directory, "..", "lib", "node_modules", "agent-recall-v2", "bin", "agent-recall.cjs")]) {
      try {
        const launcher = await fs.realpath(candidate);
        if (path.basename(launcher) !== "agent-recall.cjs") continue;
        const metadata: unknown = JSON.parse(await fs.readFile(path.join(path.dirname(launcher), "..", "package.json"), "utf8"));
        if (metadata && typeof metadata === "object" && "name" in metadata && metadata.name === "agent-recall-v2") return launcher;
      } catch (error) {
        // PATH can contain missing entries, inaccessible executables or unrelated wrappers.
        if (error instanceof SyntaxError || error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) continue;
        throw error;
      }
    }
  }
  throw new WorkspaceError("V2_UNAVAILABLE", "未找到 AgentRecall V2，请先安装或更新 agent-recall-v2，再使用无窗口会话搜索。");
}

async function backgroundSession(action: "search" | "get", args: Record<string, unknown>): Promise<unknown> {
  const fields = action === "search" ? { source: "source", project: "project", limit: "limit" } : { offset: "offset", maxMessages: "limit" };
  const valueField = action === "search" ? "query" : "sessionKey";
  if (Object.keys(args).some((key) => key !== valueField && key !== "scope" && !Object.hasOwn(fields, key))) {
    throw new WorkspaceError("DESKTOP_REQUIRED", "所选会话读取选项仍需运行 AgentRecall V2 桌面；无窗口模式支持基础搜索及 offset/limit 分页读取。");
  }
  const launcher = await installedV2Launcher();
  try { await fs.access(path.join(path.dirname(launcher), "session-backend-client.cjs")); }
  catch { throw new WorkspaceError("V2_UPDATE_REQUIRED", "已安装的 AgentRecall V2 尚不支持无窗口搜索，请更新 agent-recall-v2 后重试。"); }
  const argv = ["session", action, String(args[valueField]), "--json"];
  for (const [field, flag] of Object.entries(fields)) if (args[field] !== undefined) argv.push(`--${flag}`, String(args[field]));
  const execution = await new Promise<{ stdout: string; error: ExecFileException | null }>((resolve) => {
    execFile(process.execPath, [launcher, ...argv], { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => resolve({ stdout, error }));
  });
  if (execution.error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new WorkspaceError("RESULT_TOO_LARGE", "搜索结果过大，请缩小范围。");
  if (execution.error?.killed) throw new WorkspaceError("BACKEND_TIMEOUT", "会话搜索后台启动或请求超时，请检查 V2 后台状态后重试。");
  let result: unknown;
  try { result = JSON.parse(execution.stdout); }
  catch { throw new WorkspaceError("V2_UPDATE_REQUIRED", "已安装的 AgentRecall V2 未返回无窗口搜索协议，请更新 agent-recall-v2 后重试。"); }
  if (!result || typeof result !== "object" || !("ok" in result)) throw new WorkspaceError("INVALID_RESPONSE", "V2 会话后台返回格式无效，请更新 V2 后重试。");
  if (result.ok === false && "error" in result && result.error && typeof result.error === "object" && "message" in result.error && typeof result.error.message === "string") {
    const code = "code" in result.error && typeof result.error.code === "string" ? result.error.code : "SEARCH_FAILED";
    throw new WorkspaceError(code, result.error.message.slice(0, 2000));
  }
  if (execution.error || result.ok !== true || !("data" in result)) throw new WorkspaceError("SEARCH_FAILED", "V2 会话后台未能完成请求，请检查后台状态。");
  return result.data;
}

function connectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ECONNREFUSED") return true;
  return error.cause !== undefined && connectionRefused(error.cause);
}

export async function desktopSearch(kind: "session" | "resource", action: "search" | "get", args: Record<string, unknown>): Promise<unknown> {
  const localSession = kind === "session" && args.scope !== "team"
    && !(typeof args.sessionKey === "string" && args.sessionKey.startsWith("shared:"));
  const config = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA || os.homedir() : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const file = process.env.AGENT_RECALL_MCP_BRIDGE || path.join(config, "agent-recall-v2", "automation-mcp-bridge.json");
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      if (localSession) return backgroundSession(action, args);
      throw new WorkspaceError("DESKTOP_UNAVAILABLE", "团队或资源检索需要先启动 AgentRecall V2 桌面。");
    }
    throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无法读取或格式无效，请重启 V2。");
  }
  if (!value || typeof value !== "object") throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 V2。");
  const record = value as Record<string, unknown>;
  if (record.host !== "127.0.0.1" || !Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535
    || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token)) throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 V2。");
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${record.port}/mcp/gateway/${kind === "session" ? "sessions" : "resources"}/${action}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" }, body: JSON.stringify(args),
  }); } catch (error) {
    if (localSession && connectionRefused(error)) return backgroundSession(action, args);
    throw new WorkspaceError("DESKTOP_UNAVAILABLE", "本地搜索连接失败或超时，请确认 V2 正在运行。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkspaceError("INVALID_RESPONSE", "本地搜索未返回数据。");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
      if (bytes > 1024 * 1024) throw new WorkspaceError("RESULT_TOO_LARGE", "搜索结果过大，请缩小范围。"); chunks.push(part.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) {
    const error = result && typeof result === "object" && "error" in result ? result.error : null;
    throw new WorkspaceError("SEARCH_FAILED", typeof error === "string" ? error.slice(0, 2000) : `搜索或读取失败（${response.status}），请检查输入、团队开关及 MCP 工具开关。`);
  }
  return result;
}
