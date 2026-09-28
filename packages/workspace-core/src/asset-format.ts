import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { WorkspaceError } from "./errors.js";

export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_BYTES = 1024 * 1024;
export const assetId = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).refine((value) => value !== "synced" && portableAssetPath(value));
export const revision = z.string().regex(/^[a-f0-9]{40}$/);
export function portableAssetPath(value: string): boolean {
  return value.length > 0 && value.length <= 180 && value.split("/").every((part) =>
    part !== "." && part !== ".." && !/[. ]$/.test(part) && /^[^<>:"\\|?*\x00-\x1f]+$/.test(part)
    && !/^(?:\.git|\.agentrecall-install\.json|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
const manifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z.array(z.strictObject({ id: assetId, path: z.string().refine(portableAssetPath) })).max(64),
});
const workConfigSchema = z.strictObject({
  id: assetId,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4096),
  skills: z.array(assetId).min(1).max(64),
});
const manifestV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  skills: z.array(z.strictObject({ id: assetId, path: z.string().refine(portableAssetPath) })).max(64),
  workConfigs: z.array(workConfigSchema).max(64),
});
const documentEntrySchema = z.strictObject({
  id: assetId, name: z.string().trim().min(1).max(200),
  path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".md")),
  target: z.string().refine((value) => portableAssetPath(value) && (value === "AGENTS.md" || value === "CLAUDE.md" || value.startsWith("docs/") && value.endsWith(".md"))),
});
const manifestV3Schema = manifestV2Schema.extend({ schemaVersion: z.literal(3), documents: z.array(documentEntrySchema).max(128) });
const clients = z.array(z.enum(["codex", "claude"])).min(1).max(2).refine((items) => new Set(items).size === items.length).default(["codex", "claude"]);
const configName = z.string().trim().min(1).max(200).refine((value) => !/[\r\n\0]/.test(value) && !value.includes("agentrecall:team"));
const envName = z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine((name) => !["__proto__", "constructor", "prototype"].includes(name));
const plainValue = z.string().max(8192).refine((value) => !value.includes("\0") && !value.includes("${") && !value.includes("agentrecall:team"));
const environmentValue = z.union([plainValue, z.strictObject({ fromEnv: envName })]);
const instructionEntrySchema = z.strictObject({ id: assetId, name: configName, path: z.string().refine(portableAssetPath).refine((value) => value.endsWith(".md")), targets: clients });
const mcpBase = { id: assetId, name: configName, targets: clients };
const mcpSchema = z.discriminatedUnion("transport", [
  z.strictObject({ ...mcpBase, transport: z.literal("stdio"), command: z.string().min(1).max(2048).refine((value) => !/[\r\n\0]/.test(value)), args: z.array(plainValue).max(64).default([]), env: z.record(envName, environmentValue).refine((env) => Object.keys(env).length <= 64 && Object.entries(env).every(([key, value]) => typeof value === "string" || value.fromEnv === key)).default({}) }),
  z.strictObject({ ...mcpBase, transport: z.literal("http"), url: z.string().url().max(2048).refine((value) => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !value.includes("${"); }), headers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/).refine((name) => !["constructor", "prototype"].includes(name)), environmentValue).refine((value) => Object.keys(value).length <= 64).default({}) }),
]);
const environmentSchema = z.strictObject({ name: envName, value: plainValue, targets: clients });
const configurationFields = { instructions: z.array(instructionEntrySchema).max(16), mcpServers: z.array(mcpSchema).max(32), environment: z.array(environmentSchema).max(64) };
const manifestV4Schema = manifestV3Schema.extend({ schemaVersion: z.literal(4), ...configurationFields });
export const manifestSchema = z.union([manifestV1Schema, manifestV2Schema, manifestV3Schema, manifestV4Schema]);
const fileSchema = z.strictObject({
  path: z.string().refine(portableAssetPath),
  content: z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value),
  executable: z.boolean(),
});
const skillSchema = z.strictObject({
  id: assetId, description: z.string().min(1).max(4096),
  files: z.array(fileSchema).min(1).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const snapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.string(), commit: revision,
  skills: z.array(skillSchema).max(64),
});
const snapshotV2Schema = z.strictObject({
  schemaVersion: z.literal(2), repository: z.string(), commit: revision,
  skills: z.array(skillSchema).max(64), workConfigs: z.array(workConfigSchema).max(64),
});
const documentSchema = documentEntrySchema.extend({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const snapshotV3Schema = snapshotV2Schema.extend({ schemaVersion: z.literal(3), documents: z.array(documentSchema).max(128) });
const instructionSchema = instructionEntrySchema.extend({ content: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) });
const snapshotV4Schema = snapshotV3Schema.extend({ schemaVersion: z.literal(4), ...configurationFields, instructions: z.array(instructionSchema).max(16) });
export type TeamConfiguration = Pick<z.infer<typeof snapshotV4Schema>, "instructions" | "mcpServers" | "environment">;
export type TeamDocument = z.infer<typeof documentSchema>;
export type SkillFile = z.infer<typeof fileSchema>;
export type TeamSkill = z.infer<typeof skillSchema>;
export type WorkConfig = z.infer<typeof workConfigSchema>;
export type AssetSnapshot = z.infer<typeof snapshotV1Schema> | z.infer<typeof snapshotV2Schema> | z.infer<typeof snapshotV3Schema> | z.infer<typeof snapshotV4Schema>;

export function fileDigest(files: SkillFile[]): string {
  return createHash("sha256").update(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))).digest("hex");
}

export function skillFromFiles(id: string, files: SkillFile[]): TeamSkill {
  if (!assetId.safeParse(id).success || files.length === 0 || files.length > 200) throw invalidAsset();
  const names = new Set<string>();
  const spellings = new Map<string, string>();
  for (const file of files) {
    if (!fileSchema.safeParse(file).success || Buffer.from(file.content, "base64").length > MAX_FILE_BYTES) throw invalidAsset();
    const name = file.path.normalize("NFC").toLowerCase();
    if (names.has(name)) throw invalidAsset();
    names.add(name);
    const parts = file.path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const spelling = parts.slice(0, i).join("/");
      const key = spelling.normalize("NFC").toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== spelling) throw invalidAsset();
      spellings.set(key, spelling);
    }
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join("/"))) throw invalidAsset();
  }
  const markdown = files.find((file) => file.path === "SKILL.md");
  if (!markdown) throw invalidAsset();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(markdown.content, "base64")); }
  catch { throw invalidAsset(); }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) throw invalidAsset();
  let metadata: unknown;
  try {
    const document = parseDocument(frontmatter[1]!);
    if (document.errors.length || document.warnings.length) throw invalidAsset();
    metadata = document.toJS({ maxAliasCount: 0 });
  } catch { throw invalidAsset(); }
  const parsed = z.object({ name: z.literal(id), description: z.string().trim().min(1).max(4096) }).safeParse(metadata);
  if (!parsed.success) throw invalidAsset();
  return { id, description: parsed.data.description, files, digest: fileDigest(files) };
}

export function validateSnapshot(value: unknown, repository: string): AssetSnapshot {
  const parsed = z.union([snapshotV1Schema, snapshotV2Schema, snapshotV3Schema, snapshotV4Schema]).safeParse(value);
  if (!parsed.success || parsed.data.repository !== repository) throw invalidAsset();
  const snapshot = parsed.data;
  if (new Set(snapshot.skills.map((skill) => skill.id)).size !== snapshot.skills.length) throw invalidAsset();
  for (const skill of snapshot.skills) {
    const checked = skillFromFiles(skill.id, skill.files);
    if (checked.description !== skill.description || checked.digest !== skill.digest) throw invalidAsset();
  }
  if ("workConfigs" in snapshot) {
    const ids = new Set(snapshot.skills.map((skill) => skill.id));
    if (new Set(snapshot.workConfigs.map((config) => config.id)).size !== snapshot.workConfigs.length
      || snapshot.workConfigs.some((config) => new Set(config.skills).size !== config.skills.length || config.skills.some((id) => !ids.has(id)))) {
      throw invalidAsset();
    }
  }
  if ("documents" in snapshot) {
    const ids = new Set<string>(); const targets = new Set<string>();
    const spellings = new Map<string, string>();
    for (const document of snapshot.documents) {
      const key = document.target.normalize("NFC").toLowerCase();
      if (ids.has(document.id) || targets.has(key) || Buffer.byteLength(document.content) > MAX_FILE_BYTES
        || createHash("sha256").update(document.content).digest("hex") !== document.digest) throw invalidAsset();
      const parts = document.target.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const spelling = parts.slice(0, i).join("/");
        const normalized = spelling.normalize("NFC").toLowerCase();
        if (spellings.has(normalized) && spellings.get(normalized) !== spelling) throw invalidAsset();
        spellings.set(normalized, spelling);
      }
      ids.add(document.id); targets.add(key);
    }
  }
  if ("documents" in snapshot) {
    const targets = new Set(snapshot.documents.map((document) => document.target.normalize("NFC").toLowerCase()));
    for (const target of targets) {
      const parts = target.split("/");
      for (let i = 1; i < parts.length; i++) if (targets.has(parts.slice(0, i).join("/"))) throw invalidAsset();
    }
  }
  if (snapshot.schemaVersion === 4) {
    if (new Set(snapshot.instructions.map((item) => item.id)).size !== snapshot.instructions.length
      || new Set(snapshot.mcpServers.map((item) => item.id)).size !== snapshot.mcpServers.length
      || new Set(snapshot.environment.map((item) => item.name.toUpperCase())).size !== snapshot.environment.length) throw invalidAsset();
    for (const item of snapshot.instructions) {
      if (Buffer.byteLength(item.content) > MAX_FILE_BYTES || item.content.includes("agentrecall:team")
        || createHash("sha256").update(item.content).digest("hex") !== item.digest
        || snapshot.documents.some((doc) => item.targets.some((target) => doc.target === (target === "codex" ? "AGENTS.md" : "CLAUDE.md")))) throw invalidAsset();
    }
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new WorkspaceError("ASSETS_TOO_LARGE", "完整资产包超过 16 MiB，请拆分资产仓库后重试。");
  }
  return snapshot;
}

function invalidAsset(): WorkspaceError {
  return new WorkspaceError("INVALID_ASSET", "资产格式无效：请检查清单版本、唯一 ID、可移植文件路径和 SKILL.md 中的 name/description。单文件最多 1 MiB，每个 Skill 最多 200 个文件。");
}
