import type {
  EnvironmentKind,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  SessionEnvironment,
} from "../types";
import type { SessionStoreDatabase } from "./database";

interface EnvironmentRow {
  id: string;
  kind: EnvironmentKind;
  label: string;
  wsl_distribution: string | null;
  host_alias: string | null;
  host: string | null;
  user: string | null;
  port: number | null;
  auth_mode: SessionEnvironment["authMode"];
  identity_file: string | null;
  enabled: 0 | 1;
  sync_state: EnvironmentSyncState;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export class EnvironmentStore {
  constructor(private readonly db: SessionStoreDatabase) {}

  listEnvironments(): SessionEnvironment[] {
    return (this.db.prepare("SELECT * FROM environments ORDER BY kind, lower(label), id").all() as unknown as EnvironmentRow[]).map(
      hydrateEnvironmentRow,
    );
  }

  upsertEnvironment(input: EnvironmentUpsertInput): SessionEnvironment {
    if (input.kind === "wsl") return this.upsertWslEnvironment(input);
    const now = Date.now();
    const id = input.id ?? this.findEnvironmentIdByHostAlias(input) ?? this.createUniqueEnvironmentId(input.label);
    const existing = this.getEnvironment(id);
    if (input.id === "local") {
      const current = existing ?? localEnvironment();
      const environment = {
        ...localEnvironment(),
        syncState: current.syncState,
        lastSyncedAt: current.lastSyncedAt,
        lastError: current.lastError,
        createdAt: current.createdAt,
        updatedAt: now,
      };
      this.writeEnvironment(environment);
      return environment;
    }
    const environment: SessionEnvironment = {
      id,
      kind: input.kind,
      label: input.label,
      hostAlias: input.hostAlias ?? null,
      host: input.host ?? null,
      user: input.user ?? null,
      port: input.port ?? null,
      authMode: input.authMode ?? "none",
      identityFile: input.identityFile ?? null,
      enabled: input.enabled ?? true,
      syncState: existing?.syncState ?? "idle",
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeEnvironment(environment);
    return environment;
  }

  private upsertWslEnvironment(input: EnvironmentUpsertInput): SessionEnvironment {
    const now = Date.now();
    const wslDistribution = input.wslDistribution?.trim() || null;
    if (!wslDistribution) throw new Error("WSL distribution is required.");
    const id = input.id
      ?? this.findEnvironmentIdByWslDistribution(wslDistribution)
      ?? this.createUniqueEnvironmentId(input.label);
    const existing = this.getEnvironment(id);
    const environment: SessionEnvironment = {
      id,
      kind: "wsl",
      label: input.label,
      wslDistribution,
      hostAlias: null,
      host: null,
      user: null,
      port: null,
      authMode: "none",
      identityFile: null,
      enabled: input.enabled ?? true,
      syncState: existing?.syncState ?? "idle",
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeEnvironment(environment);
    return environment;
  }

  private findEnvironmentIdByHostAlias(input: EnvironmentUpsertInput): string | null {
    if (input.kind !== "ssh" || !input.hostAlias) return null;
    const row = this.db.prepare("SELECT id FROM environments WHERE kind = 'ssh' AND host_alias = ? ORDER BY created_at, id LIMIT 1").get(
      input.hostAlias,
    ) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private findEnvironmentIdByWslDistribution(distribution: string | null): string | null {
    if (!distribution) return null;
    const row = this.db
      .prepare("SELECT id FROM environments WHERE kind = 'wsl' AND wsl_distribution = ? ORDER BY created_at, id LIMIT 1")
      .get(distribution) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private createUniqueEnvironmentId(label: string): string {
    const base = generatedEnvironmentIdBase(label);
    let candidate = base;
    let suffix = 2;
    while (this.getEnvironment(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private writeEnvironment(environment: SessionEnvironment): void {
    this.db
      .prepare(
        `
        INSERT INTO environments (
          id, kind, label, wsl_distribution, host_alias, host, user, port, auth_mode, identity_file,
          enabled, sync_state, last_synced_at, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          wsl_distribution = excluded.wsl_distribution,
          host_alias = excluded.host_alias,
          host = excluded.host,
          user = excluded.user,
          port = excluded.port,
          auth_mode = excluded.auth_mode,
          identity_file = excluded.identity_file,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        environment.id,
        environment.kind,
        environment.label,
        environment.wslDistribution ?? null,
        environment.hostAlias,
        environment.host,
        environment.user,
        environment.port,
        environment.authMode,
        environment.identityFile,
        environment.enabled ? 1 : 0,
        environment.syncState,
        environment.lastSyncedAt,
        environment.lastError,
        environment.createdAt,
        environment.updatedAt,
      );
  }

  getEnvironment(id: string): SessionEnvironment | null {
    const row = this.db.prepare("SELECT * FROM environments WHERE id = ?").get(id) as EnvironmentRow | undefined;
    return row ? hydrateEnvironmentRow(row) : null;
  }

  updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): void {
    const existing = this.getEnvironment(id);
    const hasLastSyncedAt = Object.prototype.hasOwnProperty.call(options, "lastSyncedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(options, "lastError");
    const lastSyncedAt = hasLastSyncedAt ? (options.lastSyncedAt ?? null) : existing?.lastSyncedAt ?? null;
    const lastError = hasLastError ? (options.lastError ?? null) : existing?.lastError ?? null;
    this.db
      .prepare(
        `
        UPDATE environments
        SET sync_state = ?,
          last_synced_at = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `,
      )
      .run(state, lastSyncedAt, lastError, Date.now(), id);
  }

  deleteEnvironment(environmentId: string): void {
    if (environmentId === "local") throw new Error("Local environment cannot be deleted.");
    this.transaction(() => {
      this.deleteEnvironmentSessionsInTransaction(environmentId);
      this.db.prepare("DELETE FROM environments WHERE id = ?").run(environmentId);
      this.deleteUnusedTags();
    });
  }

  deleteEnvironmentSessions(environmentId: string): void {
    this.transaction(() => {
      this.deleteEnvironmentSessionsInTransaction(environmentId);
      this.deleteUnusedTags();
    });
  }

  private deleteEnvironmentSessionsInTransaction(environmentId: string): void {
    this.db
      .prepare("DELETE FROM session_fts WHERE session_key IN (SELECT session_key FROM sessions WHERE environment_id = ?)")
      .run(environmentId);
    this.db.prepare("DELETE FROM sessions WHERE environment_id = ?").run(environmentId);
  }

  private deleteUnusedTags(): void {
    this.db.prepare(
      `
        DELETE FROM tags
        WHERE NOT EXISTS (
          SELECT 1
          FROM session_tags
          WHERE session_tags.tag_id = tags.id
        )
      `,
    ).run();
  }

  private transaction(run: () => void): void {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function hydrateEnvironmentRow(row: EnvironmentRow): SessionEnvironment {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    wslDistribution: row.wsl_distribution,
    hostAlias: row.host_alias,
    host: row.host,
    user: row.user,
    port: row.port,
    authMode: row.auth_mode,
    identityFile: row.identity_file,
    enabled: row.enabled === 1,
    syncState: row.sync_state,
    lastSyncedAt: row.last_synced_at,
    lastError: truncateEnvironmentError(row.last_error),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function truncateEnvironmentError(error: string | null): string | null {
  if (!error) return error;
  const bytes = Buffer.byteLength(error);
  if (error.length <= 600) return error;
  if (/^\s*\{"kind":\s*"(?:codex-session|codex-index|claude-project|claude-session-index)"/.test(error)) {
    return `Remote sync error output was truncated (${formatEnvironmentErrorBytes(bytes)}). The hidden output looked like session payload data, not a readable error.`;
  }
  return `${error.slice(0, 520)}... truncated ${formatEnvironmentErrorBytes(bytes)}`;
}

function formatEnvironmentErrorBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function localEnvironment(): SessionEnvironment {
  const now = Date.now();
  return {
    id: "local",
    kind: "local",
    label: "Local",
    hostAlias: null,
    host: null,
    user: null,
    port: null,
    authMode: "none",
    identityFile: null,
    enabled: true,
    syncState: "idle",
    lastSyncedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createEnvironmentId(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "environment";
}

function generatedEnvironmentIdBase(label: string): string {
  const id = createEnvironmentId(label);
  return id === "local" ? "ssh-local" : id;
}

