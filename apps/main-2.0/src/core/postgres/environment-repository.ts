import type {
  EnvironmentKind,
  EnvironmentSyncState,
  EnvironmentUpsertInput,
  SessionEnvironment,
} from "../types";
import type { PostgresDatabase } from "./database";

interface EnvironmentRow extends Record<string, unknown> {
  id: string;
  kind: EnvironmentKind;
  label: string;
  wsl_distribution: string | null;
  host_alias: string | null;
  host: string | null;
  user_name: string | null;
  port: number | string | null;
  auth_mode: SessionEnvironment["authMode"];
  identity_file: string | null;
  enabled: boolean;
  sync_state: EnvironmentSyncState;
  last_synced_at: Date | string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function timeValue(value: Date | string | null): number | null {
  if (value === null) return null;
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
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
    lastSyncedAt: timeValue(row.last_synced_at),
    lastError: truncateEnvironmentError(row.last_error),
    createdAt: timeValue(row.created_at) ?? 0,
    updatedAt: timeValue(row.updated_at) ?? 0,
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
  id, kind, label, wsl_distribution, host_alias, host, "user" as user_name, port, auth_mode,
  identity_file, enabled, sync_state, last_synced_at, last_error, created_at, updated_at
`;

export class PostgresEnvironmentRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listEnvironments(): Promise<SessionEnvironment[]> {
    const result = await this.database.query<EnvironmentRow>(
      `select ${ENVIRONMENT_COLUMNS} from agent_recall.environments order by kind, lower(label), id`,
    );
    return result.rows.map(hydrateEnvironment);
  }

  async getEnvironment(id: string): Promise<SessionEnvironment | null> {
    const result = await this.database.query<EnvironmentRow>(
      `select ${ENVIRONMENT_COLUMNS} from agent_recall.environments where id = $1`,
      [id],
    );
    return result.rows[0] ? hydrateEnvironment(result.rows[0]) : null;
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
      await this.database.query(
        `
          insert into agent_recall.environments (
            id, kind, label, wsl_distribution, host_alias, host, "user", port, auth_mode, identity_file,
            enabled, sync_state, last_synced_at, last_error, created_at, updated_at
          )
          values (
            'local', 'local', 'Local', null, null, null, null, null, 'none', null,
            true, $1, $2, $3, $4, $5
          )
          on conflict (id) do update set
            kind = 'local',
            label = 'Local',
            wsl_distribution = null,
            host_alias = null,
            host = null,
            "user" = null,
            port = null,
            auth_mode = 'none',
            identity_file = null,
            enabled = true,
            updated_at = excluded.updated_at
        `,
        [
          existing?.syncState ?? "idle",
          existing?.lastSyncedAt ? new Date(existing.lastSyncedAt).toISOString() : null,
          existing?.lastError ?? null,
          new Date(createdAt).toISOString(),
          new Date(now).toISOString(),
        ],
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
    await this.database.query(
      `
        insert into agent_recall.environments (
          id, kind, label, wsl_distribution, host_alias, host, "user", port, auth_mode, identity_file,
          enabled, sync_state, last_synced_at, last_error, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16
        )
        on conflict (id) do update set
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
      [
        environment.id,
        environment.kind,
        environment.label,
        environment.wslDistribution,
        environment.hostAlias,
        environment.host,
        environment.user,
        environment.port,
        environment.authMode,
        environment.identityFile,
        environment.enabled,
        environment.syncState,
        environment.lastSyncedAt ? new Date(environment.lastSyncedAt).toISOString() : null,
        environment.lastError,
        new Date(environment.createdAt).toISOString(),
        new Date(environment.updatedAt).toISOString(),
      ],
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
    await this.database.query(
      `
        update agent_recall.environments
        set sync_state = $2, last_synced_at = $3, last_error = $4, updated_at = now()
        where id = $1
      `,
      [id, state, lastSyncedAt ? new Date(lastSyncedAt).toISOString() : null, lastError],
    );
  }

  async deleteEnvironmentSessions(environmentId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query("delete from agent_recall.local_sessions where environment_id = $1", [environmentId]);
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
    });
  }

  async deleteEnvironment(environmentId: string): Promise<void> {
    if (environmentId === "local") throw new Error("Local environment cannot be deleted.");
    await this.database.transaction(async (client) => {
      await client.query("delete from agent_recall.local_sessions where environment_id = $1", [environmentId]);
      await client.query("delete from agent_recall.environments where id = $1", [environmentId]);
      await client.query(`
        delete from agent_recall.tags
        where not exists (
          select 1 from agent_recall.session_tags where session_tags.tag_id = tags.id
        )
      `);
    });
  }

  private async findEnvironmentIdByHostAlias(input: EnvironmentUpsertInput): Promise<string | null> {
    if (input.kind !== "ssh" || !input.hostAlias) return null;
    const result = await this.database.query<{ id: string }>(
      `
        select id
        from agent_recall.environments
        where kind = 'ssh' and host_alias = $1
        order by created_at, id
        limit 1
      `,
      [input.hostAlias],
    );
    return result.rows[0]?.id ?? null;
  }

  private async findEnvironmentIdByWslDistribution(distribution: string | null): Promise<string | null> {
    if (!distribution) return null;
    const result = await this.database.query<{ id: string }>(
      `
        select id
        from agent_recall.environments
        where kind = 'wsl' and wsl_distribution = $1
        order by created_at, id
        limit 1
      `,
      [distribution],
    );
    return result.rows[0]?.id ?? null;
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
