import type {
  EnvironmentKind,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  SessionEnvironment,
} from "../types";
import type { EnvironmentRepository } from "../storage/repositories";
import type { SqliteDatabase } from "./database";
import { sqliteOptionalTime, sqliteTime } from "./values";

interface EnvironmentRow extends Record<string, unknown> {
  id: string;
  kind: EnvironmentKind;
  label: string;
  wsl_distribution: string | null;
  host_alias: string | null;
  host: string | null;
  user_name: string | null;
  port: number | null;
  auth_mode: SessionEnvironment["authMode"];
  identity_file: string | null;
  enabled: number;
  sync_state: EnvironmentSyncState;
  last_synced_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function hydrateEnvironment(row: EnvironmentRow): SessionEnvironment {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    wslDistribution: row.wsl_distribution,
    hostAlias: row.host_alias,
    host: row.host,
    user: row.user_name,
    port: row.port === null ? null : Number(row.port),
    authMode: row.auth_mode,
    identityFile: row.identity_file,
    enabled: Boolean(row.enabled),
    syncState: row.sync_state,
    lastSyncedAt: sqliteOptionalTime(row.last_synced_at),
    lastError: truncateEnvironmentError(row.last_error),
    createdAt: sqliteTime(row.created_at),
    updatedAt: sqliteTime(row.updated_at),
  };
}

function environmentIdBase(label: string): string {
  const normalized = label
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const id = normalized || "environment";
  return id === "local" ? "ssh-local" : id;
}

function truncateEnvironmentError(error: string | null): string | null {
  if (!error || error.length <= 600) return error;
  const bytes = Buffer.byteLength(error);
  if (/^\s*\{"kind":\s*"(?:codex-session|codex-index|claude-project|claude-session-index)"/u.test(error)) {
    return `Remote sync error output was truncated (${formatBytes(bytes)}). The hidden output looked like session payload data, not a readable error.`;
  }
  return `${error.slice(0, 520)}... truncated ${formatBytes(bytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const ENVIRONMENT_COLUMNS = `
  id, kind, label, wsl_distribution, host_alias, host, "user" AS user_name, port, auth_mode,
  identity_file, enabled, sync_state, last_synced_at, last_error, created_at, updated_at
`;

export class SqliteEnvironmentRepository implements EnvironmentRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async listEnvironments(): Promise<SessionEnvironment[]> {
    const rows = this.database.all<EnvironmentRow>(
      `SELECT ${ENVIRONMENT_COLUMNS} FROM environments ORDER BY kind, lower(label), id`,
    );
    return rows.map(hydrateEnvironment);
  }

  async getEnvironment(id: string): Promise<SessionEnvironment | null> {
    const row = this.database.get<EnvironmentRow>(
      `SELECT ${ENVIRONMENT_COLUMNS} FROM environments WHERE id = ?`,
      id,
    );
    return row ? hydrateEnvironment(row) : null;
  }

  async upsertEnvironment(input: EnvironmentUpsertInput): Promise<SessionEnvironment> {
    const normalizedWslDistribution = input.kind === "wsl"
      ? input.wslDistribution?.trim() || null
      : null;
    if (input.kind === "wsl" && !normalizedWslDistribution) {
      throw new Error("WSL distribution is required.");
    }
    const matchingId = input.id
      ? null
      : input.kind === "wsl"
        ? await this.findEnvironmentIdByWslDistribution(normalizedWslDistribution)
        : await this.findEnvironmentIdByHostAlias(input);
    const id = input.id || matchingId || await this.createUniqueEnvironmentId(input.label);
    const existing = await this.getEnvironment(id);
    const now = Date.now();

    if (id === "local") {
      const createdAt = existing?.createdAt ?? now;
      this.database.run(
        `
          INSERT INTO environments (
            id, kind, label, wsl_distribution, host_alias, host, "user", port, auth_mode, identity_file,
            enabled, sync_state, last_synced_at, last_error, created_at, updated_at
          )
          VALUES (
            'local', 'local', 'Local', NULL, NULL, NULL, NULL, NULL, 'none', NULL,
            1, ?, ?, ?, ?, ?
          )
          ON CONFLICT (id) DO UPDATE SET
            kind = 'local',
            label = 'Local',
            wsl_distribution = NULL,
            host_alias = NULL,
            host = NULL,
            "user" = NULL,
            port = NULL,
            auth_mode = 'none',
            identity_file = NULL,
            enabled = 1,
            updated_at = excluded.updated_at
        `,
        existing?.syncState ?? "idle",
        existing?.lastSyncedAt ?? null,
        existing?.lastError ?? null,
        createdAt,
        now,
      );
      return (await this.getEnvironment("local"))!;
    }

    const environment: SessionEnvironment = {
      id,
      kind: input.kind,
      label: input.label,
      wslDistribution: normalizedWslDistribution,
      hostAlias: input.kind === "wsl" ? null : input.hostAlias ?? null,
      host: input.kind === "wsl" ? null : input.host ?? null,
      user: input.kind === "wsl" ? null : input.user ?? null,
      port: input.kind === "wsl" ? null : input.port ?? null,
      authMode: input.kind === "wsl" ? "none" : input.authMode ?? "none",
      identityFile: input.kind === "wsl" ? null : input.identityFile ?? null,
      enabled: input.enabled ?? true,
      syncState: existing?.syncState ?? "idle",
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.database.run(
      `
        INSERT INTO environments (
          id, kind, label, wsl_distribution, host_alias, host, "user", port, auth_mode, identity_file,
          enabled, sync_state, last_synced_at, last_error, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          kind = excluded.kind,
          label = excluded.label,
          wsl_distribution = excluded.wsl_distribution,
          host_alias = excluded.host_alias,
          host = excluded.host,
          "user" = excluded."user",
          port = excluded.port,
          auth_mode = excluded.auth_mode,
          identity_file = excluded.identity_file,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `,
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
    return (await this.getEnvironment(id))!;
  }

  async updateEnvironmentSyncState(
    id: string,
    state: EnvironmentSyncState,
    options: { lastSyncedAt?: number | null; lastError?: string | null } = {},
  ): Promise<void> {
    const existing = await this.getEnvironment(id);
    const hasLastSyncedAt = Object.prototype.hasOwnProperty.call(options, "lastSyncedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(options, "lastError");
    const lastSyncedAt = hasLastSyncedAt ? options.lastSyncedAt ?? null : existing?.lastSyncedAt ?? null;
    const lastError = hasLastError ? options.lastError ?? null : existing?.lastError ?? null;
    this.database.run(
      `
        UPDATE environments
        SET sync_state = ?, last_synced_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `,
      state,
      lastSyncedAt,
      lastError,
      Date.now(),
      id,
    );
  }

  async deleteEnvironmentSessions(environmentId: string): Promise<void> {
    this.database.transactionSync((tx) => {
      tx.run("DELETE FROM sessions WHERE team_snapshot_key IS NULL AND environment_id = ?", environmentId);
      tx.run(`
        DELETE FROM tags
        WHERE NOT EXISTS (
          SELECT 1 FROM session_tags WHERE session_tags.tag_id = tags.id
        )
      `);
    });
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    if (environmentId === "local") throw new Error("Local environment cannot be deleted.");
    this.database.transactionSync((tx) => {
      tx.run("DELETE FROM sessions WHERE team_snapshot_key IS NULL AND environment_id = ?", environmentId);
      tx.run("DELETE FROM environments WHERE id = ?", environmentId);
      tx.run(`
        DELETE FROM tags
        WHERE NOT EXISTS (
          SELECT 1 FROM session_tags WHERE session_tags.tag_id = tags.id
        )
      `);
    });
  }

  private async findEnvironmentIdByHostAlias(input: EnvironmentUpsertInput): Promise<string | null> {
    if (input.kind !== "ssh" || !input.hostAlias) return null;
    const row = this.database.get<{ id: string }>(
      `
        SELECT id
        FROM environments
        WHERE kind = 'ssh' AND host_alias = ?
        ORDER BY created_at, id
        LIMIT 1
      `,
      input.hostAlias,
    );
    return row?.id ?? null;
  }

  private async findEnvironmentIdByWslDistribution(distribution: string | null): Promise<string | null> {
    if (!distribution) return null;
    const row = this.database.get<{ id: string }>(
      `
        SELECT id
        FROM environments
        WHERE kind = 'wsl' AND wsl_distribution = ?
        ORDER BY created_at, id
        LIMIT 1
      `,
      distribution,
    );
    return row?.id ?? null;
  }

  private async createUniqueEnvironmentId(label: string): Promise<string> {
    const base = environmentIdBase(label);
    let candidate = base;
    let suffix = 2;
    while (await this.getEnvironment(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }
}
