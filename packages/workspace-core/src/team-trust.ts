import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AssetSnapshot, TeamSkill } from "./asset-format.js";
import { WorkspaceError, hasErrorCode } from "./errors.js";

/** One team resource that can run code on a member's machine and needs an explicit decision before Pull installs it. */
export type TrustItem = { key: string; kind: "skill" | "mcp"; id: string; name: string; reasons: string[]; details: string[] };
export type TrustDecision = { trusted: string[]; skipped: string[] };

const SCRIPT_FILE = /(?:^|\/)(?:scripts?|bin)\/|\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|ps1|psm1|bat|cmd|exe|dll|so|dylib|jar)$/i;
const MAX_TRUSTED = 4096;
const keys = z.array(z.string().max(512)).max(MAX_TRUSTED);
const storeSchema = z.strictObject({ schemaVersion: z.literal(1), repository: z.string().max(2048), trusted: keys, declined: keys });
export type TrustRecord = { trusted: Set<string>; declined: Set<string> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function skillScripts(skill: TeamSkill): string[] {
  return skill.files.filter((file) => file.executable || SCRIPT_FILE.test(file.path)).map((file) => file.path);
}

/**
 * Lists MCP servers and script-bearing Skills in the snapshot. Keys bind the
 * decision to the exact content: MCP digests cover everything that decides what
 * runs and where it connects (not the display name or client selection), and
 * Skill keys use the published Skill digest. Any change asks again.
 */
export function trustItems(snapshot: AssetSnapshot): TrustItem[] {
  const items: TrustItem[] = [];
  for (const skill of snapshot.skills) {
    const scripts = skillScripts(skill);
    if (scripts.length) items.push({ key: `skill:${skill.id}:${skill.digest}`, kind: "skill", id: skill.id, name: skill.id, reasons: ["包含可执行文件或脚本"], details: scripts.slice(0, 20) });
  }
  for (const server of "mcpServers" in snapshot ? snapshot.mcpServers : []) {
    const { name: _name, targets: _targets, ...runtime } = server;
    const details = server.transport === "stdio"
      ? [`启动命令：${[server.command, ...server.args].join(" ").slice(0, 400)}`, ...Object.entries(server.env).map(([key, value]) => typeof value === "string" ? `环境变量 ${key}（共享值）` : `环境变量 ${key} ← 本机 ${value.fromEnv}`)]
      : [`连接地址：${server.url}`, ...Object.entries(server.headers).map(([key, value]) => typeof value === "string" ? `请求头 ${key}（共享值）` : `请求头 ${key} ← 本机 ${value.fromEnv}`)];
    items.push({ key: `mcp:${server.id}:${digest(runtime)}`, kind: "mcp", id: server.id, name: server.name, reasons: [server.transport === "stdio" ? "会在本机启动程序" : "会连接远程服务"], details: details.slice(0, 40) });
  }
  return items;
}

/**
 * Per-team record of trusted and declined content keys. It lives beside the
 * workspace config and is never shared through the team repository. Declined
 * keys are remembered so Pull does not ask again for the same content; reset
 * clears both lists so the next Pull asks about everything again.
 */
export class TeamTrustStore {
  private readonly file: string;
  constructor(configDirectory: string, teamId: string, private readonly repository: string) {
    this.file = path.join(configDirectory, "trust", `${teamId}.json`);
  }

  async read(): Promise<TrustRecord> {
    let text: string;
    try { text = await fs.readFile(this.file, "utf8"); }
    catch (error) { if (hasErrorCode(error, "ENOENT")) return { trusted: new Set(), declined: new Set() }; throw error; }
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = null; }
    const parsed = storeSchema.safeParse(value);
    if (!parsed.success) throw new WorkspaceError("INVALID_TRUST_STORE", "本机的团队信任记录无法读取。请在团队空间选择「重新确认信任」，下次 Pull 会重新询问。");
    // A repository switch must not carry approvals across to unrelated content.
    if (parsed.data.repository !== this.repository) return { trusted: new Set(), declined: new Set() };
    return { trusted: new Set(parsed.data.trusted), declined: new Set(parsed.data.declined) };
  }

  /** Callers hold the team's Pull lock, so read-modify-write cannot interleave. A key moves between lists when the member changes the decision. */
  async record(trusted: string[], declined: string[]): Promise<void> {
    if (!trusted.length && !declined.length) return;
    const current = await this.read();
    for (const key of trusted) { current.declined.delete(key); current.trusted.add(key); }
    for (const key of declined) { current.trusted.delete(key); current.declined.add(key); }
    await this.write([...current.trusted].slice(-MAX_TRUSTED), [...current.declined].slice(-MAX_TRUSTED));
  }

  async reset(): Promise<void> { await fs.rm(this.file, { force: true }); }

  private async write(trusted: string[], declined: string[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ schemaVersion: 1, repository: this.repository, trusted, declined }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
