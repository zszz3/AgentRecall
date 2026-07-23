import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { assetIdentity } from "./asset-identity";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoriesAgent = "qoder" | "codex";
export type MemoriesScope = "global" | "project";

export interface AgentMemory {
  agent: MemoriesAgent;
  scope: MemoriesScope;
  /** category/filename.md — e.g. "user_info/用户GitHub账号.md" */
  name: string;
  category: string;
  content: string;
  contentHash: string;
  /** project slug for project-scope memories, empty for global */
  projectPath: string;
  filePath: string;
}

export interface RemoteMemory {
  id: string;
  agent: string;
  scope: string;
  name: string;
  category: string;
  content: string;
  content_hash: string;
  project_path: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type MemoriesSyncStatusKind = "ready" | "missing-table" | "error" | "unconfigured";

export interface MemoriesSyncStatus {
  kind: MemoriesSyncStatusKind;
  setupSql: string;
  remediation?: "sql" | "settings";
  message?: string;
}

export interface MemoriesSyncSnapshot {
  status: MemoriesSyncStatus;
  localMemories: AgentMemory[];
  remoteMemories: RemoteMemory[];
  scannedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_RECALL_MEMORIES_TABLE = "agent_recall_memories";
const DEFAULT_MEMORIES_SYNC_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Local scanner
// ---------------------------------------------------------------------------

export interface ScanLocalMemoriesOptions {
  homeDir?: string;
}

/**
 * Scans `~/.qoder/memories/<user-id>/` for all memory markdown files,
 * and `~/.codex/memories_1.sqlite` for Codex stage1_outputs.
 * The user-id directory layer is device-specific and ignored for identity purposes.
 */
export function scanLocalMemories(options: ScanLocalMemoriesOptions = {}): AgentMemory[] {
  const homeDir = options.homeDir ?? os.homedir();
  const memories: AgentMemory[] = [];

  // Qoder markdown memories
  scanQoderMemories(homeDir, memories);

  // Codex SQLite memories
  scanCodexMemories(homeDir, memories);

  return memories;
}

function scanQoderMemories(homeDir: string, memories: AgentMemory[]): void {
  const memoriesRoot = path.join(homeDir, ".qoder", "memories");
  if (!fs.existsSync(memoriesRoot)) return;

  let userDirs: fs.Dirent[];
  try {
    userDirs = fs.readdirSync(memoriesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }

  for (const userDir of userDirs) {
    const userDirPath = path.join(memoriesRoot, userDir.name);

    // Global memories: <user-id>/global/<category>/<file>.md
    const globalDir = path.join(userDirPath, "global");
    if (fs.existsSync(globalDir)) {
      scanCategoryDir(globalDir, "qoder", "global", "", memories);
    }

    // Project memories: <user-id>/projects/<slug>/<category>/<file>.md
    const projectsDir = path.join(userDirPath, "projects");
    if (fs.existsSync(projectsDir)) {
      let projectDirs: fs.Dirent[];
      try {
        projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const projectDir of projectDirs) {
        const projectPath = path.join(projectsDir, projectDir.name);
        scanCategoryDir(projectPath, "qoder", "project", projectDir.name, memories);
      }
    }
  }
}

/**
 * Reads Codex memories from `~/.codex/memories_1.sqlite` (stage1_outputs table).
 * Each row maps a thread_id to a raw_memory text extracted from conversations.
 */
function scanCodexMemories(homeDir: string, memories: AgentMemory[]): void {
  const dbPath = path.join(homeDir, ".codex", "memories_1.sqlite");
  if (!fs.existsSync(dbPath)) return;

  try {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT thread_id, raw_memory, rollout_summary, rollout_slug, generated_at FROM stage1_outputs").all() as Array<{
        thread_id: string;
        raw_memory: string;
        rollout_summary: string;
        rollout_slug: string | null;
        generated_at: number;
      }>;
      for (const row of rows) {
        const content = row.raw_memory?.trim();
        if (!content) continue;
        const name = row.rollout_slug || row.thread_id;
        memories.push({
          agent: "codex",
          scope: "global",
          name,
          category: "stage1",
          content,
          contentHash: sha256(content),
          projectPath: "",
          filePath: dbPath,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // Ignore unreadable or missing Codex memories database.
  }
}

function scanCategoryDir(baseDir: string, agent: MemoriesAgent, scope: MemoriesScope, projectPath: string, out: AgentMemory[]): void {
  let categories: fs.Dirent[];
  try {
    categories = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
  for (const categoryDir of categories) {
    const categoryPath = path.join(baseDir, categoryDir.name);
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(categoryPath, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(categoryPath, file.name);
      const memory = readMemoryFile(filePath, agent, scope, categoryDir.name, file.name, projectPath);
      if (memory) out.push(memory);
    }
  }
}

function readMemoryFile(filePath: string, agent: MemoriesAgent, scope: MemoriesScope, category: string, fileName: string, projectPath: string): AgentMemory | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return null;
    return {
      agent,
      scope,
      name: `${category}/${fileName}`,
      category,
      content,
      contentHash: sha256(content),
      projectPath,
      filePath,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Memory identity (for matching local ↔ remote)
// ---------------------------------------------------------------------------

export function memoryIdentity(memory: Pick<AgentMemory, "agent" | "scope" | "name" | "projectPath">): string {
  return assetIdentity(memory);
}

// ---------------------------------------------------------------------------
// Setup SQL
// ---------------------------------------------------------------------------

export function buildMemoriesSyncSetupSql(tableName = AGENT_RECALL_MEMORIES_TABLE): string {
  return [
    `create table if not exists public.${tableName} (`,
    "  id uuid primary key default gen_random_uuid(),",
    "  agent text not null check (agent in ('qoder', 'codex')),",
    "  scope text not null check (scope in ('global', 'project')),",
    "  name text not null,",
    "  category text not null default '',",
    "  content text not null,",
    "  content_hash text not null default '',",
    "  project_path text not null default '',",
    "  version integer not null default 1,",
    "  created_at timestamptz not null default now(),",
    "  updated_at timestamptz not null default now()",
    ");",
    "",
    `create unique index if not exists ${tableName}_identity_idx`,
    `  on public.${tableName} (agent, scope, name, project_path);`,
    "",
    `alter table public.${tableName} enable row level security;`,
    "",
    `create policy "${tableName}_anon_all" on public.${tableName}`,
    "  for all to anon using (true) with check (true);",
    "",
    `grant select, insert, update, delete on table public.${tableName} to anon;`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

export interface SupabaseMemoriesSyncClientOptions {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MEMORIES_SYNC_COLUMNS = "id,agent,scope,name,category,content,content_hash,project_path,version,created_at,updated_at";

export class SupabaseMemoriesSyncClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SupabaseMemoriesSyncClientOptions) {
    this.baseUrl = normalizeSupabaseUrl(options.url);
    this.anonKey = options.anonKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_MEMORIES_SYNC_TIMEOUT_MS;
    if (!this.baseUrl) throw new Error("Supabase URL is required.");
    if (!this.anonKey) throw new Error("Supabase anon key is required.");
  }

  async checkStatus(): Promise<MemoriesSyncStatus> {
    const setupSql = buildMemoriesSyncSetupSql();
    try {
      const response = await this.restRequest(`/${AGENT_RECALL_MEMORIES_TABLE}?select=id&limit=1`, { method: "GET" });
      if (response.ok) return { kind: "ready", setupSql };
      const body = await readResponseBody(response);
      if (isMissingTableError(response.status, body)) {
        return { kind: "missing-table", setupSql, remediation: "sql", message: `Supabase table ${AGENT_RECALL_MEMORIES_TABLE} was not found.` };
      }
      return { kind: "error", setupSql, remediation: "sql", message: supabaseErrorMessage(response.status, body) };
    } catch (error) {
      return { kind: "error", setupSql, remediation: "settings", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listRemoteMemories(): Promise<RemoteMemory[]> {
    const { body } = await this.selectRows(`order=updated_at.desc`);
    return parseMemoryRows(body);
  }

  async uploadMemory(memory: AgentMemory): Promise<RemoteMemory> {
    const payload = {
      agent: memory.agent,
      scope: memory.scope,
      name: memory.name,
      category: memory.category,
      content: memory.content,
      content_hash: memory.contentHash,
      project_path: memory.projectPath,
    };
    const response = await this.restRequest(`/${AGENT_RECALL_MEMORIES_TABLE}?on_conflict=agent,scope,name,project_path`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const rows = parseMemoryRows(body);
    if (rows.length === 0) throw new Error("Supabase did not return the uploaded memory.");
    return rows[0];
  }

  async deleteMemory(remoteId: string): Promise<boolean> {
    const response = await this.restRequest(`/${AGENT_RECALL_MEMORIES_TABLE}?id=eq.${encodeURIComponent(remoteId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(supabaseErrorMessage(response.status, body));
    }
    return true;
  }

  private async selectRows(query: string): Promise<{ body: unknown }> {
    const response = await this.restRequest(`/${AGENT_RECALL_MEMORIES_TABLE}?select=${MEMORIES_SYNC_COLUMNS}&${query}`, { method: "GET" });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    return { body };
  }

  private async restRequest(path: string, init: RequestInit): Promise<Response> {
    return this.authenticatedRequest(`${this.baseUrl}/rest/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private async authenticatedRequest(url: string, init: RequestInit): Promise<Response> {
    return this.request(url, {
      ...init,
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.anonKey}`,
        ...(init.headers ?? {}),
      },
    });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSupabaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
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
  if (status !== 404 && status !== 400) return false;
  const message = typeof body === "string" ? body : (body as { message?: string })?.message ?? "";
  return /does not exist|could not find the table|relation/i.test(message);
}

function parseMemoryRows(body: unknown): RemoteMemory[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isMemoryRow(row) ? [row] : []));
}

function isMemoryRow(value: unknown): value is RemoteMemory {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RemoteMemory>;
  return (
    typeof row.id === "string" &&
    typeof row.agent === "string" &&
    typeof row.scope === "string" &&
    typeof row.name === "string" &&
    typeof row.content === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
