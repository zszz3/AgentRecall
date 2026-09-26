import { createHash } from "node:crypto";
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

async function runGit(args: string[], maximum: number, signal?: AbortSignal, input?: string): Promise<Buffer> {
  try {
    const pending = execute("git", args, {
      encoding: "buffer", timeout: 60_000, maxBuffer: maximum, windowsHide: true, signal,
      env: {
        ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined,
        GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined,
        GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
      },
    });
    let inputFailure: Error | undefined;
    const onInputError = (error: Error) => { inputFailure = error; pending.child.kill(); };
    // Git can reject the command before consuming stdin. Observe EPIPE and close the child.
    pending.child.stdin?.once("error", onInputError);
    pending.child.stdin?.end(input);
    try {
      const result = await pending;
      if (inputFailure) throw inputFailure;
      return result.stdout;
    } finally { pending.child.stdin?.removeListener("error", onInputError); }
  } catch {
    if (signal?.aborted) throw new WorkspaceError("CANCELLED", "Git 操作已取消，已有本地资产保留。");
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
    return this.readSnapshot(canonical, gitDirectory, signal);
  }

  async initialize(repository: string, scratch: string, transport: AssetTransport, assertOwned: () => void, signal?: AbortSignal): Promise<{ created: boolean; snapshot: AssetSnapshot }> {
    const canonical = canonicalGitHubRepository(repository);
    const gitDirectory = path.join(scratch, "repository.git");
    const hooks = path.join(scratch, "empty-hooks");
    await fs.mkdir(hooks);
    await this.cloneRepository(canonical, gitDirectory, transport, signal);
    const git = (args: string[], input?: string) => runGit(["--git-dir", gitDirectory, "-c", `core.hooksPath=${hooks}`, ...args], 1024 * 1024, signal, input);
    // Use the clone's recorded fetch URL, never a separately configured push URL.
    const url = (await git(["config", "--local", "--get", "remote.origin.url"])).toString("utf8").trim();
    const refs = await git(["ls-remote", "--refs", "--", url]);
    if (refs.length > 0) return { created: false, snapshot: await this.readSnapshot(canonical, gitDirectory, signal) };

    const files: Record<string, string> = {
      "agentrecall.json": JSON.stringify({ schemaVersion: 2, skills: [], workConfigs: [] }, null, 2) + "\n",
      "README.md": "# AgentRecall 团队资产\n\n此仓库由 agentrecall init 初始化。团队资产在 Git 中共同维护，项目选择需要的资产安装到本地。\n\n## 目录\n\n- agentrecall.json：AgentRecall 资产清单。当前支持 Skills 和工作配置。\n- skills/：每个 Skill 使用独立目录和 SKILL.md，并在清单 skills 中登记 id 与 path。\n- rules/、docs/、env/、members/：参考 TeamAI 的目录组织预留，当前不会自动分发或上传成员信息。请勿提交密钥。\n\n## 使用\n\n在 AgentRecall V2 设置中连接团队；进入团队后创建项目并关联本地 Git 目录，再手动同步和选择安装。CLI 也可使用 team enable、project add --team、team sync。初始化不会自动开启团队功能、安装 Hook 或上传 Session。\n\n## 添加 Skill\n\n创建 skills/review/SKILL.md，YAML frontmatter 包含 name: review 与非空 description，然后在 agentrecall.json 的 skills 中添加 {\"id\":\"review\",\"path\":\"skills/review\"}。提交并推送后，团队成员可手动同步、预览和安装。\n",
      ...Object.fromEntries(["skills", "rules", "docs", "env", "members"].map((directory) => [`${directory}/.gitkeep`, ""])),
    };
    // Build Git objects directly: no checkout, filters, hooks, user files or signing.
    const blobs = new Map<string, string>();
    for (const [file, content] of Object.entries(files)) {
      blobs.set(file, (await git(["hash-object", "-w", "--stdin"], content)).toString("ascii").trim());
    }
    const entries: string[] = [];
    for (const file of ["README.md", "agentrecall.json"]) entries.push(`100644 blob ${blobs.get(file)}\t${file}`);
    for (const directory of ["skills", "rules", "docs", "env", "members"]) {
      const tree = (await git(["mktree"], `100644 blob ${blobs.get(`${directory}/.gitkeep`)}\t.gitkeep\n`)).toString("ascii").trim();
      entries.push(`040000 tree ${tree}\t${directory}`);
    }
    const tree = (await git(["mktree"], entries.join("\n") + "\n")).toString("ascii").trim();
    const commit = (await git(["-c", "user.name=AgentRecall", "-c", "user.email=agentrecall@users.noreply.github.com", "-c", "commit.gpgSign=false", "commit-tree", tree], "Initialize AgentRecall team assets\n")).toString("ascii").trim();
    await git(["update-ref", "refs/heads/main", commit]);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    const snapshot = await this.readSnapshot(canonical, gitDirectory, signal);
    if ((await git(["ls-remote", "--refs", "--", url])).length > 0) {
      throw new WorkspaceError("INIT_REMOTE_CHANGED", "仓库在初始化期间已出现提交，本次未推送。请重新执行 init 校验已有内容。");
    }
    assertOwned();
    if (signal?.aborted) throw new WorkspaceError("CANCELLED", "初始化已取消，尚未推送模板。");
    try {
      // This root commit has no parents: a normal push cannot overwrite a concurrently created branch.
      await git(["push", "--porcelain", "--", url, `${commit}:refs/heads/main`]);
    } catch {
      throw new WorkspaceError("INIT_PUSH_UNCONFIRMED", "初始化推送未完成或结果未确认。请检查仓库写权限后重新执行 init；重试会先校验远端，不会覆盖已有提交。", { repository: canonical, remoteMayHaveChanged: true });
    }
    return { created: true, snapshot };
  }

  private async readSnapshot(canonical: string, gitDirectory: string, signal?: AbortSignal): Promise<AssetSnapshot> {
    const git = (args: string[], limit: number) => runGit(["--git-dir", gitDirectory, ...args], limit, signal);
    if (!(await git(["for-each-ref", "--format=%(refname)"], 1024 * 1024)).length) {
      throw new WorkspaceError("EMPTY_ASSET_REPOSITORY", "团队仓库为空，请先运行 agentrecall init <仓库地址> 初始化。");
    }
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
    if (!parsed.success) throw new WorkspaceError("INVALID_MANIFEST", "清单格式或版本不受支持；请使用受支持的 schemaVersion 1、2 或 3；文档清单需要版本 3。");
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
    const documents = [];
    if (parsed.data.schemaVersion === 3) {
      for (const document of parsed.data.documents) {
        const entry = entries.find((item) => item.path === document.path);
        if (!entry) throw new WorkspaceError("INVALID_ASSET", "清单中的文档不存在，请检查文档路径。");
        const bytes = await read(entry);
        retainedBytes += bytes.length;
        if (retainedBytes > 8 * 1024 * 1024) throw new WorkspaceError("ASSETS_TOO_LARGE", "团队资产总大小超过 8 MiB，请拆分仓库。");
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new WorkspaceError("INVALID_ASSET", "团队文档必须为 UTF-8 文本。"); }
        documents.push({ ...document, content, digest: createHash("sha256").update(content).digest("hex") });
      }
    }
    return validateSnapshot({
      schemaVersion: parsed.data.schemaVersion,
      repository: canonical,
      commit,
      skills,
      ...("workConfigs" in parsed.data ? { workConfigs: parsed.data.workConfigs } : {}),
      ...(parsed.data.schemaVersion === 3 ? { documents } : {}),
    }, canonical);
  }
}
