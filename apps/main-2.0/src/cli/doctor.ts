import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceService, WorkspaceStatus } from "@agentrecall/workspace-core";
import { resolveDesktopBridgePath, resolveDesktopUserDataDir } from "./search-client.js";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "ok" | "warn" | "info" | "error";

export interface DoctorCheck {
  name: "node" | "git" | "config" | "directories" | "sessionBackend" | "desktopBridge";
  status: DoctorCheckStatus;
  summary: string;
  detail?: string;
}

export interface DoctorReport extends WorkspaceStatus {
  healthy: boolean;
  checks: DoctorCheck[];
}

function compareSemver(actual: string, minimum: [number, number, number]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return false;
  const [major, minor, patch = 0] = parts;
  if (major !== minimum[0]) return major > minimum[0];
  if (minor !== minimum[1]) return minor > minimum[1];
  return patch >= minimum[2];
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

async function checkGit(): Promise<DoctorCheck> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout.trim());
    if (!match) {
      return { name: "git", status: "warn", summary: `已检测到 Git（${stdout.trim() || "版本未知"}）` };
    }
    const version = match[1];
    if (!compareSemver(version, [2, 31, 0])) {
      return { name: "git", status: "warn", summary: `Git ${version}（建议升级至 2.31+）` };
    }
    return { name: "git", status: "ok", summary: `Git ${version}` };
  } catch {
    return { name: "git", status: "error", summary: "未检测到 Git，请安装 Git 2.31+ 后重试。" };
  }
}

async function checkSessionBackend(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const discoveryPath = path.join(resolveDesktopUserDataDir(env, platform), "session-backend.json");
  let raw: string;
  try {
    raw = await fs.readFile(discoveryPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        name: "sessionBackend",
        status: "info",
        summary: "未运行（执行 session search 或 backend start 时按需启动）",
        detail: discoveryPath,
      };
    }
    return {
      name: "sessionBackend",
      status: "warn",
      summary: "无法读取会话后台状态文件",
      detail: discoveryPath,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : -1;
    const port = typeof parsed.port === "number" ? parsed.port : -1;
    const appVersion = typeof parsed.appVersion === "string" ? parsed.appVersion : "unknown";
    if (parsed.protocolVersion !== 1 || parsed.host !== "127.0.0.1" || !Number.isSafeInteger(pid) || pid <= 0 || port < 1 || port > 65535) {
      return { name: "sessionBackend", status: "warn", summary: "会话后台状态文件格式无效", detail: discoveryPath };
    }
    if (!isProcessAlive(pid)) {
      return {
        name: "sessionBackend",
        status: "warn",
        summary: `发现已退出进程的会话后台状态文件（PID ${pid}），下次检索将自动重建`,
        detail: discoveryPath,
      };
    }
    return {
      name: "sessionBackend",
      status: "ok",
      summary: `运行中（PID ${pid}, 127.0.0.1:${port}, v${appVersion}）`,
      detail: discoveryPath,
    };
  } catch {
    return { name: "sessionBackend", status: "warn", summary: "会话后台状态文件 JSON 损坏", detail: discoveryPath };
  }
}

async function checkDesktopBridge(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<DoctorCheck> {
  const bridgePath = resolveDesktopBridgePath(env, platform);
  let raw: string;
  try {
    raw = await fs.readFile(bridgePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        name: "desktopBridge",
        status: "info",
        summary: "桌面端未运行（本机会话支持无窗口检索；团队与资源检索需启动桌面端）",
        detail: bridgePath,
      };
    }
    return { name: "desktopBridge", status: "warn", summary: "无法读取桌面端桥接文件", detail: bridgePath };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const valid = parsed.host === "127.0.0.1"
      && Number.isInteger(parsed.port)
      && Number(parsed.port) >= 1
      && Number(parsed.port) <= 65535
      && typeof parsed.token === "string"
      && /^[a-f0-9]{64}$/.test(parsed.token);
    if (!valid) {
      return { name: "desktopBridge", status: "warn", summary: "桌面端桥接文件无效，请重启 AgentRecall 桌面端", detail: bridgePath };
    }
    return {
      name: "desktopBridge",
      status: "ok",
      summary: `桥接文件就绪（127.0.0.1:${String(parsed.port)}）`,
      detail: bridgePath,
    };
  } catch {
    return { name: "desktopBridge", status: "warn", summary: "桌面端桥接文件损坏，请重启 AgentRecall 桌面端", detail: bridgePath };
  }
}

async function checkDirectories(service: WorkspaceService): Promise<DoctorCheck> {
  const config = await service.store.read();
  if (!config) {
    return { name: "directories", status: "info", summary: "未配置团队工作目录" };
  }
  const connections = service.directoryConnections(config);
  const enabled = connections.filter((entry) => entry.enabled);
  if (enabled.length === 0) {
    return {
      name: "directories",
      status: "info",
      summary: connections.length === 0 ? "尚无接入的工作目录" : `${connections.length} 个工作目录已停用`,
    };
  }
  const missing: string[] = [];
  for (const entry of enabled) {
    try {
      const stat = await fs.stat(entry.path);
      if (!stat.isDirectory()) missing.push(entry.path);
    } catch {
      missing.push(entry.path);
    }
  }
  if (missing.length > 0) {
    return {
      name: "directories",
      status: "warn",
      summary: `${enabled.length} 个启用目录中有 ${missing.length} 个不可访问`,
      detail: missing.join(", "),
    };
  }
  return { name: "directories", status: "ok", summary: `${enabled.length} 个已启用工作目录全部可访问` };
}

export async function runDoctor(
  service: WorkspaceService,
  directory: string,
  projectId?: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const status = await service.status(directory, projectId);
  const nodeOk = compareSemver(process.versions.node, [22, 13, 0]);
  const nodeCheck: DoctorCheck = {
    name: "node",
    status: nodeOk ? "ok" : "warn",
    summary: nodeOk ? `Node.js v${process.versions.node}` : `Node.js v${process.versions.node}（需要 22.13+）`,
  };
  const configCheck: DoctorCheck = !status.initialized
    ? {
      name: "config",
      status: "info",
      summary: "尚未初始化团队配置（如需团队空间，请运行 agent-recall init）",
      detail: status.configPath,
    }
    : {
      name: "config",
      status: "ok",
      summary: status.teamEnabled
        ? `团队功能已开启${status.team ? `（团队：${status.team.name}）` : ""}`
        : "团队功能已关闭（个人模式）",
      detail: status.configPath,
    };

  const [gitCheck, directoriesCheck, sessionBackendCheck, desktopBridgeCheck] = await Promise.all([
    checkGit(),
    checkDirectories(service),
    checkSessionBackend(env, platform),
    checkDesktopBridge(env, platform),
  ]);
  const checks = [nodeCheck, gitCheck, configCheck, directoriesCheck, sessionBackendCheck, desktopBridgeCheck];
  return {
    ...status,
    healthy: checks.every((check) => check.status !== "error"),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const badges: Record<DoctorCheckStatus, string> = {
    ok: "[OK]  ",
    warn: "[WARN]",
    info: "[INFO]",
    error: "[ERR] ",
  };
  const labels: Record<DoctorCheck["name"], string> = {
    node: "Node.js",
    git: "Git",
    config: "配置",
    directories: "工作目录",
    sessionBackend: "会话后台",
    desktopBridge: "桌面桥接",
  };
  const lines = [
    "AgentRecall 环境与配置诊断",
    ...report.checks.map((check) => `${badges[check.status]} ${labels[check.name]}：${check.summary}`),
    `配置文件：${report.configPath}`,
    `当前项目：${report.project?.name ?? "未选择"}`,
    `生效团队：${report.team?.name ?? "无"}`,
  ];
  return lines.join("\n");
}
