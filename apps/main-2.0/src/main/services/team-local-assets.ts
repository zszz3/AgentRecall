import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { WorkspaceError } from "@agentrecall/workspace-core";
import type { TeamLocalAsset, TeamLocalCatalog } from "../../shared/ipc/team-workspace";

const SKILL_ROOTS = [".agents/skills", ".claude/skills", ".codex/skills", "skills"];
const MAX_PREVIEW_BYTES = 512 * 1024;
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

async function ordinaryPath(root: string, relative: string): Promise<string | null> {
  const parts = relative.split("/");
  if (!relative || parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part)) || path.isAbsolute(relative)) throw new WorkspaceError("INVALID_ARGUMENTS", "本地资源路径无效。");
  let candidate = root;
  for (const part of parts) {
    candidate = path.join(candidate, part);
    let stat;
    try { stat = await fs.lstat(candidate); } catch (error) { if (missing(error)) return null; throw error; }
    if (stat.isSymbolicLink()) return null;
  }
  const resolved = await fs.realpath(candidate);
  const child = path.relative(root, resolved);
  if (child.startsWith(`..${path.sep}`) || path.isAbsolute(child) || child === "..") return null;
  return resolved;
}

export async function readTeamLocalAssets(directory: string, kind: "skills" | "documents", file?: string, signal?: AbortSignal): Promise<TeamLocalCatalog | { path: string; content: string }> {
  const root = await fs.realpath(directory);
  if (!(await fs.stat(root)).isDirectory()) throw new WorkspaceError("LOCAL_DIRECTORY_REQUIRED", "请选择一个已有本地目录。");
  const entries: TeamLocalAsset[] = [];
  let visited = 0, limited = false, skipped = 0;
  const check = () => { if (signal?.aborted) throw new WorkspaceError("CANCELLED", "本地资源读取已取消。"); };
  const add = async (relative: string) => {
    check();
    if (entries.length >= 256 || relative.length > 2048) { limited = true; return; }
    const candidate = await ordinaryPath(root, relative);
    if (!candidate) { skipped++; return; }
    const stat = await fs.stat(candidate);
    if (stat.isFile()) {
      entries.push({ path: relative, name: kind === "skills" ? path.posix.basename(path.posix.dirname(relative)) : path.posix.basename(relative), bytes: stat.size });
      if (Buffer.byteLength(JSON.stringify({ directory: root, entries, limited: false, skipped })) > 1024 * 1024 - 64) { entries.pop(); limited = true; }
    }
  };
  const walk = async (relative: string, depth: number): Promise<void> => {
    check();
    if (visited >= 2048) { limited = true; return; }
    const candidate = relative ? await ordinaryPath(root, relative) : root;
    if (!candidate) return;
    const handle = await fs.opendir(candidate);
    // Async iteration closes the directory handle on break, cancellation and failure.
    for await (const entry of handle) {
        check();
        if (++visited > 2048 || entries.length >= 256) { limited = true; break; }
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { skipped++; continue; }
        if (entry.isFile() && /\.md$/i.test(entry.name)) await add(child);
        else if (entry.isDirectory() && depth > 0 && !entry.name.startsWith(".")) await walk(child, depth - 1);
        else if (entry.isDirectory() && relative && depth === 0) limited = true;
    }
  };
  if (kind === "documents") {
    await walk("", 0);
    const docs = await ordinaryPath(root, "docs");
    if (docs && (await fs.stat(docs)).isDirectory()) await walk("docs", 5);
  } else {
    for (const prefix of SKILL_ROOTS) {
      check();
      const candidate = await ordinaryPath(root, prefix);
      if (!candidate || !(await fs.stat(candidate)).isDirectory()) continue;
      const handle = await fs.opendir(candidate);
      for await (const entry of handle) {
        check();
        if (++visited > 2048 || entries.length >= 256) { limited = true; break; }
        if (entry.isSymbolicLink()) { skipped++; continue; }
        if (entry.isDirectory()) {
          const markdown = `${prefix}/${entry.name}/SKILL.md`;
          if (await ordinaryPath(root, markdown)) await add(markdown);
        }
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (!file) return { directory: root, entries, limited, skipped };
  if (!entries.some((entry) => entry.path === file)) throw new WorkspaceError("LOCAL_ASSET_NOT_FOUND", "文件不在当前目录的资源列表中，请刷新后重新选择。");
  const candidate = await ordinaryPath(root, file);
  if (!candidate) throw new WorkspaceError("LOCAL_ASSET_NOT_FOUND", "文件已移动或变成链接，请刷新后重试。");
  const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let content: string;
  try {
    if (!(await handle.stat()).isFile()) throw new WorkspaceError("LOCAL_ASSET_NOT_FOUND", "所选资源不是普通文件。");
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1); let size = 0;
    while (size < buffer.length) { check(); const part = await handle.read(buffer, size, buffer.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > MAX_PREVIEW_BYTES) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "文件超过 512 KiB，请在本地编辑器中查看。");
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)); }
    catch { throw new WorkspaceError("LOCAL_ASSET_INVALID", "文件不是 UTF-8 文本，请在本地编辑器中查看。"); }
  } finally { await handle.close(); }
  const result = { path: file, content };
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "预览数据超过 1 MiB，请在本地编辑器中查看。");
  return result;
}

/** Capture only the explicitly selected local resource; publication uses this immutable copy. */
export async function readTeamLocalPush(directory: string, kind: "skills" | "documents", file: string, signal?: AbortSignal) {
  const listed = await readTeamLocalAssets(directory, kind, undefined, signal);
  if (!("entries" in listed) || !listed.entries.some(entry => entry.path === file)) throw new WorkspaceError("LOCAL_ASSET_NOT_FOUND", "所选资源已不存在，请重新选择。");
  const root = listed.directory;
  const check = () => { if (signal?.aborted) throw new WorkspaceError("CANCELLED", "推送预览已取消。"); };
  let total = 0;
  const read = async (relative: string) => {
    check();
    const candidate = await ordinaryPath(root, relative);
    if (!candidate || !(await fs.lstat(candidate)).isFile()) throw new WorkspaceError("LOCAL_ASSET_INVALID", "资源包含链接或非普通文件，无法推送。");
    const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "单个资源文件超过 1 MiB 或不是普通文件。");
      if (await ordinaryPath(root, relative) !== candidate) throw new WorkspaceError("LOCAL_ASSET_CHANGED", "资源路径在读取期间发生变化，请重新预览。");
      const bytes = Buffer.alloc(stat.size + 1); let size = 0;
      while (size < bytes.length) { check(); const result = await handle.read(bytes, size, bytes.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
      const finished = await handle.stat();
      if (size !== stat.size || finished.mtimeMs !== stat.mtimeMs || finished.ctimeMs !== stat.ctimeMs) throw new WorkspaceError("LOCAL_ASSET_CHANGED", "资源在读取期间发生变化，请重新预览。");
      total += size;
      if (total > 1024 * 1024) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "一次推送的资源总量最多 1 MiB，请缩小资源后重试。");
      return { bytes: bytes.subarray(0, size), executable: Boolean(stat.mode & 0o111) };
    } finally { await handle.close(); }
  };
  if (kind === "documents") {
    const { bytes } = await read(file);
    try { return { kind, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
    catch { throw new WorkspaceError("LOCAL_ASSET_INVALID", "文档必须是 UTF-8 文本。"); }
  }
  const skillRoot = path.posix.dirname(file), files: Array<{ path: string; content: string; executable: boolean }> = [];
  let visited = 0;
  const walk = async (relative: string): Promise<void> => {
    check();
    const location = relative ? `${skillRoot}/${relative}` : skillRoot;
    const candidate = await ordinaryPath(root, location);
    if (!candidate) throw new WorkspaceError("LOCAL_ASSET_INVALID", "Skill 包含链接，无法推送。");
    const handle = await fs.opendir(candidate);
    for await (const entry of handle) {
      check();
      if (++visited > 512) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "Skill 包含过多目录或文件。");
      if (!relative && entry.name === ".agentrecall-install.json") continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile() || /^\.env(?:$|\.)/i.test(entry.name) || entry.name === ".git") throw new WorkspaceError("LOCAL_ASSET_INVALID", "Skill 包含链接、环境文件或仓库元数据，请整理后再推送。");
      if (entry.isDirectory()) await walk(name);
      else {
        if (files.length >= 200) throw new WorkspaceError("LOCAL_ASSET_TOO_LARGE", "单个 Skill 最多包含 200 个文件。");
        const value = await read(`${skillRoot}/${name}`);
        files.push({ path: name, content: value.bytes.toString("base64"), executable: value.executable });
      }
    }
  };
  await walk("");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { kind, files };
}
