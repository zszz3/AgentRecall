import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { portableAssetPath, MAX_FILE_BYTES, type TeamDocument } from "./asset-format.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";

const target = z.string().refine((value) => portableAssetPath(value) && (value === "AGENTS.md" || value === "CLAUDE.md" || value.startsWith("docs/") && value.endsWith(".md")));
const recordSchema = z.strictObject({ schemaVersion: z.literal(1), documents: z.array(z.strictObject({ id: z.string().max(64), target, repository: z.string().max(2048), digest: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{40}$/) })).max(256) });
type RecordState = z.infer<typeof recordSchema>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function invalid(): WorkspaceError { return new WorkspaceError("DOCUMENT_CONFLICT", "文档包含本地修改、非受管内容或不安全路径，原内容已保留。"); }
function present(file: string) { try { return fs.lstatSync(file); } catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; } }
function read(file: string, max: number): string | null {
  const stat = present(file); if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw invalid();
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(max + 1); let length = 0;
    while (length < bytes.length) { const size = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!size) break; length += size; }
    if (length > max) throw invalid();
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); } catch { throw invalid(); }
  } finally { fs.closeSync(fd); }
}

// The caller owns the document lock and holds the configuration lock while publishing.
export class ProjectDocuments {
  private readonly file: string;
  private original: string | null;
  readonly state: RecordState;
  constructor(private readonly root: string) {
    this.file = path.join(root, ".agentrecall-documents.json");
    this.original = read(this.file, 1024 * 1024);
    try { this.state = recordSchema.parse(this.original === null ? { schemaVersion: 1, documents: [] } : JSON.parse(this.original)); }
    catch { throw new WorkspaceError("INVALID_DOCUMENT_STATE", "文档归属记录损坏或版本不支持，请恢复记录备份后再同步。"); }
    if (new Set(this.state.documents.map((item) => item.target.normalize("NFC").toLowerCase())).size !== this.state.documents.length) throw invalid();
  }
  private destination(relative: string, create = false): string {
    if (!target.safeParse(relative).success) throw invalid();
    const parts = relative.split("/"); let current = this.root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part); let stat = present(current);
      if (!stat && create) { fs.mkdirSync(current); stat = fs.lstatSync(current); }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw invalid();
    }
    return path.join(current, parts.at(-1)!);
  }
  private save(documents: RecordState["documents"]): void {
    if (read(this.file, 1024 * 1024) !== this.original) throw new WorkspaceError("DOCUMENT_STATE_CHANGED", "文档记录已改变，请重新同步。");
    const content = JSON.stringify(recordSchema.parse({ schemaVersion: 1, documents }));
    if (Buffer.byteLength(content) > 1024 * 1024) throw new WorkspaceError("DOCUMENT_STATE_TOO_LARGE", "完整文档记录超过 1 MiB，未更新文件。");
    const temp = path.join(this.root, `.agentrecall-document-record-${randomUUID()}.tmp`);
    let published = false;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file); published = true; this.original = content; this.state.documents = documents;
    } finally { if (!published) fs.rmSync(temp, { force: true }); }
  }
  private backup(destination: string): string {
    const base = path.join(this.root, ".agentrecall-document-backups");
    const stat = present(base);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw invalid();
    if (!stat) fs.mkdirSync(base, { mode: 0o700 });
    const saved = path.join(base, `${randomUUID()}.md`);
    fs.renameSync(destination, saved); return saved;
  }
  apply(document: TeamDocument, repository: string, revision: string) {
    const destination = this.destination(document.target);
    const previous = this.state.documents.find((item) => item.target.normalize("NFC").toLowerCase() === document.target.normalize("NFC").toLowerCase());
    if (previous && previous.target !== document.target) throw invalid();
    const local = read(destination, MAX_FILE_BYTES);
    if (previous && previous.repository !== repository) throw invalid();
    if (local === document.content) {
      if (previous && (previous.digest !== document.digest || previous.revision !== revision || previous.id !== document.id)) this.save(this.state.documents.map((item) => item === previous ? { ...item, id: document.id, digest: document.digest, revision } : item));
      return { status: "unchanged" as const, backup: null };
    }
    if (local !== null && (!previous || digest(local) !== previous.digest)) throw invalid();
    const next = [...this.state.documents.filter((item) => item.target !== document.target), { id: document.id, target: document.target, repository, revision, digest: document.digest }];
    const temp = path.join(this.root, `.agentrecall-document-content-${randomUUID()}.tmp`);
    let backup: string | null = null, published = false, committed = false;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, document.content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.destination(document.target, true);
      if (read(destination, MAX_FILE_BYTES) !== local) throw invalid();
      if (local !== null) backup = this.backup(destination);
      fs.linkSync(temp, destination); published = true;
      this.save(next); committed = true;
      return { status: local === null ? "installed" as const : "updated" as const, backup };
    } catch (error) {
      if (published || backup) {
        try {
          if (published) { if (read(destination, MAX_FILE_BYTES) !== document.content) throw invalid(); fs.unlinkSync(destination); }
          if (backup) { if (present(destination)) throw invalid(); fs.renameSync(backup, destination); }
        } catch { throw new WorkspaceError("DOCUMENT_RECOVERY_REQUIRED", "文档更新未完成，文件或备份已保留，请检查后重试。", { target: document.target, backup }); }
      }
      throw error;
    } finally {
      try { fs.rmSync(temp, { force: true }); }
      catch { throw new WorkspaceError("DOCUMENT_RECOVERY_REQUIRED", "文档暂存文件未能清理，请检查同步结果和暂存文件。", { target: document.target, committed, temporary: temp, backup }); }
    }
  }
  retire(targetPath: string, repository: string) {
    const previous = this.state.documents.find((item) => item.target === targetPath && item.repository === repository);
    if (!previous) throw invalid();
    const destination = this.destination(targetPath), local = read(destination, MAX_FILE_BYTES);
    if (local !== null && digest(local) !== previous.digest) throw invalid();
    const backup = local === null ? null : this.backup(destination);
    try { this.save(this.state.documents.filter((item) => item !== previous)); }
    catch (error) {
      if (backup) {
        try { if (present(destination)) throw invalid(); fs.renameSync(backup, destination); }
        catch { throw new WorkspaceError("DOCUMENT_RECOVERY_REQUIRED", "文档已移至备份，但记录更新失败，请检查后恢复。", { target: targetPath, backup }); }
      }
      throw error;
    }
    return { status: "retired" as const, backup };
  }
}
