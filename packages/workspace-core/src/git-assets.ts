import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { WorkspaceError } from "./errors.js";
import { canonicalGitHubRepository } from "./git.js";
import { manifestSchema, MAX_FILE_BYTES, skillFromFiles, validateSnapshot, type AssetSnapshot, type SkillFile } from "./asset-format.js";

const execute = promisify(execFile);
export type AssetTransport = "https" | "ssh";
type CloneRepository = (repository: string, destination: string, transport: AssetTransport, signal?: AbortSignal) => Promise<void>;

async function runGit(args: string[], maximum: number, signal?: AbortSignal): Promise<Buffer> {
  try {
    const result = await execute("git", args, {
      encoding: "buffer", timeout: 60_000, maxBuffer: maximum, windowsHide: true, signal,
      env: {
        ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined,
        GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
      },
    });
    return result.stdout;
  } catch {
    if (signal?.aborted) throw new WorkspaceError("CANCELLED", "资产同步已取消，已有缓存保留。");
    throw new WorkspaceError("ASSET_GIT_FAILED", "无法读取资产仓库。请检查网络、Git 安装和所选 HTTPS/SSH 的仓库访问权限；不会自动登录或索取凭据。");
  }
}

async function cloneGitHub(repository: string, destination: string, transport: AssetTransport, signal?: AbortSignal): Promise<void> {
  const url = transport === "ssh" ? `git@github.com:${repository.slice("https://github.com/".length)}.git` : `${repository}.git`;
  const emptyTemplate = path.join(path.dirname(destination), "empty-template");
  await fs.mkdir(emptyTemplate);
  // Bare clones read Git objects without checking out files, running filters, or following submodules.
  await runGit(["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", "-c", "core.hooksPath=" + emptyTemplate,
    "clone", "--bare", "--depth=1", "--no-local", `--template=${emptyTemplate}`, "--", url, destination], 1024 * 1024, signal);
}

export class GitAssetSource {
  constructor(private readonly cloneRepository: CloneRepository = cloneGitHub) {}

  async load(repository: string, scratch: string, transport: AssetTransport, signal?: AbortSignal): Promise<AssetSnapshot> {
    const canonical = canonicalGitHubRepository(repository);
    const gitDirectory = path.join(scratch, "repository.git");
    await this.cloneRepository(canonical, gitDirectory, transport, signal);
    const git = (args: string[], limit: number) => runGit(["--git-dir", gitDirectory, ...args], limit, signal);
    const commit = (await git(["rev-parse", "HEAD^{commit}"], 1024)).toString("ascii").trim();
    let tree: string;
    try { tree = new TextDecoder("utf-8", { fatal: true }).decode(await git(["ls-tree", "-r", "-z", "--long", commit], 1024 * 1024)); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("INVALID_ASSET", "资产文件名必须使用 UTF-8。");
    }
    const entries = tree.split("\0").filter(Boolean).map((entry) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new WorkspaceError("INVALID_ASSET", "无法识别资产仓库的文件目录。");
      return { mode: match[1]!, type: match[2]!, oid: match[3]!, size: Number(match[4]), path: match[5]! };
    });
    const read = async (entry: typeof entries[number]) => {
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || entry.size > MAX_FILE_BYTES) {
        throw new WorkspaceError("INVALID_ASSET", "资产不能包含符号链接、子模块或超过 1 MiB 的文件。");
      }
      const content = await git(["cat-file", "blob", entry.oid], MAX_FILE_BYTES + 1);
      if (content.length !== entry.size) throw new WorkspaceError("INVALID_ASSET", "资产文件大小校验失败。");
      if (content.subarray(0, 128).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1\n")) {
        throw new WorkspaceError("UNSUPPORTED_ASSET", "资产包暂不支持 Git LFS 文件，请将所需文件直接保存在 Git 仓库中。");
      }
      return content;
    };
    const manifestEntry = entries.find((entry) => entry.path === "agentrecall.json");
    if (!manifestEntry) throw new WorkspaceError("MISSING_MANIFEST", "资产仓库根目录缺少 agentrecall.json 清单。");
    let manifestValue: unknown;
    try { manifestValue = JSON.parse((await read(manifestEntry)).toString("utf8")); }
    catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("INVALID_MANIFEST", "agentrecall.json 不是有效的 JSON。");
    }
    const parsed = manifestSchema.safeParse(manifestValue);
    if (!parsed.success) throw new WorkspaceError("INVALID_MANIFEST", "清单格式或版本不受支持；请使用 schemaVersion 1 和 skills 列表。");
    const skills = [];
    let retainedBytes = 0;
    for (const item of parsed.data.skills) {
      const selected = entries.filter((entry) => entry.path.startsWith(`${item.path}/`));
      if (!selected.length || selected.length > 200) throw new WorkspaceError("INVALID_ASSET", "Skill 目录不存在或文件数量超过 200。");
      const files: SkillFile[] = [];
      for (const entry of selected) {
        retainedBytes += entry.size;
        if (!Number.isFinite(retainedBytes) || retainedBytes > 8 * 1024 * 1024) throw new WorkspaceError("ASSETS_TOO_LARGE", "所选 Skill 的原始文件总计超过 8 MiB，请拆分仓库。");
        files.push({ path: entry.path.slice(item.path.length + 1), content: (await read(entry)).toString("base64"), executable: entry.mode === "100755" });
      }
      skills.push(skillFromFiles(item.id, files));
    }
    return validateSnapshot({ schemaVersion: 1, repository: canonical, commit, skills }, canonical);
  }
}
