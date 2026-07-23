import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assetIdentity } from "./asset-identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RulesAgent = "claude" | "qoder";
export type RulesScope = "global" | "project";

export interface AgentRule {
  agent: RulesAgent;
  scope: RulesScope;
  name: string;
  content: string;
  contentHash: string;
  projectPath: string;
  filePath: string;
}

export interface RemoteRule {
  id: string;
  agent: string;
  scope: string;
  name: string;
  content: string;
  content_hash: string;
  project_path: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type RulesSyncStatusKind = "ready" | "missing-table" | "error" | "unconfigured";

export interface RulesSyncStatus {
  kind: RulesSyncStatusKind;
  setupSql: string;
  remediation?: "sql" | "settings";
  message?: string;
}

export interface RulesSyncSnapshot {
  status: RulesSyncStatus;
  localRules: AgentRule[];
  remoteRules: RemoteRule[];
  scannedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_RECALL_RULES_TABLE = "agent_recall_rules";
const DEFAULT_RULES_SYNC_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Local scanner
// ---------------------------------------------------------------------------

export interface ScanLocalRulesOptions {
  homeDir?: string;
  projectDirs?: string[];
}

export function scanLocalRules(options: ScanLocalRulesOptions = {}): AgentRule[] {
  const homeDir = options.homeDir ?? os.homedir();
  const projectDirs = options.projectDirs ?? [];
  const rules: AgentRule[] = [];

  // Claude global CLAUDE.md
  const claudeGlobalPath = path.join(homeDir, ".claude", "CLAUDE.md");
  const claudeGlobal = readRuleFile(claudeGlobalPath, "claude", "global", "CLAUDE.md", "");
  if (claudeGlobal) rules.push(claudeGlobal);

  // Per-project rules
  for (const projectDir of projectDirs) {
    const projectBasename = path.basename(projectDir);

    // Project-level CLAUDE.md
    const claudeProjectPath = path.join(projectDir, "CLAUDE.md");
    const claudeProject = readRuleFile(claudeProjectPath, "claude", "project", "CLAUDE.md", projectBasename);
    if (claudeProject) rules.push(claudeProject);

    // Qoder project rules: .qoder/rules/*.md
    const qoderRulesDir = path.join(projectDir, ".qoder", "rules");
    if (fs.existsSync(qoderRulesDir)) {
      try {
        for (const entry of fs.readdirSync(qoderRulesDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const filePath = path.join(qoderRulesDir, entry.name);
          const rule = readRuleFile(filePath, "qoder", "project", entry.name, projectBasename);
          if (rule) rules.push(rule);
        }
      } catch {
        // Ignore unreadable rules directories.
      }
    }
  }

  return rules;
}

function readRuleFile(filePath: string, agent: RulesAgent, scope: RulesScope, name: string, projectPath: string): AgentRule | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return null;
    return {
      agent,
      scope,
      name,
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
// Rule identity (for matching local ↔ remote)
// ---------------------------------------------------------------------------

export function ruleIdentity(rule: Pick<AgentRule, "agent" | "scope" | "name" | "projectPath">): string {
  return assetIdentity(rule);
}

// ---------------------------------------------------------------------------
// Setup SQL
// ---------------------------------------------------------------------------

export function buildRulesSyncSetupSql(tableName = AGENT_RECALL_RULES_TABLE): string {
  return [
    `create table if not exists public.${tableName} (`,
    "  id uuid primary key default gen_random_uuid(),",
    "  agent text not null check (agent in ('claude', 'qoder')),",
    "  scope text not null check (scope in ('global', 'project')),",
    "  name text not null,",
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

export interface SupabaseRulesSyncClientOptions {
  url: string;
  anonKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const RULES_SYNC_COLUMNS = "id,agent,scope,name,content,content_hash,project_path,version,created_at,updated_at";

export class SupabaseRulesSyncClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: SupabaseRulesSyncClientOptions) {
    this.baseUrl = normalizeSupabaseUrl(options.url);
    this.anonKey = options.anonKey.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_RULES_SYNC_TIMEOUT_MS;
    if (!this.baseUrl) throw new Error("Supabase URL is required.");
    if (!this.anonKey) throw new Error("Supabase anon key is required.");
  }

  async checkStatus(): Promise<RulesSyncStatus> {
    const setupSql = buildRulesSyncSetupSql();
    try {
      const response = await this.restRequest(`/${AGENT_RECALL_RULES_TABLE}?select=id&limit=1`, { method: "GET" });
      if (response.ok) return { kind: "ready", setupSql };
      const body = await readResponseBody(response);
      if (isMissingTableError(response.status, body)) {
        return { kind: "missing-table", setupSql, remediation: "sql", message: `Supabase table ${AGENT_RECALL_RULES_TABLE} was not found.` };
      }
      return { kind: "error", setupSql, remediation: "sql", message: supabaseErrorMessage(response.status, body) };
    } catch (error) {
      return { kind: "error", setupSql, remediation: "settings", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async listRemoteRules(): Promise<RemoteRule[]> {
    const { body } = await this.selectRows(`order=updated_at.desc`);
    return parseRuleRows(body);
  }

  async uploadRule(rule: AgentRule): Promise<RemoteRule> {
    const payload = {
      agent: rule.agent,
      scope: rule.scope,
      name: rule.name,
      content: rule.content,
      content_hash: rule.contentHash,
      project_path: rule.projectPath,
    };
    const response = await this.restRequest(`/${AGENT_RECALL_RULES_TABLE}?on_conflict=agent,scope,name,project_path`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new Error(supabaseErrorMessage(response.status, body));
    const rows = parseRuleRows(body);
    if (rows.length === 0) throw new Error("Supabase did not return the uploaded rule.");
    return rows[0];
  }

  async deleteRule(remoteId: string): Promise<boolean> {
    const response = await this.restRequest(`/${AGENT_RECALL_RULES_TABLE}?id=eq.${encodeURIComponent(remoteId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      const body = await readResponseBody(response);
      throw new Error(supabaseErrorMessage(response.status, body));
    }
    return true;
  }

  private async selectRows(query: string): Promise<{ body: unknown }> {
    const response = await this.restRequest(`/${AGENT_RECALL_RULES_TABLE}?select=${RULES_SYNC_COLUMNS}&${query}`, { method: "GET" });
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
// Restore (download remote rules to local filesystem)
// ---------------------------------------------------------------------------

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  backedUp: string[];
}

/**
 * Restores global-scope remote rules to their local filesystem paths.
 * Conflict policy: identical content is skipped; differing local files are
 * backed up to `<path>.bak` before being overwritten.
 */
export function restoreGlobalRules(remoteRules: RemoteRule[], options: { homeDir?: string } = {}): RestoreResult {
  const homeDir = options.homeDir ?? os.homedir();
  const result: RestoreResult = { restored: [], skipped: [], backedUp: [] };
  for (const rule of remoteRules) {
    if (rule.scope !== "global") continue;
    const targetPath = resolveGlobalRulePath(rule, homeDir);
    if (!targetPath) continue;
    if (fs.existsSync(targetPath)) {
      const localContent = fs.readFileSync(targetPath, "utf8");
      if (sha256(localContent) === rule.content_hash) {
        result.skipped.push(rule.name);
        continue;
      }
      fs.copyFileSync(targetPath, `${targetPath}.bak`);
      result.backedUp.push(rule.name);
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, rule.content, "utf8");
    result.restored.push(rule.name);
  }
  return result;
}

function resolveGlobalRulePath(rule: RemoteRule, homeDir: string): string | null {
  if (rule.agent === "claude" && rule.name === "CLAUDE.md") return path.join(homeDir, ".claude", "CLAUDE.md");
  return null;
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

function parseRuleRows(body: unknown): RemoteRule[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => (isRuleRow(row) ? [row] : []));
}

function isRuleRow(value: unknown): value is RemoteRule {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RemoteRule>;
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
