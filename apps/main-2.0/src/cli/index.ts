import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import {
  TeamAssetService,
  WorkspaceError,
  WorkspaceService,
  type TrustItem,
  type WorkspaceStatus,
} from "@agentrecall/workspace-core";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { desktopSearch, type SessionBackendRequester } from "./search-client.js";

export interface RunCliOptions {
  version?: string;
  packagePath?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  requestSessionBackend?: SessionBackendRequester;
}

export const UNIFIED_HELP = `
AgentRecall — 统一桌面启动、无窗口检索与团队工作区 CLI
命令别名：agent-recall 与 agentrecall 等价；所有业务子命令均支持 --json。

桌面应用与更新：
  agent-recall                             启动 AgentRecall 桌面端
  agent-recall --check-update              检查最新版本
  agent-recall --update                    下载并更新到最新版本
  agent-recall install-app                 生成 macOS AgentRecall.app 启动器
  agent-recall uninstall                   卸载 AgentRecall 桌面端
  agent-recall --version | -v              显示当前版本号
  agent-recall --help | -h                 显示此帮助信息

会话与资源检索：
  agent-recall session search <查询> [--scope local|team] [--team <id>] [--source <来源>] [--project <目录>] [--limit <数量>]
  agent-recall session get <sessionKey> [--turn-index <轮次>] [--offset <起点>] [--limit <数量>] [--record <序号>] [--turn <id>]
  agent-recall resource search <查询> [--scope local|team] [--team <id>] [--type skill|document|instruction]
  agent-recall resource get <id> --type <类型> [--scope local|team] [--team <id>]
  agent-recall backend start|status|stop   管理无窗口本机会话搜索后台
  本机会话检索支持无窗口自动拉起后台；团队与资源检索使用运行中的 AgentRecall 桌面端，不自动 Pull。

环境诊断与团队工作区：
  agent-recall doctor [--project <id>]     检查 Node/Git、配置、工作目录、会话后台与桌面桥接状态
  agent-recall status [--project <id>]     查看当前目录的项目与团队配置状态
  agent-recall init                        初始化个人配置（团队默认关闭）
  agent-recall init <repo-url> [--name <名称>] [--transport https|ssh]
                                           初始化空团队仓库或接入已有资产仓库
  agent-recall team add <id> --repo <url> [--name <名称>] [--transport https|ssh]
  agent-recall team list                   列出已登记的团队
  agent-recall team use <id> | --personal  设置或清除默认团队（不会启用团队功能）
  agent-recall team enable|disable         开启或关闭团队功能
  agent-recall team transport <id> --transport https|ssh
  agent-recall team current [--project <id>]
  agent-recall team sync [--team <id>] [--transport https|ssh] [--trust all|none]
                                           拉取并同步团队资产到已启用工作目录
  agent-recall team trust-reset            清除本机对当前团队 Skill 与 MCP 的信任记录
  agent-recall directory add <目录> --team <id> [--target codex|claude|codex,claude|all]
  agent-recall directory list [--team <id>]
  agent-recall directory enable|disable|remove <连接ID>

高级团队资产与兼容命令：
  agent-recall skill list|preview|install|diff|update|backups|rollback|uninstall
  agent-recall work-config list|preview|install|installed|status|diff|update|uninstall
  agent-recall project create|add|list|remove|bind

常用选项与环境变量：
  --json                                   输出结构化 JSON（{ ok, data } / { ok, error }）
  --cwd <目录>                             指定当前操作目录
  AGENTRECALL_HOME                         指定团队配置目录，默认 ~/.agentrecall-cli
  团队资产精细操作可用 --team <id> --connection <连接ID>；旧协作项目可用 --project <id> --destination <目录>。
  team sync 遇到含脚本 Skill 或 MCP 的新内容时会列出并停止，确认后加 --trust all 或 --trust none 重试。
`;

const options = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  cwd: { type: "string" },
  project: { type: "string" },
  repo: { type: "string" },
  name: { type: "string" },
  scope: { type: "string" },
  type: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  page: { type: "string" },
  record: { type: "string" },
  turn: { type: "string" },
  "turn-index": { type: "string" },
  "max-chars": { type: "string" },
  "include-tools": { type: "boolean" },
  source: { type: "string" },
  connection: { type: "string" },
  destination: { type: "string" },
  path: { type: "string" },
  remote: { type: "string" },
  team: { type: "string" },
  personal: { type: "boolean" },
  inherit: { type: "boolean" },
  target: { type: "string" },
  revision: { type: "string" },
  transport: { type: "string" },
  file: { type: "string" },
  "from-revision": { type: "string" },
  backup: { type: "string" },
  trust: { type: "string" },
} as const;

function readFallbackVersion(packagePath?: string): string {
  const candidates = [
    ...(packagePath ? [path.join(packagePath, "package.json")] : []),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // Keep probing the next package manifest location.
    }
  }
  return "0.0.0";
}

function invalidArguments(message: string): never {
  throw new WorkspaceError("INVALID_ARGUMENTS", `${message} 使用 agent-recall --help 查看用法。`);
}

function describeStatus(status: WorkspaceStatus): string {
  const reasons: Record<WorkspaceStatus["reason"], string> = {
    not_initialized: "尚未初始化，请运行 agent-recall init。",
    team_disabled: "团队功能已关闭，使用个人模式。",
    no_project: "当前目录未绑定项目。",
    no_team: "当前项目未选择团队。",
    ready: "团队功能已开启，资产状态可用 skill list 查看。",
  };
  return [
    reasons[status.reason],
    `配置：${status.configPath}`,
    `项目：${status.project?.name ?? "未选择"}`,
    `配置的团队：${status.team?.name ?? "无"}`,
  ].join("\n");
}

function parseDirectoryTargets(rawTarget: string | undefined): Array<"codex" | "claude"> {
  if (rawTarget === undefined) return ["codex", "claude"];
  if (rawTarget === "all") return ["codex", "claude"];
  const parts = rawTarget.split(",").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) invalidArguments("--target 只能为 codex、claude、codex,claude 或 all。");
  const resolved: Array<"codex" | "claude"> = [];
  for (const part of parts) {
    if (part !== "codex" && part !== "claude") {
      invalidArguments("--target 只能为 codex、claude、codex,claude 或 all。");
    }
    if (!resolved.includes(part)) resolved.push(part);
  }
  return resolved;
}

async function executeCli(argv: string[], runOptions: RunCliOptions): Promise<number> {
  const writeOut = runOptions.stdout ?? ((text: string) => { process.stdout.write(text); });
  const writeErr = runOptions.stderr ?? ((text: string) => { process.stderr.write(text); });
  const parsed = (() => {
    try {
      return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    } catch {
      return invalidArguments("参数无效。");
    }
  })();
  const { values, positionals } = parsed;
  const output = (data: unknown, message: string) => {
    writeOut(`${values.json ? JSON.stringify({ ok: true, data }) : stripVTControlCharacters(message)}\n`);
  };
  if (
    values.help
    || positionals[0] === "help"
    || (positionals.length === 0 && Object.keys(values).every((flag) => flag === "json"))
  ) {
    output({ help: UNIFIED_HELP }, UNIFIED_HELP.trimEnd());
    return 0;
  }
  if (values.version) {
    const version = runOptions.version ?? readFallbackVersion(runOptions.packagePath);
    output({ version }, version);
    return 0;
  }

  const [command, action, id] = positionals;
  const key = command === "session" || command === "resource" || command === "directory"
    || command === "team" || command === "project" || command === "skill" || command === "work-config"
    ? `${command} ${action ?? ""}`
    : command!;

  const commands: Record<string, { count: number; flags: string[] }> = {
    "session search": { count: 3, flags: ["scope", "team", "limit", "page", "source", "project", "include-tools"] },
    "session get": { count: 3, flags: ["offset", "record", "turn", "turn-index", "limit"] },
    "resource search": { count: 3, flags: ["scope", "team", "type", "limit", "offset"] },
    "resource get": { count: 3, flags: ["scope", "team", "type", "offset", "max-chars"] },
    init: { count: action ? 2 : 1, flags: action ? ["name", "transport"] : [] },
    status: { count: 1, flags: ["project"] },
    doctor: { count: 1, flags: ["project"] },
    "team add": { count: 3, flags: ["repo", "name", "transport"] },
    "team transport": { count: 3, flags: ["transport"] },
    "team list": { count: 2, flags: [] },
    "team use": { count: values.personal ? 2 : 3, flags: ["personal"] },
    "team enable": { count: 2, flags: [] },
    "team disable": { count: 2, flags: [] },
    "team current": { count: 2, flags: ["project"] },
    "team sync": { count: 2, flags: ["project", "transport", "team", "trust"] },
    "team trust-reset": { count: 2, flags: ["project"] },
    "skill list": { count: 2, flags: ["project"] },
    "skill preview": { count: 3, flags: ["project", "target", "file"] },
    "skill install": { count: 3, flags: ["project", "target", "revision"] },
    "skill diff": { count: 3, flags: ["project", "target", "file"] },
    "skill update": { count: 3, flags: ["project", "target", "revision", "from-revision"] },
    "skill backups": { count: 3, flags: ["project"] },
    "skill rollback": { count: 3, flags: ["project", "target", "backup", "from-revision"] },
    "skill uninstall": { count: 3, flags: ["project", "target"] },
    "work-config list": { count: 2, flags: ["project"] },
    "work-config preview": { count: 3, flags: ["project", "target"] },
    "work-config install": { count: 3, flags: ["project", "target", "revision"] },
    "work-config installed": { count: 2, flags: ["project"] },
    "work-config status": { count: 3, flags: ["project", "target"] },
    "work-config diff": { count: 3, flags: ["project", "target"] },
    "work-config update": { count: 3, flags: ["project", "target", "from-revision", "revision"] },
    "work-config uninstall": { count: 3, flags: ["project", "target", "revision"] },
    "directory add": { count: 3, flags: ["team", "target"] },
    "directory list": { count: 2, flags: ["team"] },
    "directory enable": { count: 3, flags: [] },
    "directory disable": { count: 3, flags: [] },
    "directory remove": { count: 3, flags: [] },
    "project create": { count: 3, flags: ["team"] },
    "project add": { count: 3, flags: ["path", "remote", "name", "team", "personal"] },
    "project list": { count: 2, flags: [] },
    "project remove": { count: 3, flags: [] },
    "project bind": { count: 3, flags: ["team", "personal", "inherit"] },
  };
  if (key.startsWith("skill ") || key.startsWith("work-config ")) {
    commands[key]?.flags.push("destination", "team", "connection");
  }
  const spec = commands[key];
  if (!spec || positionals.length !== spec.count) invalidArguments("命令或参数数量不正确。");
  if (Object.keys(values).some((flag) => !["json", "cwd", ...spec.flags].includes(flag))) {
    invalidArguments("此命令不支持所选选项。");
  }
  if (Object.values(values).some((value) => typeof value === "string" && !value.trim())) {
    invalidArguments("选项值不能为空。");
  }
  const teamFlags = Number(values.team !== undefined) + Number(Boolean(values.personal)) + Number(Boolean(values.inherit));
  if (teamFlags > 1 || (key === "project bind" && teamFlags !== 1)) {
    invalidArguments("请只选择 --team、--personal 或 --inherit 中的一项。");
  }
  if (key === "team add" && !values.repo) invalidArguments("缺少 --repo。");
  if (
    [
      "skill install", "skill uninstall", "skill diff", "skill update", "skill rollback",
      "work-config install", "work-config status", "work-config uninstall", "work-config diff", "work-config update",
    ].includes(key)
    && !values.target
  ) {
    invalidArguments("缺少 --target。");
  }
  if (key !== "directory add" && values.target !== undefined && values.target !== "codex" && values.target !== "claude") {
    invalidArguments("--target 只能为 codex 或 claude。");
  }
  if (
    ["skill install", "skill update", "work-config install", "work-config uninstall", "work-config update"].includes(key)
    && !/^[a-f0-9]{40}$/.test(values.revision ?? "")
  ) {
    invalidArguments("请先预览资产或查看安装状态，再通过 --revision 提供完整版本。");
  }
  if (
    (key === "skill update" || key === "skill rollback" || key === "work-config update")
    && !/^[a-f0-9]{40}$/.test(values["from-revision"] ?? "")
    && !(key === "skill rollback" && values["from-revision"] === "none")
  ) {
    invalidArguments("请通过 --from-revision 提供当前完整版本；恢复到空位置时可使用 none。");
  }
  if (key === "skill rollback" && !values.backup) invalidArguments("缺少 --backup。");
  if (values.trust !== undefined && values.trust !== "all" && values.trust !== "none") {
    invalidArguments("--trust 只能为 all 或 none。");
  }
  if (values.transport !== undefined && values.transport !== "https" && values.transport !== "ssh") {
    invalidArguments("--transport 只能为 https 或 ssh。");
  }
  if (process.env.AGENTRECALL_HOME !== undefined && !process.env.AGENTRECALL_HOME.trim()) {
    invalidArguments("AGENTRECALL_HOME 不能为空。");
  }

  if (command === "session" || command === "resource") {
    if (values.scope && values.scope !== "local" && values.scope !== "team") {
      invalidArguments("--scope 只能为 local 或 team。");
    }
    if (values.type && !["skill", "document", "instruction"].includes(values.type)) {
      invalidArguments("--type 无效。");
    }
    if (command === "resource" && action === "get" && !values.type) {
      invalidArguments("读取资源需要 --type。");
    }
    if ((values.scope === "team" && !values.team) || (values.team && values.scope !== "team")) {
      invalidArguments("团队搜索需要同时指定 --scope team 和 --team。");
    }
    const args: Record<string, unknown> = action === "search"
      ? { query: id }
      : { [command === "session" ? "sessionKey" : "id"]: id };
    for (const [flag, field] of [
      ["scope", "scope"], ["team", "teamId"], ["type", "type"],
      ["source", "source"], ["project", "project"], ["turn", "turnId"], ["include-tools", "includeTools"],
    ] as const) {
      if (values[flag] !== undefined) args[field] = values[flag];
    }
    for (const [flag, field, max, min] of [
      ["limit", command === "session" && action === "get" ? "maxMessages" : "limit", command === "session" && action === "get" ? 200 : 50, 1],
      ["offset", "offset", command === "resource" && action === "get" ? 2_000_000 : 200_000, 0],
      ["page", "page", 4000, 1],
      ["record", "record", 127, 0],
      ["turn-index", "turnIndex", 200_000, 0],
      ["max-chars", "maxChars", 32_000, 1],
    ] as const) {
      const value = values[flag];
      if (value === undefined) continue;
      if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        invalidArguments(`--${flag} 应为 ${min}–${max} 的整数。`);
      }
      args[field] = Number(value);
    }
    const result = await desktopSearch(command, action as "search" | "get", args, {
      packagePath: runOptions.packagePath,
      requestSessionBackend: runOptions.requestSessionBackend,
    });
    const message = JSON.stringify(result, null, 2);
    if (Buffer.byteLength(values.json ? JSON.stringify({ ok: true, data: result }) : stripVTControlCharacters(message)) + 1 > 1024 * 1024) {
      throw new WorkspaceError("RESULT_TOO_LARGE", "完整输出超过 1 MiB，请缩小读取范围。");
    }
    output(result, message);
    return 0;
  }

  const directory = path.resolve(values.cwd ?? process.cwd());
  const service = new WorkspaceService(process.env.AGENTRECALL_HOME ?? path.join(os.homedir(), ".agentrecall-cli"));
  let assets = new TeamAssetService(service);
  if (values.team && (key === "team sync" || key.startsWith("skill ") || key.startsWith("work-config "))) {
    if (values.project || values.destination) {
      invalidArguments("团队操作使用 --connection 选择接入目录，不与旧项目选项混用。");
    }
    const config = await service.store.read();
    const connection = values.connection && config
      ? service.directoryConnections(config).find((entry) => entry.id === values.connection && entry.teamId === values.team)
      : undefined;
    if (values.connection && !connection) invalidArguments("找不到此团队接入的工作目录。");
    const context = await service.teamContext(values.team, connection?.id, connection?.path, false);
    assets = new TeamAssetService(service, undefined, {
      teamId: context.team.id,
      repository: context.team.repository,
      ...(connection ? { connectionId: connection.id, directory: connection.path } : {}),
    });
  } else if (values.connection) {
    invalidArguments("--connection 需要同时指定 --team。");
  }
  if (values.destination) {
    if (!values.project) invalidArguments("选择安装位置时请同时指定 --project。");
    const status = await service.status(directory, values.project);
    if (!status.project || status.project.root !== null) {
      invalidArguments("--destination 用于没有固定本地目录的协作项目。");
    }
    assets = new TeamAssetService(service, undefined, {
      projectId: status.project.id,
      root: null,
      directory: path.resolve(directory, values.destination),
      ...(status.team ? { repository: status.team.repository } : {}),
    });
  }

  switch (key) {
    case "init": {
      if (action) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const result = await assets.initialize(
            action,
            values.name,
            values.transport as "https" | "ssh" | undefined,
            controller.signal,
          );
          output(
            result,
            `${result.created ? "已初始化空团队仓库并推送基础模板。" : "已有团队仓库已校验，远端内容未修改。"}\n团队：${result.team.name}（${result.team.id}）\n仓库：${result.team.repository}\n版本：${result.commit}\n团队功能${result.teamEnabled ? "已开启" : "保持关闭"}；未安装 Skill 或 Hook，未上传 Session。\n下一步：在 AgentRecall 团队空间接入工作目录，或运行 agent-recall directory add <目录> --team ${result.team.id}；开启团队后用 agent-recall team sync 手动同步。`,
          );
        } finally {
          process.removeListener("SIGINT", cancel);
          process.removeListener("SIGTERM", cancel);
        }
        return 0;
      }
      const config = await service.store.initialize();
      output({ configPath: service.store.filePath, config }, "配置已就绪。重复初始化会保留已有配置；新配置的团队功能默认关闭。");
      return 0;
    }
    case "status": {
      const status = await service.status(directory, values.project);
      output(status, describeStatus(status));
      return 0;
    }
    case "doctor": {
      const report = await runDoctor(service, directory, values.project);
      output(report, formatDoctorReport(report));
      return report.healthy ? 0 : 1;
    }
    case "team add": {
      const team = await service.addTeam({
        id: id!,
        name: values.name,
        repository: values.repo!,
        transport: values.transport as "https" | "ssh" | undefined,
      });
      output(team, `已登记团队 ${team.name}。此操作不会启用团队功能或连接远端。`);
      return 0;
    }
    case "team transport": {
      if (!values.transport) invalidArguments("缺少 --transport。");
      await service.setTeamTransport(id!, values.transport as "https" | "ssh");
      output({ id, transport: values.transport }, "团队连接方式已保存。");
      return 0;
    }
    case "team use": {
      const config = await service.setDefaultTeam(values.personal ? null : id!);
      output({ defaultTeamId: config.defaultTeamId }, `默认团队：${config.defaultTeamId ?? "个人"}。`);
      return 0;
    }
    case "team enable":
    case "team disable": {
      const config = await service.setTeamEnabled(key === "team enable");
      output(
        { teamEnabled: config.teamEnabled },
        config.teamEnabled
          ? "团队功能已开启，用 team sync 主动拉取资产。"
          : "团队功能已关闭。已安装的本地 Skill 仍保留，需要移除时使用 skill uninstall。",
      );
      return 0;
    }
    case "team current": {
      const context = await service.currentTeam(directory, values.project);
      output(context, `项目：${context.project.name}\n团队：${context.team.name}\n资产仓库：${context.team.repository}`);
      return 0;
    }
    case "team sync": {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const transport = values.transport as "https" | "ssh" | undefined;
        const result = await assets.pull(directory, values.project, transport, controller.signal).catch(async (error: unknown) => {
          if (!(error instanceof WorkspaceError) || error.code !== "TRUST_REQUIRED") throw error;
          const items = (error.details?.items ?? []) as TrustItem[];
          const listing = items
            .map((item) => `- ${item.kind === "mcp" ? "MCP" : "Skill"} ${item.name}：${item.reasons.join("、")}\n  ${item.details.join("\n  ")}`)
            .join("\n");
          if (!values.trust) {
            throw new WorkspaceError(
              error.code,
              `${error.message}\n${listing}\n确认后用 --trust all 信任以上全部，或 --trust none 跳过以上全部。`,
              error.details,
            );
          }
          // The decision covers what this run fetched, which may differ from an earlier listing, so it is printed again.
          writeErr(`${values.trust === "all" ? "按 --trust all 信任" : "按 --trust none 跳过"}（版本 ${String(error.details?.commit ?? "")}）：\n${listing}\n`);
          const keys = items.map((item) => item.key);
          return assets.pull(
            directory,
            values.project,
            transport,
            controller.signal,
            values.trust === "all" ? { trusted: keys, skipped: [] } : { trusted: [], skipped: keys },
          );
        });
        const issues = result.directories.flatMap((entry) =>
          entry.items
            .filter((item) => item.status === "failed" || item.status === "conflict")
            .map((item) => `${entry.path} · ${item.id}: ${item.message}`),
        );
        const skipped = [
          ...new Set(
            result.directories.flatMap((entry) =>
              entry.items
                .filter((item) => item.status === "skipped")
                .map((item) => `${item.kind === "mcp" ? "MCP" : "Skill"} ${item.id}`),
            ),
          ),
        ];
        output(
          result,
          `${result.status === "complete" ? "团队资产已同步到启用的工作目录。" : result.status === "no-directories" ? "团队资源已拉取，尚无启用的工作目录。" : "同步未全部完成，请处理以下问题后重试。"}\n版本：${result.commit}\n${skipped.length ? `未信任而跳过：${skipped.join("、")}\n` : ""}${issues.join("\n")}`,
        );
        return result.status === "partial" || result.status === "cancelled" ? 1 : 0;
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
      }
    }
    case "team trust-reset": {
      const context = await service.currentTeam(directory, values.project);
      await assets.resetTrust(context.team.id);
      output(
        { teamId: context.team.id },
        `已清除团队“${context.team.name}”在本机的信任记录，下次 team sync 会重新询问含脚本的 Skill 和 MCP。`,
      );
      return 0;
    }
    case "skill list": {
      const result = await assets.list(directory, values.project);
      output(result, `团队：${result.teamId}\n版本：${result.commit}\n${result.skills.map((skill) => `${skill.id}\t${skill.description}`).join("\n") || "暂无 Skill。"}`);
      return 0;
    }
    case "skill preview": {
      const result = await assets.preview(directory, id!, values.project, values.target as "codex" | "claude" | undefined, values.file);
      output(result, `版本：${result.commit}\n${result.destination ? `安装位置：${result.destination}\n` : ""}文件：${result.files.map((file) => file.path).join(", ")}\n\n${result.file} (${result.encoding}):\n${result.content}`);
      return 0;
    }
    case "skill install":
    case "skill update": {
      const result = await assets.install(directory, id!, values.target as "codex" | "claude", values.revision!, values.project, values["from-revision"]);
      output(result, `${result.status === "existing" ? "相同内容已经安装" : result.status === "updated" ? "已更新" : "已安装"}：${result.path}\n版本：${result.commit}${result.backupPath ? `\n旧版本备份：${result.backupPath}` : ""}`);
      return 0;
    }
    case "skill diff": {
      const result = await assets.diff(directory, id!, values.target as "codex" | "claude", values.project, values.file);
      const labels: Record<string, string> = { added: "新增", removed: "删除", modified: "修改" };
      const detail = result.file
        ? `\n\n${result.file}\n当前版本 (${result.before?.encoding ?? "不存在"}):\n${result.before?.content ?? ""}\n新版本 (${result.after?.encoding ?? "不存在"}):\n${result.after?.content ?? ""}`
        : "";
      const changes = result.changes
        .map((item) => `${labels[item.status]}\t${item.path}${item.beforeExecutable !== item.afterExecutable ? `（执行权限：${item.beforeExecutable === null ? "无文件" : item.beforeExecutable ? "开" : "关"} → ${item.afterExecutable === null ? "无文件" : item.afterExecutable ? "开" : "关"}）` : ""}`)
        .join("\n");
      output(result, `当前版本：${result.fromRevision}\n新版本：${result.revision}\n${changes || "文件内容和执行权限无变化。"}${detail}`);
      return 0;
    }
    case "skill backups": {
      const result = await assets.backups(directory, id!, values.project);
      const current = result.installations
        .map((item) => `${item.target} 当前版本：${item.status === "installed" ? item.revision : item.status === "absent" ? "未安装（none）" : "有冲突，请检查本地修改"}`)
        .join("\n");
      output(result, `${current}\n${result.backups.map((item) => `${item.backup}\t${item.valid ? item.revision : "备份有修改或格式损坏，不能自动恢复"}`).join("\n") || "暂无备份。"}`);
      return 0;
    }
    case "skill rollback": {
      const result = await assets.rollback(
        directory,
        id!,
        values.target as "codex" | "claude",
        values.backup!,
        values["from-revision"] === "none" ? null : values["from-revision"]!,
        values.project,
      );
      output(result, `已恢复：${result.path}\n版本：${result.commit}${result.backupPath ? `\n替换前备份：${result.backupPath}` : ""}`);
      return 0;
    }
    case "skill uninstall": {
      const result = await assets.uninstall(directory, id!, values.target as "codex" | "claude", values.project);
      output(result, `已卸载，保留的备份：${result.backupPath}`);
      return 0;
    }
    case "work-config list": {
      const result = await assets.listWorkConfigs(directory, values.project);
      output(result, `团队：${result.teamId}\n版本：${result.commit}\n${result.workConfigs.map((item) => `${item.id}\t${item.name}\t${item.description}\n包含：${item.skills.join(", ")}`).join("\n") || "暂无工作配置。"}`);
      return 0;
    }
    case "work-config preview": {
      const result = await assets.previewWorkConfig(directory, id!, values.project, values.target as "codex" | "claude" | undefined);
      const labels = { new: "待安装", existing: "复用已有内容", conflict: "有冲突", unselected: "未选择客户端" };
      output(result, `版本：${result.commit}\n工作配置：${result.name}\n${result.description}\n目标：${result.target ?? "未选择"}${result.configurationConflict ? `\n配置冲突：${result.configurationConflict}` : ""}\n${result.skills.map((skill) => `${skill.id}\t${labels[skill.status]}\t${skill.files} 个文件${skill.destination ? `\t${skill.destination}` : ""}${skill.reason ? `\n${skill.reason}` : ""}`).join("\n")}`);
      return 0;
    }
    case "work-config install": {
      const result = await assets.installWorkConfig(directory, id!, values.target as "codex" | "claude", values.revision!, values.project);
      output(result, `已记录工作配置 ${result.name}（${result.skills.length} 个 Skill）到 ${result.path}\n清单版本：${result.commit}\n${result.skills.map((skill) => `${skill.id}\t${skill.status === "existing" ? "复用已有内容" : "已安装"}\t${skill.commit}`).join("\n")}\n可用 work-config status 查看共享引用和卸载影响。`);
      return 0;
    }
    case "work-config installed": {
      const result = await assets.installedWorkConfigs(directory, values.project);
      output(result, result.map((config) => `${config.id}\t${config.name}\t${config.target}\t${config.revision}`).join("\n") || "此项目暂无工作配置安装记录。");
      return 0;
    }
    case "work-config status": {
      const result = await assets.workConfigStatus(directory, id!, values.target as "codex" | "claude", values.project);
      const states = { ready: "内容完整", missing: "文件缺失", conflict: "内容有变化或冲突" };
      const actions = {
        keep_shared: "保留：其他配置仍在使用",
        keep_independent: "保留：原有独立安装",
        missing: "已缺失，仅移除引用",
        backup: "卸载时移入备份",
      };
      output(result, `工作配置：${result.name}\n客户端：${result.target}\n版本：${result.revision}\n${result.skills.map((skill) => `${skill.id}\t${states[skill.state]}\t${skill.action === "backup" && skill.state === "conflict" ? "停止卸载，请先处理修改" : actions[skill.action]}${skill.otherConfigs.length ? `（${skill.otherConfigs.join("、")}）` : ""}`).join("\n")}`);
      return 0;
    }
    case "work-config uninstall": {
      const result = await assets.uninstallWorkConfig(directory, id!, values.target as "codex" | "claude", values.revision!, values.project);
      output(result, `已卸载工作配置 ${result.id}。共用和原有独立 Skill 保留；${result.backups.length} 个 Skill 已移入备份。\n${result.backups.map((item) => `${item.id}\t${item.backupPath}`).join("\n")}`);
      return 0;
    }
    case "work-config diff": {
      const result = await assets.diffWorkConfig(directory, id!, values.target as "codex" | "claude", values.project);
      const actions = {
        install: "安装",
        reuse: "复用现有内容",
        update: "备份并更新",
        backup: "移入备份",
        keep_shared: "保留其他配置使用的内容",
        keep_independent: "保留原有独立安装",
        missing: "移除缺失项的引用",
        conflict: "阻止更新",
      };
      const membership = { added: "新增引用", retained: "保留引用", removed: "移除引用" };
      output(result, `当前版本：${result.fromRevision}\n新版本：${result.revision}\n${result.canUpdate ? "检查通过，可选择更新。" : "存在冲突，尚未修改任何文件。"}\n${result.changes.map((item) => `${item.id}\t${membership[item.membership]}\t${actions[item.action]}${item.reason ? `\n${item.reason}` : ""}${item.otherConfigs.length ? `\n其他引用：${item.otherConfigs.join("、")}` : ""}`).join("\n")}\n具体文件内容可用 skill diff 或 skill preview 查看。`);
      return 0;
    }
    case "work-config update": {
      const result = await assets.updateWorkConfig(directory, id!, values.target as "codex" | "claude", values["from-revision"]!, values.revision!, values.project);
      output(result, `已更新工作配置 ${result.name}。\n版本：${result.revision}\n${result.effects.map((item) => `${item.id}\t${item.kind === "installed" ? "已安装" : item.kind === "updated" ? "已更新" : "已移入备份"}${item.backupPath ? `\t${item.backupPath}` : ""}`).join("\n") || "文件内容保持不变，配置版本与引用已保存。"}`);
      return 0;
    }
    case "directory add": {
      if (!values.team) invalidArguments("接入工作目录需要 --team。");
      const targets = parseDirectoryTargets(values.target);
      await service.connectDirectory(values.team, path.resolve(directory, id!), targets);
      output({ connected: true, targets }, `工作目录已接入（目标：${targets.join(", ")}）；尚未安装或上传资产。`);
      return 0;
    }
    case "directory list": {
      const config = await service.store.read();
      const connections = config ? service.directoryConnections(config).filter((entry) => !values.team || entry.teamId === values.team) : [];
      output(connections, connections.map((entry) => `${entry.id}\t${entry.path}\t${entry.enabled ? "启用" : "停用"}\t${entry.targets.join(",")}`).join("\n") || "暂无接入目录。");
      return 0;
    }
    case "directory enable":
    case "directory disable":
    case "directory remove": {
      const config = await service.store.read();
      const connection = config ? service.directoryConnections(config).find((entry) => entry.id === id) : undefined;
      if (!connection) invalidArguments("找不到此工作目录连接。");
      await service.updateDirectory(
        connection.teamId,
        connection.id,
        connection.path,
        key === "directory remove" ? null : { enabled: key === "directory enable", targets: connection.targets },
      );
      output({ id, action: key }, "工作目录连接已更新，本地资产文件与已分享会话保留。");
      return 0;
    }
    case "project create": {
      if (!values.team) invalidArguments("创建协作项目需要 --team。");
      const project = await service.createProject({ name: id!, teamId: values.team });
      output(project, `已创建协作项目 ${project.name}（${project.id}），无需关联本地仓库。`);
      return 0;
    }
    case "project add": {
      const project = await service.addProject({
        id: id!,
        name: values.name,
        directory: path.resolve(directory, values.path ?? "."),
        remote: values.remote,
        teamId: values.personal ? null : values.team,
      });
      output(project, `已登记项目 ${project.name}。`);
      return 0;
    }
    case "project bind": {
      const project = await service.bindProject(id!, values.personal ? null : values.team);
      output(project, `项目 ${project.name} 的团队：${project.teamId === undefined ? "继承默认" : project.teamId ?? "个人"}。`);
      return 0;
    }
    case "project remove": {
      await service.removeProject(id!);
      output({ removedProjectId: id }, "已移除本地项目绑定，代码仓库保留。");
      return 0;
    }
    case "team list":
    case "project list": {
      const config = await service.store.read();
      if (!config) throw new WorkspaceError("NOT_INITIALIZED", "请先运行 agent-recall init。");
      const records = key === "team list" ? config.teams : config.projects;
      output(records, records.map((item) => `${item.id}\t${item.name}\t${item.repository ?? "本地仓库"}`).join("\n") || "暂无配置。");
      return 0;
    }
    default:
      invalidArguments("未知命令。");
  }
}

export async function runCli(argv: string[], runOptions: RunCliOptions = {}): Promise<number> {
  const writeOut = runOptions.stdout ?? ((text: string) => { process.stdout.write(text); });
  const writeErr = runOptions.stderr ?? ((text: string) => { process.stderr.write(text); });
  try {
    return await executeCli(argv, runOptions);
  } catch (error: unknown) {
    const known = error instanceof WorkspaceError;
    const failure = {
      code: known ? error.code : "OPERATION_FAILED",
      message: known ? error.message : "操作失败，请检查目录是否存在、文件权限及 Git 安装状态。",
      ...(known && error.details ? { details: error.details } : {}),
    };
    if (argv.includes("--json")) writeOut(`${JSON.stringify({ ok: false, error: failure })}\n`);
    else writeErr(`${failure.message}\n`);
    return failure.code === "INVALID_ARGUMENTS" ? 2 : 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
