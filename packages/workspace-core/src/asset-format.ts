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
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z.array(z.strictObject({ id: assetId, path: z.string().refine(portableAssetPath) })).max(64),
});
const fileSchema = z.strictObject({
  path: z.string().refine(portableAssetPath),
  content: z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value),
  executable: z.boolean(),
});
const skillSchema = z.strictObject({
  id: assetId, description: z.string().min(1).max(4096),
  files: z.array(fileSchema).min(1).max(200), digest: z.string().regex(/^[a-f0-9]{64}$/),
});
const snapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.string(), commit: revision,
  skills: z.array(skillSchema).max(64),
});
export type SkillFile = z.infer<typeof fileSchema>;
export type TeamSkill = z.infer<typeof skillSchema>;
export type AssetSnapshot = z.infer<typeof snapshotSchema>;

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
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.repository !== repository) throw invalidAsset();
  const snapshot = parsed.data;
  if (new Set(snapshot.skills.map((skill) => skill.id)).size !== snapshot.skills.length) throw invalidAsset();
  for (const skill of snapshot.skills) {
    const checked = skillFromFiles(skill.id, skill.files);
    if (checked.description !== skill.description || checked.digest !== skill.digest) throw invalidAsset();
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    throw new WorkspaceError("ASSETS_TOO_LARGE", "完整资产包超过 16 MiB，请拆分资产仓库后重试。");
  }
  return snapshot;
}

function invalidAsset(): WorkspaceError {
  return new WorkspaceError("INVALID_ASSET", "资产格式无效：请检查清单版本、唯一 ID、可移植文件路径和 SKILL.md 中的 name/description。单文件最多 1 MiB，每个 Skill 最多 200 个文件。");
}
