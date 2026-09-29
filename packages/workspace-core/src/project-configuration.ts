import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { parseDocument } from "yaml";
import { MAX_FILE_BYTES, type TeamConfiguration } from "./asset-format.js";
import { hasErrorCode, WorkspaceError } from "./errors.js";

const files = ["AGENTS.md", "CLAUDE.md", ".codex/config.toml", ".mcp.json", ".claude/settings.json"] as const;
type File = typeof files[number];
type Fragment = { key: string; value: unknown };
type Desired = { file: File; kind: "instruction" | "configuration" | "mcp" | "environment"; text?: string; entries?: Fragment[] };
const stateSchema = z.strictObject({ schemaVersion: z.literal(1), files: z.array(z.strictObject({ file: z.enum(files), repository: z.string().max(2048), owned: z.string().max(MAX_FILE_BYTES) })).max(5) });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function conflict(message = "团队配置与已有内容冲突，原文件已保留。请检查个人配置或受管部分的本地修改后重试。") { return new WorkspaceError("CONFIGURATION_CONFLICT", message); }
function present(file: string) { try { return fs.lstatSync(file); } catch (error) { if (hasErrorCode(error, "ENOENT")) return null; throw error; } }
function read(file: string): string | null {
  const stat = present(file); if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw conflict();
  const fd = fs.openSync(file, "r");
  try {
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
    while (length < bytes.length) { const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > MAX_FILE_BYTES) throw conflict("完整配置超过 1 MiB，请缩小文件后重试。");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); } catch { throw conflict(); }
  } finally { fs.closeSync(fd); }
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw conflict();
  return value as Record<string, unknown>;
}
function markers(file: File) { return file.endsWith(".toml") ? ["\n# agentrecall:team begin\n", "# agentrecall:team end\n"] : ["\n<!-- agentrecall:team begin -->\n", "<!-- agentrecall:team end -->\n"]; }
function mergeText(file: File, local: string, previous: string | undefined, desired: string) {
  const [start, end] = markers(file) as [string, string];
  let personal = local;
  if (previous !== undefined) {
    if (!previous.startsWith(start) || !previous.endsWith(end) || local.split(previous).length !== 2) throw conflict();
    personal = local.replace(previous, "");
  }
  if (personal.includes("agentrecall:team")) throw conflict();
  const owned = desired ? `${start}${desired.trimEnd()}\n${end}` : "";
  const next = personal + owned;
  if (file.endsWith(".toml")) {
    // Parsing both complete values rejects duplicate tables, dotted-key collisions,
    // and a marker placed inside a personal multiline string.
    try {
      const combined = parseToml(personal), after = parseToml(next), expected = parseToml(desired);
      for (const [section, additions] of Object.entries(expected)) {
        const sectionValue = Object.hasOwn(combined, section) ? record(combined[section]) : Object.create(null) as Record<string, unknown>;
        for (const [key, value] of Object.entries(record(additions))) {
          if (Object.hasOwn(sectionValue, key)) throw conflict();
          sectionValue[key] = value;
        }
        Object.defineProperty(combined, section, { value: sectionValue, enumerable: true, configurable: true, writable: true });
      }
      if (!isDeepStrictEqual(after, combined)) throw conflict();
    } catch { throw conflict("Codex 配置包含重复设置、同名 MCP 或无法合并的表。原文件已保留，请在编辑器中处理后重试。"); }
  }
  return { next, owned };
}
function mergeJson(file: File, local: string, previous: string | undefined, desired: Fragment[]) {
  let object: Record<string, unknown>, old: Fragment[];
  try {
    const parsed = parseDocument(local || "{}", { uniqueKeys: true });
    if (parsed.errors.length || parsed.warnings.length) throw conflict();
    object = record(JSON.parse(local || "{}"));
    old = previous === undefined ? [] : z.array(z.strictObject({ key: z.string().max(128).refine((value) => !["__proto__", "constructor", "prototype"].includes(value)), value: z.unknown() })).max(64).parse(JSON.parse(previous));
  } catch { throw conflict(); }
  const section = file === ".mcp.json" ? "mcpServers" : "env";
  const values = Object.hasOwn(object, section) ? record(object[section]) : {};
  if (new Set(old.map((item) => item.key)).size !== old.length) throw conflict();
  for (const item of old) {
    if (!Object.hasOwn(values, item.key) || !isDeepStrictEqual(values[item.key], item.value)) throw conflict();
    delete values[item.key];
  }
  for (const item of desired) {
    if (Object.hasOwn(values, item.key) || section === "env" && Object.keys(values).some((key) => key.toUpperCase() === item.key.toUpperCase())) throw conflict();
    Object.defineProperty(values, item.key, { value: item.value, enumerable: true, configurable: true, writable: true });
  }
  if (Object.keys(values).length || Object.hasOwn(object, section)) object[section] = values;
  return { next: JSON.stringify(object, null, 2) + "\n", owned: desired.length ? JSON.stringify(desired) : "" };
}

export function configurationFiles(configuration: TeamConfiguration, target: "codex" | "claude"): Desired[] {
  const instructions = configuration.instructions.filter((item) => item.targets.includes(target));
  const servers = configuration.mcpServers.filter((item) => item.targets.includes(target));
  const environment = configuration.environment.filter((item) => item.targets.includes(target));
  const result: Desired[] = [{ file: target === "codex" ? "AGENTS.md" : "CLAUDE.md", kind: "instruction", text: instructions.map((item) => `## ${item.name.replace(/[\r\n]/g, " ")}\n\n${item.content}`).join("\n\n") }];
  if (target === "codex") {
    const mcpServers = Object.fromEntries(servers.map((server) => {
      if (server.transport === "stdio") return [server.id, { command: server.command, args: server.args, env: Object.fromEntries(Object.entries(server.env).filter(([, value]) => typeof value === "string")), env_vars: Object.entries(server.env).filter(([, value]) => typeof value !== "string").map(([key]) => key) }];
      return [server.id, { url: server.url, http_headers: Object.fromEntries(Object.entries(server.headers).filter(([, value]) => typeof value === "string")), env_http_headers: Object.fromEntries(Object.entries(server.headers).flatMap(([key, value]) => typeof value === "string" ? [] : [[key, value.fromEnv]])) }];
    }));
    const content = { ...(servers.length ? { mcp_servers: mcpServers } : {}), ...(environment.length ? { shell_environment_policy: { set: Object.fromEntries(environment.map((item) => [item.name, item.value])) } } : {}) };
    result.push({ file: ".codex/config.toml", kind: "configuration", text: servers.length || environment.length ? stringifyToml(content) : "" });
  } else {
    const expansion = (values: Record<string, string | { fromEnv: string }>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "string" ? value : "${" + value.fromEnv + "}"]));
    result.push({ file: ".mcp.json", kind: "mcp", entries: servers.map((server) => ({ key: server.id, value: server.transport === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: expansion(server.env) } : { type: "http", url: server.url, headers: expansion(server.headers) } })) });
    result.push({ file: ".claude/settings.json", kind: "environment", entries: environment.map((item) => ({ key: item.name, value: item.value })) });
  }
  return result;
}

// The caller holds the per-directory asset lock and config lock during apply.
// File publication precedes the owner record. Failure restores the prior file;
// a process crash leaves a digest mismatch and a backup, never silent adoption.
export class ProjectConfiguration {
  private readonly file: string;
  private original: string | null;
  private state: z.infer<typeof stateSchema>;
  constructor(private readonly root: string) {
    this.file = path.join(root, ".agentrecall-configuration.json");
    this.original = read(this.file);
    try { this.state = stateSchema.parse(this.original === null ? { schemaVersion: 1, files: [] } : JSON.parse(this.original)); }
    catch { throw conflict("配置归属记录损坏或版本不支持，请恢复备份记录后重试。"); }
    if (new Set(this.state.files.map((item) => item.file)).size !== this.state.files.length) throw conflict();
  }
  private destination(relative: File, create = false) {
    let current = this.root;
    const parts = relative.split("/");
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part); let stat = present(current);
      if (!stat && create) { fs.mkdirSync(current, { mode: 0o700 }); stat = present(current); }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw conflict();
    }
    return path.join(current, parts.at(-1)!);
  }
  apply(desired: Desired, repository: string) {
    const previous = this.state.files.find((item) => item.file === desired.file);
    const empty = desired.entries ? desired.entries.length === 0 : !desired.text;
    if (!previous && empty) return null;
    const destination = this.destination(desired.file), local = read(destination);
    if (previous && previous.repository !== repository) throw conflict();
    if (previous && local === null) throw conflict("受管配置已被本地删除，请恢复文件备份后重试。");
    const { next, owned } = desired.entries ? mergeJson(desired.file, local ?? "", previous?.owned, desired.entries) : mergeText(desired.file, local ?? "", previous?.owned, desired.text ?? "");
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw conflict("完整配置超过 1 MiB，请缩小文件后重试。");
    if (previous?.owned === owned) return { status: "unchanged" as const, backup: null };
    const nextState = { schemaVersion: 1 as const, files: [...this.state.files.filter((item) => item.file !== desired.file), ...(owned ? [{ file: desired.file, repository, owned }] : [])] };
    const stateText = JSON.stringify(stateSchema.parse(nextState));
    if (Buffer.byteLength(stateText) > MAX_FILE_BYTES) throw conflict("完整配置归属记录超过 1 MiB，未更新文件。");
    const temporary = path.join(this.root, `.agentrecall-config-${randomUUID()}.tmp`), stateTemp = path.join(this.root, `.agentrecall-config-state-${randomUUID()}.tmp`);
    let backup: string | null = null, published = false;
    const stage = (file: string, content: string) => { const fd = fs.openSync(file, "wx", 0o600); try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
    try {
      stage(temporary, next); stage(stateTemp, stateText);
      this.destination(desired.file, true);
      if (read(destination) !== local || read(this.file) !== this.original) throw conflict();
      if (local !== null) {
        const folder = path.join(this.root, ".agentrecall-configuration-backups"), stat = present(folder);
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw conflict();
        if (!stat) fs.mkdirSync(folder, { mode: 0o700 });
        backup = path.join(folder, randomUUID()); fs.renameSync(destination, backup);
      }
      fs.linkSync(temporary, destination); published = true;
      fs.renameSync(stateTemp, this.file); this.original = stateText; this.state = nextState;
      return { status: empty ? "retired" as const : previous ? "updated" as const : "installed" as const, backup };
    } catch (error) {
      if (published || backup) {
        try {
          // The staged file still has two links until cleanup; inspect its bytes
          // directly here after validating the destination is the published inode.
          if (published) {
            const stat = fs.lstatSync(destination), staged = fs.lstatSync(temporary);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.ino !== staged.ino || stat.dev !== staged.dev || hash(fs.readFileSync(destination, "utf8")) !== hash(next)) throw conflict();
            fs.unlinkSync(destination);
          }
          if (backup) { if (present(destination)) throw conflict(); fs.renameSync(backup, destination); }
        } catch { throw new WorkspaceError("CONFIGURATION_RECOVERY_REQUIRED", "配置更新未完成，文件和备份已保留，请检查后恢复。", { target: desired.file, backup }); }
      }
      throw error;
    } finally {
      try { fs.rmSync(temporary, { force: true }); fs.rmSync(stateTemp, { force: true }); }
      catch { throw new WorkspaceError("CONFIGURATION_RECOVERY_REQUIRED", "配置暂存文件未能清理，请检查文件与备份后重试。", { target: desired.file, backup }); }
    }
  }
}
