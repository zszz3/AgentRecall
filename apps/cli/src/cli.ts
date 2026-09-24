import os from "node:os";
import path from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { WorkspaceError, WorkspaceService, TeamAssetService, type WorkspaceStatus } from "@agentrecall/workspace-core";
import packageInfo from "../package.json" with { type: "json" };

const help = `AgentRecall CLI — 本地项目与可选团队配置

  agentrecall init                         初始化个人配置（团队默认关闭）
  agentrecall status [--project <id>]       查看当前项目与团队状态
  agentrecall doctor                       检查配置与当前目录的仓库绑定
  agentrecall team add <id> --repo <url>    登记团队资产仓库（不连接或下载）
  agentrecall team list                    列出已登记的团队
  agentrecall team use <id>                设置默认团队（不会启用团队功能）
  agentrecall team use --personal          清除默认团队
  agentrecall team enable|disable          开启或关闭团队功能
  agentrecall team current [--project <id>] 读取当前可用的团队配置
  agentrecall team sync [--transport https|ssh] 拉取当前项目的团队资产
  agentrecall skill list                   列出当前团队缓存的 Skill
  agentrecall skill preview <id> [--target codex|claude] [--file <path>]
  agentrecall skill install <id> --target codex|claude --revision <预览中的版本>
  agentrecall skill uninstall <id> --target codex|claude
  agentrecall project add <id> [--path <dir>] [--remote <name>] [--team <id>|--personal]
  agentrecall project list
  agentrecall project remove <id>          移除本地绑定（保留代码仓库）
  agentrecall project bind <id> --team <id>|--personal|--inherit

所有命令支持 --json；add 支持 --name；sync 和 skill 命令支持 --project。
--cwd <dir> 指定操作目录；Skill 只安装到该项目，不改变个人 Skill。
AGENTRECALL_HOME 指定配置目录，默认 ~/.agentrecall-cli。
只有 team sync 主动连接远端。安装必须显式选择版本和客户端；不上传 Session。
`;

const options = {
  json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
  cwd: { type: "string" }, project: { type: "string" }, repo: { type: "string" }, name: { type: "string" },
  path: { type: "string" }, remote: { type: "string" }, team: { type: "string" },
  personal: { type: "boolean" }, inherit: { type: "boolean" },
  target: { type: "string" }, revision: { type: "string" }, transport: { type: "string" }, file: { type: "string" },
} as const;

function invalidArguments(message: string): never {
  throw new WorkspaceError("INVALID_ARGUMENTS", `${message} 使用 agentrecall --help 查看用法。`);
}

function describeStatus(status: WorkspaceStatus): string {
  const reasons: Record<WorkspaceStatus["reason"], string> = {
    not_initialized: "尚未初始化，请运行 agentrecall init。", team_disabled: "团队功能已关闭，使用个人模式。",
    no_project: "当前目录未绑定项目。", no_team: "当前项目未选择团队。", ready: "团队功能已开启，资产状态可用 skill list 查看。",
  };
  return [reasons[status.reason], `配置：${status.configPath}`, `项目：${status.project?.name ?? "未选择"}`,
    `配置的团队：${status.team?.name ?? "无"}`].join("\n");
}

async function main(): Promise<void> {
  const parsed = (() => {
    try { return parseArgs({ options, allowPositionals: true, strict: true }); }
    catch { return invalidArguments("参数无效。"); }
  })();
  const { values, positionals } = parsed;
  const output = (data: unknown, message: string) => process.stdout.write(`${values.json ? JSON.stringify({ ok: true, data }) : stripVTControlCharacters(message)}\n`);
  if (values.help || positionals.length === 0 && Object.keys(values).every((flag) => flag === "json")) { output({ help }, help.trimEnd()); return; }
  if (values.version) { output({ version: packageInfo.version }, packageInfo.version); return; }
  const [command, action, id] = positionals;
  const key = command === "team" || command === "project" || command === "skill" ? `${command} ${action ?? ""}` : command!;
  const commands: Record<string, { count: number; flags: string[] }> = {
    init: { count: 1, flags: [] }, status: { count: 1, flags: ["project"] }, doctor: { count: 1, flags: ["project"] },
    "team add": { count: 3, flags: ["repo", "name"] }, "team list": { count: 2, flags: [] },
    "team use": { count: values.personal ? 2 : 3, flags: ["personal"] },
    "team enable": { count: 2, flags: [] }, "team disable": { count: 2, flags: [] },
    "team current": { count: 2, flags: ["project"] },
    "team sync": { count: 2, flags: ["project", "transport"] },
    "skill list": { count: 2, flags: ["project"] },
    "skill preview": { count: 3, flags: ["project", "target", "file"] },
    "skill install": { count: 3, flags: ["project", "target", "revision"] },
    "skill uninstall": { count: 3, flags: ["project", "target"] },
    "project add": { count: 3, flags: ["path", "remote", "name", "team", "personal"] },
    "project list": { count: 2, flags: [] }, "project remove": { count: 3, flags: [] },
    "project bind": { count: 3, flags: ["team", "personal", "inherit"] },
  };
  const spec = commands[key];
  if (!spec || positionals.length !== spec.count) invalidArguments("命令或参数数量不正确。");
  if (Object.keys(values).some((flag) => !["json", "cwd", ...spec.flags].includes(flag))) invalidArguments("此命令不支持所选选项。");
  if (Object.values(values).some((value) => typeof value === "string" && !value.trim())) invalidArguments("选项值不能为空。");
  const teamFlags = Number(values.team !== undefined) + Number(Boolean(values.personal)) + Number(Boolean(values.inherit));
  if (teamFlags > 1 || key === "project bind" && teamFlags !== 1) invalidArguments("请只选择 --team、--personal 或 --inherit 中的一项。");
  if (key === "team add" && !values.repo) invalidArguments("缺少 --repo。");
  if ((key === "skill install" || key === "skill uninstall") && !values.target) invalidArguments("缺少 --target。");
  if (values.target !== undefined && values.target !== "codex" && values.target !== "claude") invalidArguments("--target 只能为 codex 或 claude。");
  if (key === "skill install" && !/^[a-f0-9]{40}$/.test(values.revision ?? "")) invalidArguments("请先预览 Skill，再通过 --revision 提供完整版本。");
  if (values.transport !== undefined && values.transport !== "https" && values.transport !== "ssh") invalidArguments("--transport 只能为 https 或 ssh。");
  if (process.env.AGENTRECALL_HOME !== undefined && !process.env.AGENTRECALL_HOME.trim()) invalidArguments("AGENTRECALL_HOME 不能为空。");
  const directory = path.resolve(values.cwd ?? process.cwd());
  const service = new WorkspaceService(process.env.AGENTRECALL_HOME ?? path.join(os.homedir(), ".agentrecall-cli"));
  const assets = new TeamAssetService(service);
  switch (key) {
    case "init": {
      const config = await service.store.initialize();
      output({ configPath: service.store.filePath, config }, "配置已就绪。重复初始化会保留已有配置；新配置的团队功能默认关闭。");
      break;
    }
    case "status": case "doctor": {
      const status = await service.status(directory, values.project);
      if (key === "doctor" && !status.initialized) throw new WorkspaceError("NOT_INITIALIZED", "请先运行 agentrecall init。");
      output(status, describeStatus(status)); break;
    }
    case "team add": {
      const team = await service.addTeam({ id: id!, name: values.name, repository: values.repo! });
      output(team, `已登记团队 ${team.name}。此操作不会启用团队功能或连接远端。`); break;
    }
    case "team use": {
      const config = await service.setDefaultTeam(values.personal ? null : id!);
      output({ defaultTeamId: config.defaultTeamId }, `默认团队：${config.defaultTeamId ?? "个人"}。`); break;
    }
    case "team enable": case "team disable": {
      const config = await service.setTeamEnabled(key === "team enable");
      output({ teamEnabled: config.teamEnabled }, config.teamEnabled ? "团队功能已开启，用 team sync 主动拉取资产。" : "团队功能已关闭。已安装的本地 Skill 仍保留，需要移除时使用 skill uninstall。"); break;
    }
    case "team current": {
      const context = await service.currentTeam(directory, values.project);
      output(context, `项目：${context.project.name}\n团队：${context.team.name}\n资产仓库：${context.team.repository}`); break;
    }
    case "team sync": {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const result = await assets.sync(directory, values.project, values.transport as "https" | "ssh" | undefined, controller.signal);
        output(result, `已缓存 ${result.skills} 个 Skill。版本：${result.commit}。请用 skill preview 查看后选择安装。`);
      } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
      break;
    }
    case "skill list": {
      const result = await assets.list(directory, values.project);
      output(result, `团队：${result.teamId}\n版本：${result.commit}\n${result.skills.map((skill) => `${skill.id}\t${skill.description}`).join("\n") || "暂无 Skill。"}`); break;
    }
    case "skill preview": {
      const result = await assets.preview(directory, id!, values.project, values.target as "codex" | "claude" | undefined, values.file);
      output(result, `版本：${result.commit}\n${result.destination ? `安装位置：${result.destination}\n` : ""}文件：${result.files.map((file) => file.path).join(", ")}\n\n${result.file} (${result.encoding}):\n${result.content}`); break;
    }
    case "skill install": {
      const result = await assets.install(directory, id!, values.target as "codex" | "claude", values.revision!, values.project);
      output(result, `${result.status === "existing" ? "相同内容已经安装" : "已安装"}：${result.path}\n版本：${result.commit}`); break;
    }
    case "skill uninstall": {
      const result = await assets.uninstall(directory, id!, values.target as "codex" | "claude", values.project);
      output(result, `已卸载，保留的备份：${result.backupPath}`); break;
    }
    case "project add": {
      const project = await service.addProject({
        id: id!, name: values.name, directory: path.resolve(directory, values.path ?? "."), remote: values.remote,
        teamId: values.personal ? null : values.team,
      });
      output(project, `已登记项目 ${project.name}。`); break;
    }
    case "project bind": {
      const project = await service.bindProject(id!, values.personal ? null : values.team);
      output(project, `项目 ${project.name} 的团队：${project.teamId === undefined ? "继承默认" : project.teamId ?? "个人"}。`); break;
    }
    case "project remove": {
      await service.removeProject(id!);
      output({ removedProjectId: id }, "已移除本地项目绑定，代码仓库保留。"); break;
    }
    case "team list": case "project list": {
      const config = await service.store.read();
      if (!config) throw new WorkspaceError("NOT_INITIALIZED", "请先运行 agentrecall init。");
      const records = key === "team list" ? config.teams : config.projects;
      output(records, records.map((item) => `${item.id}\t${item.name}\t${item.repository ?? "本地仓库"}`).join("\n") || "暂无配置。"); break;
    }
  }
}

main().catch((error: unknown) => {
  const known = error instanceof WorkspaceError;
  const failure = { code: known ? error.code : "OPERATION_FAILED", message: known ? error.message : "操作失败，请检查目录是否存在、文件权限及 Git 安装状态。" };
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: failure })}\n`);
  else process.stderr.write(`${failure.message}\n`);
  process.exitCode = failure.code === "INVALID_ARGUMENTS" ? 2 : 1;
});
