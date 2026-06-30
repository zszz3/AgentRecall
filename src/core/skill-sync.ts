import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillSyncBinding } from "./session-store";
import type { InstalledSkill } from "./skill-manager";

export const AGENT_SESSION_SEARCH_SKILLS_TABLE = "agent_session_search_skills";
const REMOTE_SKILL_VERSION_COLUMNS =
  "id,name,description,agent,source,local_fingerprint,content_hash,uploaded_from_path,version,created_at,updated_at";

// Full row (markdown + bundled files) fetched on demand for preview/install.
export interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  agent: InstalledSkill["agent"];
  source: InstalledSkill["source"];
  markdown: string;
  localFingerprint: string;
  contentHash: string;
  uploadedFromPath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  metadata: Record<string, unknown>;
}

// Lightweight per-version row used for listing / grouping (no markdown or metadata).
export interface RemoteSkillVersion {
  id: string;
  name: string;
  description: string;
  agent: InstalledSkill["agent"];
  source: InstalledSkill["source"];
  localFingerprint: string;
  contentHash: string;
  uploadedFromPath: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// One logical skill (agent + name fingerprint) with its full version history.
export interface RemoteSkillGroup {
  fingerprint: string;
  agent: InstalledSkill["agent"];
  name: string;
  description: string;
  source: InstalledSkill["source"];
  latest: RemoteSkillVersion;
  versions: RemoteSkillVersion[];
}

export interface SkillSyncFile {
  relativePath: string;
  contentBase64: string;
  mode?: number;
}

export type SkillSyncStatus =
  | { kind: "unconfigured"; setupSql: string; message: string }
  | { kind: "ready"; setupSql: string }
  | { kind: "missing-table"; setupSql: string; message: string }
  | { kind: "error"; setupSql: string; message: string };

export interface SkillSyncSnapshot {
  status: SkillSyncStatus;
  remoteSkillGroups: RemoteSkillGroup[];
  bindings: SkillSyncBinding[];
  scannedAt: number;
}

export interface SkillSyncUploadConflict {
  name: string;
  agent: InstalledSkill["agent"];
  latestVersion: number;
  latestSource: string;
  latestPath: string;
}

export type SkillSyncUploadOutcome =
  | { status: "uploaded"; remoteSkill: RemoteSkill; binding: SkillSyncBinding; version: number }
  | { status: "skipped"; remoteSkillId: string; binding: SkillSyncBinding; version: number }
  | { status: "needs-confirmation"; conflict: SkillSyncUploadConflict };

export interface SkillSyncInstallResult {
  remoteSkill: RemoteSkill;
  binding: SkillSyncBinding;
  installedPath: string;
  overwritten: boolean;
}

export interface SupabaseSkillSyncClientOptions {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type SkillVersionBasePayload = Omit<SupabaseSkillRow, "id" | "created_at" | "updated_at" | "version">;

const DEFAULT_SKILL_SYNC_TIMEOUT_MS = 15_000;
const MAX_VERSION_CONFLICT_RETRIES = 3;

interface SupabaseSkillRow {
  id: string;
  name: string;
  description: string | null;
  agent: string;
  source: string;
  markdown: string;
  local_fingerprint: string;
  content_hash: string | null;
  uploaded_from_path: string | null;
  created_at: string;
  updated_at: string;
  version: number | null;
  metadata: Record<string, unknown> | null;
}

export class SkillVersionConflictError extends Error {
  constructor(message = "A remote skill version with this number already exists.") {
    super(message);
    this.name = "SkillVersionConflictError";
  }
}

export function buildSkillSyncSetupSql(tableName = AGENT_SESSION_SEARCH_SKILLS_TABLE): string {
  return [
    `create table if not exists public.${tableName} (`,
    "  id uuid primary key default gen_random_uuid(),",
    "  name text not null,",
    "  description text not null default '',",
    "  agent text not null check (agent in ('codex', 'claude')),",
    "  source text not null,",
    "  markdown text not null,",
    "  local_fingerprint text not null,",
    "  content_hash text not null default '',",
    "  uploaded_from_path text not null default '',",
    "  version integer not null default 1,",
    "  metadata jsonb not null default '{}'::jsonb,",
    "  created_at timestamptz not null default now(),",
    "  updated_at timestamptz not null default now()",
    ");",
    "",
    "-- Upgrade an existing table created before version history was added.",
    `alter table public.${tableName} add column if not exists content_hash text not null default '';`,
    "",
    "-- Version history keeps one row per (skill, version); drop the old one-row-per-skill unique index.",
    `drop index if exists ${tableName}_fingerprint_idx;`,
    `create unique index if not exists ${tableName}_fingerprint_version_idx`,
    `  on public.${tableName} (local_fingerprint, version);`,
    "",
    `create or replace function public.${tableName}_touch_updated_at()`,
    "returns trigger",
    "language plpgsql",
    "as $$",
    "begin",
    "  new.updated_at = now();",
    "  return new;",
    "end;",
    "$$;",
    "",
    `drop trigger if exists ${tableName}_touch_updated_at on public.${tableName};`,
    `create trigger ${tableName}_touch_updated_at`,
    `  before update on public.${tableName}`,
    "  for each row",
    `  execute function public.${tableName}_touch_updated_at();`,
    "",
    `alter table public.${tableName} enable row level security;`,
    "",
    `drop policy if exists "agent_session_search_skills_personal_sync" on public.${tableName};`,
    `create policy "agent_session_search_skills_personal_sync"`,
    `  on public.${tableName}`,
    "  for all",
    "  to anon",
    "  using (true)",
    "  with check (true);",
  ].join("\n");
}

export function skillSyncFingerprint(skill: Pick<InstalledSkill, "agent" | "name">): string {
  return createHash("sha256").update(`${skill.agent}:${skill.name.trim().toLowerCase()}`).digest("hex");
}

// Stable content hash over the SKILL.md body plus every bundled file (ordering is fixed by
// collectSkillDirectoryFiles), used to skip re-uploading a version when nothing changed.
export function skillSyncContentHash(markdown: string, files: SkillSyncFile[]): string {
  const hash = createHash("sha256");
  hash.update(markdown);
  for (const file of files) {
    hash.update("\u0000");
    hash.update(file.relativePath);
    hash.update("\u0000");
    hash.update(file.contentBase64);
    hash.update("\u0000");
    hash.update(file.mode === undefined ? "" : String(file.mode));
  }
  return hash.digest("hex");
}

export function buildSkillVersionBasePayload(skill: InstalledSkill): { base: SkillVersionBasePayload; contentHash: string } {
  const skillFiles = collectSkillDirectoryFiles(skill.directoryPath);
  const contentHash = skillSyncContentHash(skill.markdown, skillFiles);
  return {
    contentHash,
    base: {
      name: skill.name,
      description: skill.description,
      agent: skill.agent,
      source: skill.source,
      markdown: skill.markdown,
      local_fingerprint: skillSyncFingerprint(skill),
      content_hash: contentHash,
      uploaded_from_path: skill.path,
      metadata: {
        directoryPath: skill.directoryPath,
        rootPath: skill.rootPath,
        mtimeMs: skill.mtimeMs,
        skillFiles,
      },
    },
  };
}

export function groupRemoteSkillVersions(versions: RemoteSkillVersion[]): RemoteSkillGroup[] {
  const groups = new Map<string, RemoteSkillVersion[]>();
  for (const version of versions) {
    const list = groups.get(version.localFingerprint) ?? [];
    list.push(version);
    groups.set(version.localFingerprint, list);
  }
  const result: RemoteSkillGroup[] = [];
  for (const [fingerprint, list] of groups) {
    const sorted = [...list].sort((a, b) => b.version - a.version);
    const latest = sorted[0];
    result.push({
      fingerprint,
      agent: latest.agent,
      name: latest.name,
      description: latest.description,
      source: latest.source,
      latest,
      versions: sorted,
    });
  }
  return result.sort((a, b) => Date.parse(b.latest.updatedAt) - Date.parse(a.latest.updatedAt) || a.name.localeCompare(b.name));
}

export class SupabaseSkillSyncClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SupabaseSkillSyncClientOptions) {
    this.baseUrl = normalizeSupabaseUrl(options.url);
    this.anonKey = options.anonKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_SKILL_SYNC_TIMEOUT_MS;
    if (!this.baseUrl) throw new Error("Supabase URL is required.");
    if (!this.anonKey) throw new Error("Supabase anon key is required.");
  }

  async checkStatus(): Promise<SkillSyncStatus> {
    const setupSql = buildSkillSyncSetupSql();
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?select=id&limit=1`, { method: "GET" });
    if (response.ok) return { kind: "ready", setupSql };
    const body = await readResponseBody(response);
    if (isMissingTableError(response.status, body)) {
      return {
        kind: "missing-table",
        setupSql,
        message: `Supabase table ${AGENT_SESSION_SEARCH_SKILLS_TABLE} was not found.`,
      };
    }
    return { kind: "error", setupSql, message: supabaseErrorMessage(response.status, body) };
  }

  async listRemoteSkillVersions(): Promise<RemoteSkillVersion[]> {
    const response = await this.request(
      `/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?select=${REMOTE_SKILL_VERSION_COLUMNS}&order=local_fingerprint.asc,version.desc`,
      { method: "GET" },
    );
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    return parseVersionRows(body);
  }

  async getLatestSkillVersion(localFingerprint: string): Promise<RemoteSkillVersion | null> {
    const response = await this.request(
      `/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?local_fingerprint=eq.${encodeURIComponent(localFingerprint)}&select=${REMOTE_SKILL_VERSION_COLUMNS}&order=version.desc&limit=1`,
      { method: "GET" },
    );
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [version] = parseVersionRows(body);
    return version ?? null;
  }

  async getRemoteSkill(remoteSkillId: string): Promise<RemoteSkill> {
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.${encodeURIComponent(remoteSkillId)}&select=*&limit=1`, {
      method: "GET",
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [skill] = parseFullRows(body);
    if (!skill) throw new Error("Remote skill was not found.");
    return skill;
  }

  async insertSkillVersion(base: SkillVersionBasePayload, version: number): Promise<RemoteSkill> {
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}`, {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ ...base, version }),
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      if (isUniqueViolation(response.status, body)) throw new SkillVersionConflictError();
      throw new Error(supabaseErrorMessage(response.status, body));
    }
    const [remoteSkill] = parseFullRows(body);
    if (!remoteSkill) throw new Error("Supabase did not return the uploaded skill version.");
    return remoteSkill;
  }

  // Insert a new version, retrying with a freshly recomputed version number when another machine
  // grabbed the same number first (unique(local_fingerprint, version) violation).
  async uploadSkillVersion(base: SkillVersionBasePayload, startVersion: number): Promise<RemoteSkill> {
    let version = startVersion;
    for (let attempt = 0; attempt <= MAX_VERSION_CONFLICT_RETRIES; attempt += 1) {
      try {
        return await this.insertSkillVersion(base, version);
      } catch (error) {
        if (!(error instanceof SkillVersionConflictError) || attempt === MAX_VERSION_CONFLICT_RETRIES) throw error;
        const latest = await this.getLatestSkillVersion(base.local_fingerprint);
        version = (latest?.version ?? 0) + 1;
      }
    }
    throw new SkillVersionConflictError();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          apikey: this.anonKey,
          Authorization: `Bearer ${this.anonKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Supabase request timed out after ${Math.round(this.timeoutMs / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseFullRows(body: unknown): RemoteSkill[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isFullRow(row) ? [fullSkillFromRow(row)] : []));
}

function parseVersionRows(body: unknown): RemoteSkillVersion[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isVersionRow(row) ? [versionFromRow(row)] : []));
}

function isVersionRow(value: unknown): value is SupabaseSkillRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SupabaseSkillRow>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    (row.agent === "codex" || row.agent === "claude") &&
    typeof row.source === "string" &&
    typeof row.local_fingerprint === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function isFullRow(value: unknown): value is SupabaseSkillRow {
  return isVersionRow(value) && typeof (value as Partial<SupabaseSkillRow>).markdown === "string";
}

function versionFromRow(row: SupabaseSkillRow): RemoteSkillVersion {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    agent: row.agent as RemoteSkillVersion["agent"],
    source: row.source as RemoteSkillVersion["source"],
    localFingerprint: row.local_fingerprint,
    contentHash: row.content_hash ?? "",
    uploadedFromPath: row.uploaded_from_path ?? "",
    version: row.version ?? 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fullSkillFromRow(row: SupabaseSkillRow): RemoteSkill {
  return {
    ...versionFromRow(row),
    markdown: row.markdown,
    metadata: row.metadata ?? {},
  };
}

export function skillSyncFilesFromMetadata(metadata: Record<string, unknown>): SkillSyncFile[] {
  const value = metadata.skillFiles;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const file = item as Partial<SkillSyncFile>;
    if (typeof file.relativePath !== "string" || typeof file.contentBase64 !== "string") return [];
    const mode = typeof file.mode === "number" && Number.isFinite(file.mode) ? file.mode : undefined;
    return [{ relativePath: file.relativePath, contentBase64: file.contentBase64, ...(mode === undefined ? {} : { mode }) }];
  });
}

function collectSkillDirectoryFiles(directoryPath: string): SkillSyncFile[] {
  const root = path.resolve(directoryPath);
  const files: SkillSyncFile[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(filePath);
      files.push({
        relativePath: path.relative(root, filePath).split(path.sep).join("/"),
        contentBase64: fs.readFileSync(filePath).toString("base64"),
        mode: stat.mode & 0o777,
      });
    }
  };
  visit(root);
  return files;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function supabaseErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof body === "string" && body.trim()) return body;
  return `Supabase request failed with status ${status}.`;
}

function isMissingTableError(status: number, body: unknown): boolean {
  if (status === 404) return true;
  if (!body || typeof body !== "object") return false;
  const code = (body as { code?: unknown }).code;
  const message = (body as { message?: unknown }).message;
  return (
    code === "42P01" ||
    code === "PGRST205" ||
    (typeof message === "string" && /table|relation/i.test(message) && /not found|does not exist/i.test(message))
  );
}

function isUniqueViolation(status: number, body: unknown): boolean {
  if (status === 409) return true;
  if (!body || typeof body !== "object") return false;
  return (body as { code?: unknown }).code === "23505";
}

function normalizeSupabaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
