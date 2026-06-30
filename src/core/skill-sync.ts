import { createHash } from "node:crypto";
import type { SkillSyncBinding } from "./session-store";
import type { InstalledSkill } from "./skill-manager";

export const AGENT_SESSION_SEARCH_SKILLS_TABLE = "agent_session_search_skills";

export interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  agent: InstalledSkill["agent"];
  source: InstalledSkill["source"];
  markdown: string;
  localFingerprint: string;
  uploadedFromPath: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  metadata: Record<string, unknown>;
}

export type SkillSyncStatus =
  | { kind: "unconfigured"; setupSql: string; message: string }
  | { kind: "ready"; setupSql: string }
  | { kind: "missing-table"; setupSql: string; message: string }
  | { kind: "error"; setupSql: string; message: string };

export interface SkillSyncSnapshot {
  status: SkillSyncStatus;
  remoteSkills: RemoteSkill[];
  bindings: SkillSyncBinding[];
  scannedAt: number;
}

export interface SkillSyncUploadResult {
  remoteSkill: RemoteSkill;
  binding: SkillSyncBinding;
}

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
}

interface SupabaseSkillRow {
  id: string;
  name: string;
  description: string | null;
  agent: string;
  source: string;
  markdown: string;
  local_fingerprint: string;
  uploaded_from_path: string | null;
  created_at: string;
  updated_at: string;
  version: number | null;
  metadata: Record<string, unknown> | null;
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
    "  uploaded_from_path text not null default '',",
    "  version integer not null default 1,",
    "  metadata jsonb not null default '{}'::jsonb,",
    "  created_at timestamptz not null default now(),",
    "  updated_at timestamptz not null default now()",
    ");",
    "",
    `create unique index if not exists ${tableName}_fingerprint_idx`,
    `  on public.${tableName} (local_fingerprint);`,
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

export class SupabaseSkillSyncClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SupabaseSkillSyncClientOptions) {
    this.baseUrl = normalizeSupabaseUrl(options.url);
    this.anonKey = options.anonKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
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

  async listRemoteSkills(): Promise<RemoteSkill[]> {
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?select=*&order=updated_at.desc`, { method: "GET" });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    return parseRemoteRows(body);
  }

  async getRemoteSkill(remoteSkillId: string): Promise<RemoteSkill> {
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.${encodeURIComponent(remoteSkillId)}&select=*&limit=1`, {
      method: "GET",
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [skill] = parseRemoteRows(body);
    if (!skill) throw new Error("Remote skill was not found.");
    return skill;
  }

  async upsertLocalSkill(skill: InstalledSkill): Promise<RemoteSkill> {
    const payload = remotePayloadFromSkill(skill);
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?on_conflict=local_fingerprint`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [remoteSkill] = parseRemoteRows(body);
    if (!remoteSkill) throw new Error("Supabase did not return the uploaded skill.");
    return remoteSkill;
  }

  async updateRemoteSkill(remoteSkillId: string, skill: InstalledSkill): Promise<RemoteSkill> {
    const response = await this.request(`/${AGENT_SESSION_SEARCH_SKILLS_TABLE}?id=eq.${encodeURIComponent(remoteSkillId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(remotePayloadFromSkill(skill)),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const [remoteSkill] = parseRemoteRows(body);
    if (!remoteSkill) throw new Error("Supabase did not return the updated skill.");
    return remoteSkill;
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }
}

function remotePayloadFromSkill(skill: InstalledSkill): Omit<SupabaseSkillRow, "id" | "created_at" | "updated_at"> {
  return {
    name: skill.name,
    description: skill.description,
    agent: skill.agent,
    source: skill.source,
    markdown: skill.markdown,
    local_fingerprint: skillSyncFingerprint(skill),
    uploaded_from_path: skill.path,
    version: 1,
    metadata: {
      directoryPath: skill.directoryPath,
      rootPath: skill.rootPath,
      mtimeMs: skill.mtimeMs,
    },
  };
}

function parseRemoteRows(body: unknown): RemoteSkill[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isRemoteRow(row) ? [remoteSkillFromRow(row)] : []));
}

function isRemoteRow(value: unknown): value is SupabaseSkillRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SupabaseSkillRow>;
  return (
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.agent === "string" &&
    (row.agent === "codex" || row.agent === "claude") &&
    typeof row.source === "string" &&
    typeof row.markdown === "string" &&
    typeof row.local_fingerprint === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function remoteSkillFromRow(row: SupabaseSkillRow): RemoteSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    agent: row.agent as RemoteSkill["agent"],
    source: row.source as RemoteSkill["source"],
    markdown: row.markdown,
    localFingerprint: row.local_fingerprint,
    uploadedFromPath: row.uploaded_from_path ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version ?? 1,
    metadata: row.metadata ?? {},
  };
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

function normalizeSupabaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
