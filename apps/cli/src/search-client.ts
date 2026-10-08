import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "@agentrecall/workspace-core";

export async function desktopSearch(kind: "session" | "resource", action: "search" | "get", args: Record<string, unknown>): Promise<unknown> {
  const config = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA || os.homedir() : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const file = process.env.AGENT_RECALL_MCP_BRIDGE || path.join(config, "agent-recall-v2", "automation-mcp-bridge.json");
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); }
  catch { throw new WorkspaceError("DESKTOP_UNAVAILABLE", "请先启动 AgentRecall V2，再执行搜索或读取。"); }
  if (!value || typeof value !== "object") throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 V2。");
  const record = value as Record<string, unknown>;
  if (record.host !== "127.0.0.1" || !Number.isInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65535
    || typeof record.token !== "string" || !/^[a-f0-9]{64}$/.test(record.token)) throw new WorkspaceError("INVALID_BRIDGE", "本地搜索连接信息无效，请重启 V2。");
  let response: Response;
  try { response = await fetch(`http://127.0.0.1:${record.port}/mcp/gateway/${kind === "session" ? "sessions" : "resources"}/${action}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${record.token}`, "content-type": "application/json" }, body: JSON.stringify(args),
  }); } catch { throw new WorkspaceError("DESKTOP_UNAVAILABLE", "本地搜索连接失败或超时，请确认 V2 正在运行。"); }
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
