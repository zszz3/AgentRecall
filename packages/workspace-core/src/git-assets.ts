import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { MAX_CONFIGURATION_PREVIEW_BYTES, type ConfigurationPreview } from "./configuration-format.js";
import { WorkspaceError } from "./errors.js";
import { canonicalGitHubRepository } from "./git.js";
import { manifestSchema, MAX_FILE_BYTES, skillFromFiles, validateSnapshot, type AssetChange, type AssetSnapshot, type SkillFile } from "./asset-format.js";

const execute = promisify(execFile);
export type AssetTransport = "https" | "ssh";
type CloneRepository = (repository: string, destination: string, transport: AssetTransport, signal?: AbortSignal) => Promise<void>;

async function runGit(args: string[], maximum: number, signal?: AbortSignal, input?: string | Buffer): Promise<Buffer> {
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
    const git = (args: string[], input?: string | Buffer) => runGit(["--git-dir", gitDirectory, "-c", `core.hooksPath=${hooks}`, ...args], 1024 * 1024, signal, input);
    // Use the clone's recorded fetch URL, never a separately configured push URL.
    const url = (await git(["config", "--local", "--get", "remote.origin.url"])).toString("utf8").trim();
    const refs = await git(["ls-remote", "--refs", "--", url]);
    if (refs.length > 0) return { created: false, snapshot: await this.readSnapshot(canonical, gitDirectory, signal) };

    const files: Record<string, string> = {
      "agentrecall.json": JSON.stringify({ schemaVersion: 4, skills: [], workConfigs: [], documents: [], instructions: [], mcpServers: [], environment: [] }, null, 2) + "\n",
      "README.md": "# AgentRecall 团队资产\n\n此仓库由 agentrecall init 初始化。团队资产在 Git 中共同维护，一次同步更新所有已启用的工作目录。\n\n## 资源\n\nagentrecall.json 使用版本 4 清单：skills、workConfigs、documents、instructions、mcpServers、environment。Skills 放入 skills/；共享指令放入 rules/，同步到 AGENTS.md 或 CLAUDE.md 的团队区块；普通文档放入 docs/。MCP 与公共环境变量直接在清单中维护，密钥只使用 fromEnv 引用，不提交密钥值。\n\n格式与完整示例：https://github.com/zszz3/AgentRecall/blob/main/docs/v2/team-assets.md\n\n## 使用\n\n在 AgentRecall V2 设置中连接团队，再在团队空间接入本地工作目录并选择客户端。点击「同步团队」统一更新，CLI 可运行 team sync。初始化不会自动开启团队功能、安装 Hook、启动 MCP 或上传会话。已有本地内容会受到保护；请在客户端信任工作目录并按需确认 MCP。\n\n## 添加 Skill\n\n创建 skills/review/SKILL.md，YAML frontmatter 包含 name: review 与非空 description，再在清单 skills 中添加 {\"id\":\"review\",\"path\":\"skills/review\"}。提交并推送后，成员可同步使用。\n",
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

  async prepareConfiguration(repository: string, scratch: string, transport: AssetTransport, change: AssetChange, expectedRevision: string, signal?: AbortSignal) {
    const canonical = canonicalGitHubRepository(repository), gitDirectory = path.join(scratch, "repository.git");
    await this.cloneRepository(canonical, gitDirectory, transport, signal);
    const hooks = path.join(scratch, "empty-publish-hooks"); await fs.mkdir(hooks);
    const git = (args: string[], input?: string | Buffer, maximum = MAX_FILE_BYTES + 1) => runGit(["--git-dir", gitDirectory, "-c", `core.hooksPath=${hooks}`, ...args], maximum, signal, input);
    const snapshot = await this.readSnapshot(canonical, gitDirectory, signal);
    if (snapshot.commit !== expectedRevision) throw new WorkspaceError("ASSET_REVISION_CHANGED", "团队仓库已有新版本，请先同步团队，再重新编辑或预览。");
    const branch = (await git(["symbolic-ref", "HEAD"])).toString("utf8").trim();
    if (!branch.startsWith("refs/heads/")) throw new WorkspaceError("INVALID_ASSET_BRANCH", "无法确定团队仓库的默认分支。");
    await git(["check-ref-format", branch]);
    const originalManifest = (await git(["show", `${snapshot.commit}:agentrecall.json`])).toString("utf8");
    const oldManifest = manifestSchema.parse(JSON.parse(originalManifest));
    const manifest = {
      schemaVersion: 5 as const, skills: oldManifest.skills,
      organization: "organization" in oldManifest ? [...oldManifest.organization] : [],
      workConfigs: "workConfigs" in oldManifest ? oldManifest.workConfigs : [],
      documents: "documents" in oldManifest ? oldManifest.documents : [],
      instructions: "instructions" in oldManifest ? [...oldManifest.instructions] : [],
      mcpServers: "instructions" in oldManifest ? [...oldManifest.mcpServers] : [],
      environment: "instructions" in oldManifest ? [...oldManifest.environment] : [],
    };
    const changes = change.kind === "batch" ? change.value.changes : [change];
    const files: ConfigurationPreview["files"] = [];
    const skillWrites = new Map<string, { bytes: Buffer | null; executable: boolean }>();
    const describeBytes = (bytes: Buffer): string => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.includes("\0")) return text;
      } catch { /* Binary Skill files are preserved; the preview shows their digest. */ }
      return `[Binary file · ${bytes.length} bytes · SHA-256 ${createHash("sha256").update(bytes).digest("hex")}]`;
    };
    const itemResults: NonNullable<ConfigurationPreview["items"]> = [];
    for (const change of changes) {
    const itemKey = `${change.kind}:${change.kind === "environment" ? change.value.name : change.value.id}`;
    const itemName = change.value.name;
    const beforeManifest = structuredClone(manifest);
    const start = files.length;
    const changed = <T>(entries: T[], index: number, next: T) => {
      if (change.operation === "create" && index >= 0) throw new WorkspaceError("CONFIGURATION_EXISTS", "同名团队资源已经存在，请打开原条目编辑。");
      if (change.operation === "update" && index < 0) throw new WorkspaceError("CONFIGURATION_MISSING", "团队资源已不存在，请同步后重试。");
      if (index < 0) entries.push(next); else entries[index] = next;
    };
    if (change.kind === "organization") {
      const index = manifest.organization.findIndex(item => item.id === change.value.id);
      const previous = manifest.organization[index];
      changed(manifest.organization, index, change.value);
      if (previous && isDeepStrictEqual(previous, change.value)) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; }
    } else if (change.kind === "skills") {
      const skill = skillFromFiles(change.value.id, change.value.files);
      const index = manifest.skills.findIndex(item => item.id === skill.id);
      const previous = snapshot.skills.find(item => item.id === skill.id);
      const destination = manifest.skills[index]?.path ?? `skills/${skill.id}`;
      if (index < 0 && (await git(["ls-tree", "HEAD", "--", destination])).length) throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "Skill 目标目录已存在未归属的文件，请先整理后再推送。");
      const key = destination.normalize("NFC").toLowerCase();
      const overlap = (location: string) => { const other = location.normalize("NFC").toLowerCase(); return other === key || other.startsWith(key + "/") || key.startsWith(other + "/"); };
      if (manifest.skills.some((item, i) => i !== index && overlap(item.path)) || [...manifest.documents, ...manifest.instructions].some(item => overlap(item.path))) throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "Skill 路径与其他团队资源重叠，请先拆分文件。");
      changed(manifest.skills, index, { id: skill.id, path: destination });
      if (previous?.digest === skill.digest) { if (changes.length > 1) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; } throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "内容没有变化，无需推送。"); }
      const before = new Map(previous?.files.map(file => [file.path, file]));
      const after = new Map(skill.files.map(file => [file.path, file]));
      for (const relative of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(relative), next = after.get(relative);
        if (old && next && old.content === next.content && old.executable === next.executable) continue;
        const file = `${destination}/${relative}`, bytes = next ? Buffer.from(next.content, "base64") : null;
        skillWrites.set(file, { bytes, executable: next?.executable ?? false });
        files.push({ path: file, before: old ? describeBytes(Buffer.from(old.content, "base64")) : null, after: bytes === null ? null : describeBytes(bytes), previousExecutable: old?.executable, executable: next?.executable });
      }
    } else if (change.kind === "documents") {
      const { content, ...metadata } = change.value;
      const index = manifest.documents.findIndex(item => item.id === metadata.id);
      const previous = "documents" in snapshot ? snapshot.documents.find(item => item.id === metadata.id) : undefined;
      const destination = manifest.documents[index]?.path ?? `docs/${metadata.id}.md`, key = destination.normalize("NFC").toLowerCase();
      if (manifest.documents.some((item, i) => i !== index && item.path.normalize("NFC").toLowerCase() === key)
        || manifest.instructions.some(item => item.path.normalize("NFC").toLowerCase() === key)
        || manifest.skills.some(item => key.startsWith(item.path.normalize("NFC").toLowerCase() + "/"))) throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "文档文件还被其他团队资源使用，请先拆分文件。");
      changed(manifest.documents, index, { ...metadata, path: destination });
      if (previous?.content === content && previous.target === metadata.target && previous.name === metadata.name) { if (changes.length > 1) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; } throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "内容没有变化，无需推送。"); }
      if (previous?.content !== content) files.push({ path: destination, before: previous?.content ?? null, after: content });
    } else if (change.kind === "instructions") {
      const { content, ...metadata } = change.value;
      const index = manifest.instructions.findIndex((item) => item.id === metadata.id);
      const previous = manifest.instructions[index];
      const destination = previous?.path ?? `rules/${metadata.id}.md`;
      const key = destination.normalize("NFC").toLowerCase();
      if (manifest.instructions.some((item, i) => i !== index && item.path.normalize("NFC").toLowerCase() === key)
        || manifest.documents.some((item) => item.path.normalize("NFC").toLowerCase() === key)
        || manifest.skills.some((item) => key.startsWith(item.path.normalize("NFC").toLowerCase() + "/"))) {
        throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "这份文件还被其他团队资源使用，请先在仓库拆分文件再编辑。");
      }
      const before = "instructions" in snapshot ? snapshot.instructions.find((item) => item.id === metadata.id)?.content ?? null : null;
      changed(manifest.instructions, index, { ...metadata, path: destination });
      if (previous && isDeepStrictEqual(previous, manifest.instructions[index]) && before === content) { if (changes.length > 1) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; } throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "内容没有变化，无需发布。"); }
      if (before !== content) files.push({ path: destination, before, after: content });
    } else if (change.kind === "mcp") {
      const index = manifest.mcpServers.findIndex((item) => item.id === change.value.id);
      const previous = manifest.mcpServers[index];
      changed(manifest.mcpServers, index, change.value);
      if (previous && isDeepStrictEqual(previous, change.value)) { if (changes.length > 1) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; } throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "内容没有变化，无需发布。"); }
    } else {
      const index = manifest.environment.findIndex((item) => item.name.toUpperCase() === change.value.name.toUpperCase());
      const previous = manifest.environment[index];
      if (previous && previous.name !== change.value.name) throw new WorkspaceError("CONFIGURATION_EXISTS", "已有名称仅大小写不同的变量，请使用原名称编辑。");
      changed(manifest.environment, index, change.value);
      if (previous && isDeepStrictEqual(previous, change.value)) { if (changes.length > 1) { itemResults.push({ key: itemKey, name: itemName, status: "unchanged", files: [] }); continue; } throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "内容没有变化，无需发布。"); }
    }
    const itemFiles = files.slice(start);
    for (const file of itemFiles) file.itemKey = itemKey;
    if (!itemFiles.length) {
      const field = change.kind === "mcp" ? "mcpServers" : change.kind;
      const before = beforeManifest[field].find(item => "id" in item ? change.kind !== "environment" && item.id === change.value.id : item.name === change.value.name);
      const after = manifest[field].find(item => "id" in item ? change.kind !== "environment" && item.id === change.value.id : item.name === change.value.name);
      itemFiles.push({ path: "agentrecall.json", before: before ? JSON.stringify(before, null, 2) : null, after: JSON.stringify(after, null, 2) });
    }
    itemResults.push({ key: itemKey, name: itemName, status: change.operation === "create" ? "added" : "modified", files: itemFiles });
    }
    if (itemResults.every(item => item.status === "unchanged")) throw new WorkspaceError("NO_CONFIGURATION_CHANGE", "所选资源与团队一致，无需推送。");
    const { organization: _organization, ...legacyManifest } = manifest;
    const outputManifest = "organization" in oldManifest || changes.some(item => item.kind === "organization") ? manifest : { ...legacyManifest, schemaVersion: 4 };
    const manifestText = JSON.stringify(manifestSchema.parse(outputManifest), null, 2) + "\n";
    if (Buffer.byteLength(manifestText) > MAX_FILE_BYTES) throw new WorkspaceError("ASSETS_TOO_LARGE", "完整团队清单超过 1 MiB，请在仓库中整理资源后重试。");
    files.unshift({ path: "agentrecall.json", before: originalManifest, after: manifestText });
    const preview: ConfigurationPreview = { repository: canonical, revision: snapshot.commit, branch: branch.slice("refs/heads/".length), kind: change.kind, operation: change.operation, name: change.value.name, files, items: itemResults };
    if (Buffer.byteLength(JSON.stringify(preview)) > MAX_CONFIGURATION_PREVIEW_BYTES) throw new WorkspaceError("ASSETS_TOO_LARGE", "完整变更预览超过 4 MiB，请缩小内容后重试。");

    // Rebuild only the affected Git trees. No checkout, filters, hooks or user
    // index are involved, and unrelated files retain their object ids and modes.
    const writeTree = async (tree: string | null, parts: string[], blob: string | null, overwrite: boolean, executable?: boolean): Promise<string> => {
      const raw = tree ? new TextDecoder("utf-8", { fatal: true }).decode(await git(["ls-tree", "-z", tree])) : "";
      const entries = raw.split("\0").filter(Boolean).map((entry) => {
        const match = /^(\d+) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
        if (!match) throw new WorkspaceError("INVALID_ASSET", "无法读取团队仓库文件目录。");
        return { mode: match[1]!, type: match[2]!, oid: match[3]!, name: match[4]! };
      });
      const name = parts[0]!;
      const existing = entries.find((entry) => entry.name.normalize("NFC").toLowerCase() === name.normalize("NFC").toLowerCase());
      if (existing && existing.name !== name) throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "文件路径存在大小写或字符规范化冲突，未覆盖已有文件。");
      let next;
      if (parts.length > 1) {
        if (existing && existing.type !== "tree") throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "目标父路径不是目录，未覆盖已有内容。");
        next = { mode: "040000", type: "tree", oid: await writeTree(existing?.oid ?? null, parts.slice(1), blob, overwrite, executable), name };
      } else {
        if (existing && (!overwrite || existing.type !== "blob" || !["100644", "100755"].includes(existing.mode))) throw new WorkspaceError("CONFIGURATION_FILE_CONFLICT", "目标文件已被其他内容占用，未覆盖已有文件。");
        next = blob === null ? null : { mode: executable === undefined ? existing?.mode ?? "100644" : executable ? "100755" : "100644", type: "blob", oid: blob, name };
      }
      const updated = entries.filter((entry) => entry !== existing).concat(next ? [next] : []);
      return (await git(["mktree", "-z"], updated.map((entry) => `${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`).join(""))).toString("ascii").trim();
    };
    let tree = (await git(["rev-parse", "HEAD^{tree}"])).toString("ascii").trim();
    for (const file of files) {
      const skillWrite = skillWrites.get(file.path);
      const bytes = skillWrite ? skillWrite.bytes : file.after;
      const blob = bytes === null ? null : (await git(["hash-object", "-w", "--stdin"], bytes)).toString("ascii").trim();
      tree = await writeTree(tree, file.path.split("/"), blob, file.before !== null, skillWrite?.executable);
    }
    const commit = (await git(["-c", "user.name=AgentRecall", "-c", "user.email=agentrecall@users.noreply.github.com", "-c", "commit.gpgSign=false", "commit-tree", tree, "-p", snapshot.commit], `Update team ${change.kind}: ${change.value.name}\n`)).toString("ascii").trim();
    await git(["update-ref", branch, commit, snapshot.commit]);
    const updatedSnapshot = await this.readSnapshot(canonical, gitDirectory, signal);
    const url = (await git(["config", "--local", "--get", "remote.origin.url"])).toString("utf8").trim();
    let published = false;
    return { preview, snapshot: updatedSnapshot, get published() { return published; }, publish: async (assertReady: () => void) => {
      const remote = (await git(["ls-remote", "--refs", "--", url, branch])).toString("utf8").trim().split(/\s+/);
      if (remote[0] !== snapshot.commit || remote[1] !== branch) throw new WorkspaceError("ASSET_REVISION_CHANGED", "团队仓库已有新版本，请先同步团队并重新预览，未覆盖其他成员的改动。");
      assertReady();
      if (signal?.aborted) throw new WorkspaceError("CANCELLED", "发布已取消，尚未推送。");
      // The new commit's only parent is the previewed revision. The exact lease
      // makes the ref comparison atomic, including concurrent deletes/rewinds;
      // a successful update is still strictly fast-forward and rewrites no history.
      try { await git(["push", "--porcelain", `--force-with-lease=${branch}:${snapshot.commit}`, "--", url, `${commit}:${branch}`]); }
      catch { throw new WorkspaceError("ASSET_PUBLISH_UNCONFIRMED", "发布未完成或结果尚未确认。请检查仓库写权限和分支保护，并先同步查看远端结果，再重新编辑；不会强制覆盖。", { repository: canonical, commit }); }
      published = true;
      return commit;
    } };
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
    if (!parsed.success) throw new WorkspaceError("INVALID_MANIFEST", "清单格式或版本不受支持；请使用受支持的 schemaVersion 1—5；共享指令、MCP 与 Env 需要版本 4。");
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
    if ("documents" in parsed.data) {
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
    const instructions = [];
    if ("instructions" in parsed.data) {
      for (const instruction of parsed.data.instructions) {
        const entry = entries.find((item) => item.path === instruction.path);
        if (!entry) throw new WorkspaceError("INVALID_ASSET", "共享指令文件不存在，请检查清单路径。");
        const bytes = await read(entry); retainedBytes += bytes.length;
        if (retainedBytes > 8 * 1024 * 1024) throw new WorkspaceError("ASSETS_TOO_LARGE", "团队资产总大小超过 8 MiB，请拆分仓库。");
        let content: string;
        try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
        catch { throw new WorkspaceError("INVALID_ASSET", "共享指令必须为 UTF-8 文本。"); }
        instructions.push({ ...instruction, content, digest: createHash("sha256").update(content).digest("hex") });
      }
    }
    return validateSnapshot({
      schemaVersion: parsed.data.schemaVersion,
      repository: canonical,
      commit,
      skills,
      ...("organization" in parsed.data ? { organization: parsed.data.organization } : {}),
      ...("instructions" in parsed.data ? { instructions, mcpServers: parsed.data.mcpServers, environment: parsed.data.environment } : {}),
      ...("workConfigs" in parsed.data ? { workConfigs: parsed.data.workConfigs } : {}),
      ...("documents" in parsed.data ? { documents } : {}),
    }, canonical);
  }
}
