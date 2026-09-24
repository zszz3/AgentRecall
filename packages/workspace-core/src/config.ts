import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { canonicalGitHubRepository } from "./git.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const repository = z.string().refine((value) => {
  try { return canonicalGitHubRepository(value) === value; } catch { return false; }
});
const absolutePath = z.string().refine((value) => path.isAbsolute(value));
const teamSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(200),
  repository,
});
const projectSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(200),
  root: absolutePath,
  gitCommonDir: absolutePath,
  repository: repository.nullable(),
  remote: z.string().min(1).nullable(),
  // Missing inherits the global default; null explicitly keeps a project personal.
  teamId: id.nullable().optional(),
});
const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  teamEnabled: z.boolean(),
  defaultTeamId: id.nullable(),
  teams: z.array(teamSchema),
  projects: z.array(projectSchema),
}).superRefine((config, context) => {
  const teamIds = new Set(config.teams.map((team) => team.id));
  if (teamIds.size !== config.teams.length) context.addIssue({ code: "custom", path: ["teams"], message: "Duplicate team ID" });
  if (new Set(config.projects.map((project) => project.id)).size !== config.projects.length) {
    context.addIssue({ code: "custom", path: ["projects"], message: "Duplicate project ID" });
  }
  if (config.defaultTeamId !== null && !teamIds.has(config.defaultTeamId)) {
    context.addIssue({ code: "custom", path: ["defaultTeamId"], message: "Unknown team" });
  }
  for (const [index, project] of config.projects.entries()) {
    if (project.teamId && !teamIds.has(project.teamId)) {
      context.addIssue({ code: "custom", path: ["projects", index, "teamId"], message: "Unknown team" });
    }
    if ((project.remote === null) !== (project.repository === null)) {
      context.addIssue({ code: "custom", path: ["projects", index, "remote"], message: "Remote and repository must be paired" });
    }
  }
});

export type WorkspaceConfig = z.infer<typeof configSchema>;
export type TeamSpace = WorkspaceConfig["teams"][number];
export type ProjectBinding = WorkspaceConfig["projects"][number];

const MAX_CONFIG_BYTES = 1024 * 1024;

function parseWorkspaceConfig(value: unknown): WorkspaceConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "config"))];
    throw new WorkspaceError("INVALID_CONFIG", `配置无效或版本不受支持，请修复这些字段：${fields.join(", ")}。原文件未修改。`);
  }
  return parsed.data;
}

export class WorkspaceConfigStore {
  readonly filePath: string;

  constructor(homeDirectory: string) {
    this.filePath = path.join(path.resolve(homeDirectory), "config.json");
  }

  async read(): Promise<WorkspaceConfig | null> {
    let handle;
    try { handle = await fs.open(this.filePath, "r"); } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    let text: string;
    try {
      if (!(await handle.stat()).isFile()) throw new WorkspaceError("INVALID_CONFIG", "配置路径不是普通文件。");
      // Bound the complete value, including metadata, even if an external editor grows it during the read.
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const result = await handle.read(buffer, count, buffer.length - count, null);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (count > MAX_CONFIG_BYTES) throw new WorkspaceError("CONFIG_TOO_LARGE", "配置超过 1 MiB，请减少项目或团队配置后重试。");
      text = buffer.subarray(0, count).toString("utf8");
    } finally { await handle.close(); }
    let value: unknown;
    try { value = JSON.parse(text); } catch {
      throw new WorkspaceError("INVALID_CONFIG", "配置不是有效的 JSON，请修复后重试。原文件未修改。");
    }
    return parseWorkspaceConfig(value);
  }

  async initialize(): Promise<WorkspaceConfig> {
    return this.write((current) => current ?? {
      schemaVersion: 1, teamEnabled: false, defaultTeamId: null, teams: [], projects: [],
    });
  }

  async update(change: (current: WorkspaceConfig) => WorkspaceConfig): Promise<WorkspaceConfig> {
    return this.write((current) => {
      if (!current) throw new WorkspaceError("NOT_INITIALIZED", "请先运行 agentrecall init。");
      return change(current);
    });
  }

  private async write(change: (current: WorkspaceConfig | null) => WorkspaceConfig): Promise<WorkspaceConfig> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    // Resolve the parent so commands using a symlinked config directory share one lock.
    const directory = await fs.realpath(path.dirname(this.filePath));
    const filePath = path.join(directory, "config.json");
    let compromised: Error | undefined;
    let release;
    try {
      release = await lockfile.lock(directory, {
        lockfilePath: path.join(directory, ".config.lock"),
        retries: { retries: 25, factor: 1, minTimeout: 40, maxTimeout: 40 },
        onCompromised: (error) => { compromised = error; },
      });
    } catch (error) {
      if (hasErrorCode(error, "ELOCKED")) throw new WorkspaceError("CONFIG_BUSY", "另一个 AgentRecall 命令正在更新配置，请稍后重试。");
      throw error;
    }
    const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
    try {
      const current = await this.read();
      const next = parseWorkspaceConfig(change(current));
      const content = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(content, "utf8") > MAX_CONFIG_BYTES) {
        throw new WorkspaceError("CONFIG_TOO_LARGE", "配置超过 1 MiB，原文件未修改。");
      }
      if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
      if (compromised) throw new WorkspaceError("CONFIG_BUSY", "配置锁已失效，本次更新已取消，请重试。");
      await fs.rename(temporary, filePath);
      return next;
    } finally {
      try { await fs.rm(temporary, { force: true }); } finally { await release(); }
    }
  }
}
