import type { SkillTemplate } from "./types";

interface BundledSkillMetadata {
  tags?: string[];
  sourceLabel?: string;
  sourceUrl?: string;
  categoryId?: string;
}

const BUNDLED_SKILL_ORDER = [
  "brainstorming",
  "frontend-design",
  "feishu-tech-diagram",
  "handoff",
  "skill-creator",
  "systematic-debugging",
  "personal-finance-planning",
  "resume-optimization",
  "paper-writing",
  "rewrite-technical-tutorial",
  "refactor-review-knowledge",
  "code-review-and-quality",
];

const BUNDLED_SKILL_ROOT = "/assets/bundled-skills";

const skillMarkdownFiles = import.meta.glob<string>("/assets/bundled-skills/*/SKILL.md", {
  eager: true,
  import: "default",
  query: "?raw",
});
const skillTranslationFiles = import.meta.glob<string>("/assets/bundled-skills/*/SKILL.zh.md", {
  eager: true,
  import: "default",
  query: "?raw",
});
const skillMetadataFiles = import.meta.glob<string>("/assets/bundled-skills/*/metadata.json", {
  eager: true,
  import: "default",
  query: "?raw",
});
const directSkillAssetFiles = import.meta.glob<string>("/assets/bundled-skills/*/*", {
  eager: true,
  import: "default",
  query: "?raw",
});
const nestedSkillAssetFiles = import.meta.glob<string>("/assets/bundled-skills/*/**/*", {
  eager: true,
  import: "default",
  query: "?raw",
});

export interface BundledSkillAsset {
  relativePath: string;
  contents: string;
}

function skillIdFromPath(filePath: string): string {
  const match = filePath.match(/\/assets\/bundled-skills\/([^/]+)\/[^/]+$/);
  if (!match?.[1]) throw new Error(`Invalid bundled skill path: ${filePath}`);
  return match[1];
}

function sourcePathFor(filePath: string): string {
  return filePath.replace(/^\//, "");
}

export function bundledSkillAssetsFor(skillId: string): BundledSkillAsset[] {
  const prefix = `${BUNDLED_SKILL_ROOT}/${skillId}/`;
  const assets = new Map<string, string>();
  for (const [filePath, contents] of Object.entries({ ...directSkillAssetFiles, ...nestedSkillAssetFiles })) {
    if (!filePath.startsWith(prefix)) continue;
    assets.set(filePath.slice(prefix.length), contents);
  }
  return [...assets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, contents]) => ({ relativePath, contents }));
}

function normalizeNewlines(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n");
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const normalized = normalizeNewlines(markdown);
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};
  const frontmatter = normalized.slice(4, end).split("\n");
  const values: Record<string, string> = {};
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match?.[1]) continue;
    values[match[1]] = stripYamlScalar(match[2] ?? "");
  }
  return values;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function metadataFor(skillId: string): BundledSkillMetadata {
  const raw = skillMetadataFiles[`${BUNDLED_SKILL_ROOT}/${skillId}/metadata.json`];
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Partial<BundledSkillMetadata>;
  const metadata: BundledSkillMetadata = {};
  if (Array.isArray(parsed.tags)) metadata.tags = parsed.tags.filter((tag): tag is string => typeof tag === "string");
  if (typeof parsed.sourceLabel === "string") metadata.sourceLabel = parsed.sourceLabel;
  if (typeof parsed.sourceUrl === "string") metadata.sourceUrl = parsed.sourceUrl;
  if (typeof parsed.categoryId === "string") metadata.categoryId = parsed.categoryId;
  return metadata;
}

function orderedSkillEntries(): Array<[string, string]> {
  return BUNDLED_SKILL_ORDER.map((skillId) => {
    const filePath = `${BUNDLED_SKILL_ROOT}/${skillId}/SKILL.md`;
    const prompt = skillMarkdownFiles[filePath];
    if (prompt === undefined) {
      throw new Error(`Bundled Automation Skill is missing its canonical asset: ${filePath}`);
    }
    return [filePath, prompt];
  });
}

export function loadBundledSkillTemplates(): SkillTemplate[] {
  return orderedSkillEntries().map(([filePath, prompt]) => {
    const id = skillIdFromPath(filePath);
    const normalizedPrompt = normalizeNewlines(prompt);
    const frontmatter = parseFrontmatter(normalizedPrompt);
    const metadata = metadataFor(id);
    const template: SkillTemplate = {
      id,
      sourceType: "official",
      name: frontmatter.name || id,
      description: frontmatter.description || "",
      prompt: normalizedPrompt,
      tags: metadata.tags ?? [id],
      sourceLabel: metadata.sourceLabel ?? "bundled skill",
      sourcePath: sourcePathFor(filePath),
      ...(metadata.categoryId ? { categoryId: metadata.categoryId } : {}),
    };
    const sourceUrl = metadata.sourceUrl;
    if (sourceUrl) template.sourceUrl = sourceUrl;
    const translationZh = skillTranslationFiles[`${BUNDLED_SKILL_ROOT}/${id}/SKILL.zh.md`];
    if (translationZh) template.translationZh = normalizeNewlines(translationZh);
    return template;
  });
}
