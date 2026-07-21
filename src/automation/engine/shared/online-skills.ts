import type { SkillTemplate } from "./types";

export interface OnlineSkillSource {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  basePath?: string;
  homepage?: string;
  maxFetch?: number;
}

export interface OnlineSkillResult extends SkillTemplate {
  sourceId: string;
  sourceLabel: string;
  path: string;
  url: string;
  rawUrl: string;
  repositoryUrl?: string;
  repositoryStars?: number;
  installs?: number;
  installCommand?: string;
  contentLabel?: string;
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  prompt: string;
  tags: string[];
  path: string;
}

export const ONLINE_SKILL_SOURCES: OnlineSkillSource[] = [
  {
    id: "openai-skills",
    label: "OpenAI Skills",
    owner: "openai",
    repo: "skills",
    branch: "main",
    basePath: "skills",
    homepage: "https://github.com/openai/skills",
    maxFetch: 80,
  },
  {
    id: "anthropic-skills",
    label: "Anthropic Skills",
    owner: "anthropics",
    repo: "skills",
    branch: "main",
    homepage: "https://github.com/anthropics/skills",
    maxFetch: 80,
  },
];

export const SKILLS_SH_SOURCE = {
  id: "skills-sh",
  label: "skills.sh Find",
  homepage: "https://www.skills.sh",
  apiBase: "https://skills.sh",
};

const GITHUB_SEARCH_SOURCE = {
  id: "github-search",
  label: "GitHub Search",
};

export function onlineSkillTreeUrl(source: OnlineSkillSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${source.branch}?recursive=1`;
}

function onlineSkillRepositoryApiUrl(source: OnlineSkillSource): string {
  return `https://api.github.com/repos/${source.owner}/${source.repo}`;
}

function onlineSkillBlobUrl(source: OnlineSkillSource, path: string): string {
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.branch}/${path}`;
}

function onlineSkillRawUrl(source: OnlineSkillSource, path: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.branch}/${path}`;
}

export function skillsShSearchUrl(query: string, limit = 10): string {
  return `${SKILLS_SH_SOURCE.apiBase}/api/search?q=${encodeURIComponent(query.trim())}&limit=${limit}`;
}

function githubRepositorySearchUrl(query: string, limit = 10): string {
  const terms = skillMatchTerms(query);
  const searchText = terms.length > 0 ? terms.join(" ") : query.trim();
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(`${searchText} skill`)}&sort=stars&order=desc&per_page=${limit}`;
}

interface SkillsShApiSkill {
  id?: unknown;
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
  source?: unknown;
}

interface GitHubRepositorySearchItem {
  full_name?: unknown;
  description?: unknown;
  html_url?: unknown;
  stargazers_count?: unknown;
  default_branch?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return String(value);
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function skillNameFromPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2]! : path.replace(/\/?SKILL\.md$/i, "");
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "to",
  "for",
  "of",
  "with",
  "skill",
  "skills",
  "install",
  "download",
  "find",
  "add",
  "npx",
]);

const PROVIDER_TOKENS = new Set(["anthropic", "anthropics", "claude", "openai", "chatgpt"]);

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function queryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const tokens: string[] = lower.match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
  if (/前端|界面|网页|网站/i.test(query)) tokens.push("frontend", "ui", "web");
  if (/设计|视觉/i.test(query)) tokens.push("design");
  if (/(^|[^a-z])a\s*那家|anthropic|anthropics|claude|克劳德/i.test(query)) tokens.push("anthropic");
  if (/openai|chatgpt|\bgpt\b/i.test(query)) tokens.push("openai");
  return uniqueValues(tokens.map((token) => token.trim().replace(/^-+|-+$/g, "")).filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token)));
}

function skillMatchTerms(query: string): string[] {
  return queryTokens(query).filter((token) => !PROVIDER_TOKENS.has(token));
}

function providerPreference(query: string): "anthropic" | "openai" | undefined {
  const tokens = queryTokens(query);
  if (tokens.some((token) => token === "anthropic" || token === "anthropics" || token === "claude")) return "anthropic";
  if (tokens.some((token) => token === "openai" || token === "chatgpt")) return "openai";
  return undefined;
}

function skillNameHints(query: string): string[] {
  const hints: string[] = [];
  if (/(前端|frontend|front-end)/i.test(query) && /(设计|design)/i.test(query)) hints.push("frontend-design");
  return hints;
}

function scoreTextForTerms(text: string, terms: string[]): number {
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function onlineSkillMatches(skill: ParsedSkillMarkdown, query: string): boolean {
  const terms = skillMatchTerms(query);
  if (terms.length === 0) return true;
  return scoreTextForTerms([skill.name, skill.description, skill.prompt, skill.path, ...skill.tags].join("\n"), terms) > 0;
}

function skillsShWebUrl(id: string): string {
  return `${SKILLS_SH_SOURCE.homepage}/${id.split("/").map(encodeURIComponent).join("/")}`;
}

function skillsShInstallCommand(source: string, name: string): string {
  return `npx skills add ${source}@${name}`;
}

function skillsShPrompt(name: string, source: string, installs: number | undefined, url: string, installCommand: string): string {
  const lines = [
    `# ${name}`,
    "",
    "## Registry profile",
    `- Source: ${SKILLS_SH_SOURCE.label}`,
    `- Package: ${source}@${name}`,
    installs !== undefined ? `- Installs: ${installs}` : undefined,
    `- Directory: ${url}`,
    `- Install: \`${installCommand}\``,
    "",
    "## Review note",
    "skills.sh search returns registry metadata, not the original SKILL.md content. Open the source before installing or copying files locally.",
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export function skillFrontmatterValue(markdown: string, key: string): string | undefined {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const frontmatter = normalized.slice(4, end).split("\n");
  const normalizedKey = key.toLowerCase();
  for (const line of frontmatter) {
    if (/^\s/.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match?.[1]?.toLowerCase() === normalizedKey) return stripYamlQuotes(match[2] ?? "");
  }
  return undefined;
}

export function parseSkillMarkdown(markdown: string, path: string): ParsedSkillMarkdown {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const fields: Record<string, string> = {};
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end >= 0) {
      const frontmatter = normalized.slice(4, end).split("\n");
      for (const line of frontmatter) {
        if (/^\s/.test(line)) continue;
        const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (match) fields[match[1]!.toLowerCase()] = stripYamlQuotes(match[2] ?? "");
      }
      body = normalized.slice(end + 4).trim();
    }
  }

  const fallbackName = skillNameFromPath(path);
  const name = fields.name || fallbackName;
  const description = fields.description || body.split("\n").find((line) => line.trim() && !line.trim().startsWith("#"))?.trim() || "";
  return {
    name,
    description,
    prompt: normalized.trim(),
    tags: [name],
    path,
  };
}

export function skillsShResultFromApiSkill(skill: SkillsShApiSkill): OnlineSkillResult | undefined {
  const id = stringValue(skill.id);
  const name = stringValue(skill.name) ?? stringValue(skill.skillId);
  const source = stringValue(skill.source);
  if (!id || !name || !source) return undefined;
  const installs = numberValue(skill.installs);
  const installCommand = skillsShInstallCommand(source, name);
  const url = skillsShWebUrl(id);
  const installSummary = installs !== undefined ? `${formatCompactNumber(installs)} installs` : "Install with npx skills";
  const result: OnlineSkillResult = {
    id: `${SKILLS_SH_SOURCE.id}:${id}`,
    name,
    description: `${installSummary} · ${source}`,
    prompt: skillsShPrompt(name, source, installs, url, installCommand),
    tags: ["skills.sh", source],
    sourceId: SKILLS_SH_SOURCE.id,
    sourceLabel: SKILLS_SH_SOURCE.label,
    sourceUrl: url,
    path: id,
    sourcePath: id,
    url,
    rawUrl: url,
    repositoryUrl: `https://github.com/${source}`,
    installCommand,
    contentLabel: "skills.sh result",
  };
  if (installs !== undefined) result.installs = installs;
  return result;
}

async function fetchRepositoryStars(source: OnlineSkillSource, fetcher: typeof fetch): Promise<number | undefined> {
  try {
    const response = await fetcher(onlineSkillRepositoryApiUrl(source), { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) return undefined;
    const payload = objectValue(await response.json());
    return numberValue(payload.stargazers_count);
  } catch {
    return undefined;
  }
}

function resultMatchesProvider(skill: OnlineSkillResult, provider: "anthropic" | "openai"): boolean {
  const haystack = [skill.sourceId, skill.sourceLabel, skill.sourcePath, skill.path, skill.repositoryUrl, skill.url, ...skill.tags].join("\n").toLowerCase();
  return provider === "anthropic" ? /anthropic|anthropics|claude/.test(haystack) : /openai|chatgpt/.test(haystack);
}

function scoreOnlineSkillResult(skill: OnlineSkillResult, query: string): number {
  const terms = skillMatchTerms(query);
  const nameHints = skillNameHints(query);
  const provider = providerPreference(query);
  const name = skill.name.toLowerCase();
  const path = skill.path.toLowerCase();
  const description = skill.description.toLowerCase();
  const fullText = [skill.prompt, ...skill.tags].join("\n").toLowerCase();
  let score = skill.sourceId === SKILLS_SH_SOURCE.id ? 0 : skill.sourceId === GITHUB_SEARCH_SOURCE.id ? 1 : 2;
  if (provider && resultMatchesProvider(skill, provider)) score += 100;
  if (nameHints.some((hint) => name === hint || path.includes(`/${hint}/`) || path.includes(`/${hint}.`))) score += 80;
  if (skill.repositoryStars !== undefined) score += Math.min(35, Math.log10(skill.repositoryStars + 1) * 7);
  if (skill.installs !== undefined) score += Math.min(12, Math.log10(skill.installs + 1) * 3);
  for (const term of terms) {
    if (name === term || name === term.replace(/\s+/g, "-")) score += 12;
    if (name.includes(term)) score += 6;
    if (path.includes(term)) score += 5;
    if (description.includes(term)) score += 3;
    if (fullText.includes(term)) score += 1;
  }
  if (terms.length > 0 && terms.every((term) => name.includes(term) || path.includes(term))) score += 10;
  return score;
}

function rankOnlineSkillResults(skills: OnlineSkillResult[], query: string): OnlineSkillResult[] {
  return skills
    .map((skill, index) => ({ skill, index, score: scoreOnlineSkillResult(skill, query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ skill }) => skill);
}

function skillsShResultsFromPayload(payload: unknown): OnlineSkillResult[] {
  const record = objectValue(payload);
  if (!Array.isArray(record.skills)) return [];
  return record.skills
    .map((item) => skillsShResultFromApiSkill(objectValue(item) as SkillsShApiSkill))
    .filter((skill): skill is OnlineSkillResult => Boolean(skill));
}

async function fetchSkillsShFindResults(query: string, fetcher: typeof fetch = fetch): Promise<OnlineSkillResult[]> {
  if (!query.trim()) return [];
  const response = await fetcher(skillsShSearchUrl(query), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${SKILLS_SH_SOURCE.label}: ${response.status}`);
  return skillsShResultsFromPayload(await response.json());
}

function githubRepositoryTreeUrl(fullName: string, branch: string): string {
  return `https://api.github.com/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
}

function githubRepositoryBlobUrl(fullName: string, branch: string, filePath: string): string {
  return `https://github.com/${fullName}/blob/${branch}/${filePath}`;
}

function githubRepositoryRawUrl(fullName: string, branch: string, filePath: string): string {
  return `https://raw.githubusercontent.com/${fullName}/${branch}/${filePath}`;
}

function githubRepositorySearchItems(payload: unknown): GitHubRepositorySearchItem[] {
  const record = objectValue(payload);
  if (!Array.isArray(record.items)) return [];
  return record.items.map((item) => objectValue(item) as GitHubRepositorySearchItem);
}

async function fetchGitHubRepositorySkillResults(query: string, fetcher: typeof fetch = fetch): Promise<OnlineSkillResult[]> {
  if (!query.trim()) return [];
  const response = await fetcher(githubRepositorySearchUrl(query), { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(`${GITHUB_SEARCH_SOURCE.label}: ${response.status}`);
  const repos = githubRepositorySearchItems(await response.json()).slice(0, 10);
  const matchTerms = skillMatchTerms(query);
  const results = await Promise.all(
    repos.map(async (repo) => {
      const fullName = stringValue(repo.full_name);
      if (!fullName) return [];
      const branch = stringValue(repo.default_branch) ?? "main";
      const repositoryUrl = stringValue(repo.html_url) ?? `https://github.com/${fullName}`;
      const repositoryStars = numberValue(repo.stargazers_count);
      try {
        const treeResponse = await fetcher(githubRepositoryTreeUrl(fullName, branch), { headers: { Accept: "application/vnd.github+json" } });
        if (!treeResponse.ok) return [];
        const treePayload = (await treeResponse.json()) as { tree?: Array<{ path?: string; type?: string }> };
        const skillPaths = (treePayload.tree ?? [])
          .map((item) => item.path ?? "")
          .filter((path) => path.endsWith("/SKILL.md") || path === "SKILL.md")
          .map((path, index) => ({ path, index, score: scoreTextForTerms(path, matchTerms) }))
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .map(({ path }) => path)
          .slice(0, 3);
        const parsed = await Promise.all(
          skillPaths.map(async (filePath) => {
            const rawUrl = githubRepositoryRawUrl(fullName, branch, filePath);
            const rawResponse = await fetcher(rawUrl);
            if (!rawResponse.ok) return undefined;
            const skill = parseSkillMarkdown(await rawResponse.text(), filePath);
            if (!onlineSkillMatches(skill, query)) return undefined;
            const result: OnlineSkillResult = {
              id: `${GITHUB_SEARCH_SOURCE.id}:${fullName}:${filePath}`,
              name: skill.name,
              description: skill.description || stringValue(repo.description) || "",
              prompt: skill.prompt,
              tags: [...skill.tags, fullName],
              sourceId: GITHUB_SEARCH_SOURCE.id,
              sourceLabel: GITHUB_SEARCH_SOURCE.label,
              path: `${fullName}/${filePath}`,
              sourcePath: `${fullName}/${filePath}`,
              url: githubRepositoryBlobUrl(fullName, branch, filePath),
              sourceUrl: githubRepositoryBlobUrl(fullName, branch, filePath),
              rawUrl,
              repositoryUrl,
              contentLabel: "SKILL.md",
            };
            if (repositoryStars !== undefined) result.repositoryStars = repositoryStars;
            return result;
          }),
        );
        return parsed.filter((skill): skill is OnlineSkillResult => Boolean(skill));
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

export async function fetchOnlineSkills(query: string, sources: OnlineSkillSource[] = [], fetcher: typeof fetch = fetch): Promise<OnlineSkillResult[]> {
  const normalizedQuery = query.trim().toLowerCase();
  const failures: string[] = [];
  let registryResults: OnlineSkillResult[] = [];
  try {
    registryResults = await fetchSkillsShFindResults(query, fetcher);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  let githubResults: OnlineSkillResult[] = [];
  try {
    githubResults = await fetchGitHubRepositorySkillResults(query, fetcher);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const results = await Promise.all(
    sources.map(async (source) => {
      try {
        const repositoryStars = await fetchRepositoryStars(source, fetcher);
        const treeResponse = await fetcher(onlineSkillTreeUrl(source), { headers: { Accept: "application/vnd.github+json" } });
        if (!treeResponse.ok) throw new Error(`${source.label}: ${treeResponse.status}`);
        const treePayload = (await treeResponse.json()) as { tree?: Array<{ path?: string; type?: string }> };
        const skillPaths = (treePayload.tree ?? [])
          .map((item) => item.path ?? "")
          .filter((path) => path.endsWith("/SKILL.md") || path === "SKILL.md")
          .filter((path) => !source.basePath || path === source.basePath || path.startsWith(`${source.basePath}/`));
        const matchTerms = skillMatchTerms(normalizedQuery);
        const candidates = skillPaths
          .map((path, index) => ({ path, index, score: scoreTextForTerms(path, matchTerms) }))
          .sort((left, right) => right.score - left.score || left.index - right.index)
          .map(({ path }) => path)
          .slice(0, source.maxFetch ?? 60);
        const parsed = await Promise.all(
          candidates.map(async (path) => {
            const rawUrl = onlineSkillRawUrl(source, path);
            const rawResponse = await fetcher(rawUrl);
            if (!rawResponse.ok) return undefined;
            const skill = parseSkillMarkdown(await rawResponse.text(), path);
            if (!onlineSkillMatches(skill, query)) return undefined;
            const result: OnlineSkillResult = {
              id: `${source.id}:${path}`,
              name: skill.name,
              description: skill.description,
              prompt: skill.prompt,
              tags: skill.tags,
              sourceId: source.id,
              sourceLabel: source.label,
              path,
              url: onlineSkillBlobUrl(source, path),
              rawUrl,
              sourcePath: path,
              sourceUrl: onlineSkillBlobUrl(source, path),
              repositoryUrl: source.homepage ?? `https://github.com/${source.owner}/${source.repo}`,
              contentLabel: "SKILL.md",
            };
            if (repositoryStars !== undefined) result.repositoryStars = repositoryStars;
            return result;
          }),
        );
        return parsed.filter((skill): skill is OnlineSkillResult => Boolean(skill));
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return [];
      }
    }),
  );
  const merged = [...registryResults, ...githubResults, ...results.flat()];
  if (merged.length === 0 && failures.length > 0) throw new Error(failures.join("; "));
  return rankOnlineSkillResults(merged, query).slice(0, 80);
}
