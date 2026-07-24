import type {
  OpenVikingImportState,
  OpenVikingWorkspace,
} from "../openviking-memory";
import type { PostgresDatabase } from "./database";

export interface AddOpenVikingWorkspaceInput {
  id: string;
  userId: string;
  rootPath: string;
  identity: string;
  displayName: string;
}

export interface OpenVikingImportJob {
  workspaceId: string;
  state: OpenVikingImportState;
  importedTurns: number;
  totalTurns: number;
  cursorSessionKey: string | null;
  lastError: string | null;
  updatedAt: string;
}

export type UpdateOpenVikingImportJobInput = Pick<
  OpenVikingImportJob,
  "state" | "importedTurns" | "totalTurns" | "cursorSessionKey" | "lastError"
>;

interface WorkspaceRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  root_path: string;
  identity: string;
  display_name: string;
  managed: boolean;
  import_state: OpenVikingImportState;
  imported_turns: number;
  total_turns: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ImportJobRow extends Record<string, unknown> {
  workspace_id: string;
  state: OpenVikingImportState;
  imported_turns: number;
  total_turns: number;
  cursor_session_key: string | null;
  last_error: string | null;
  updated_at: Date | string;
}

const WORKSPACE_SELECT = `
  select
    workspace.id,
    workspace.user_id,
    workspace.root_path,
    workspace.identity,
    workspace.display_name,
    workspace.managed,
    job.state as import_state,
    job.imported_turns,
    job.total_turns,
    job.last_error,
    workspace.created_at,
    workspace.updated_at
  from agent_recall.openviking_workspaces workspace
  join agent_recall.openviking_import_jobs job on job.workspace_id = workspace.id
`;

export class PostgresOpenVikingMemoryRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async addWorkspace(input: AddOpenVikingWorkspaceInput): Promise<OpenVikingWorkspace> {
    const now = new Date().toISOString();
    await this.database.transaction(async (client) => {
      await client.query(
        `
          insert into agent_recall.openviking_workspaces (
            id, user_id, root_path, identity, display_name, managed, created_at, updated_at
          )
          values ($1, $2, $3, $4, $5, true, $6, $6)
        `,
        [input.id, input.userId, input.rootPath, input.identity, input.displayName, now],
      );
      await client.query(
        `
          insert into agent_recall.openviking_import_jobs (
            workspace_id, state, imported_turns, total_turns, updated_at
          )
          values ($1, 'idle', 0, 0, $2)
        `,
        [input.id, now],
      );
    });
    const created = await this.getWorkspace(input.id);
    if (!created) throw new Error("OpenViking workspace was not created.");
    return created;
  }

  async listWorkspaces(): Promise<OpenVikingWorkspace[]> {
    const result = await this.database.query<WorkspaceRow>(
      `${WORKSPACE_SELECT} order by workspace.created_at, workspace.id`,
    );
    return result.rows.map(mapWorkspace);
  }

  async getWorkspace(id: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("workspace.id = $1", id);
  }

  async findWorkspaceByRootPath(rootPath: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("workspace.root_path = $1", rootPath);
  }

  async findWorkspaceByIdentity(identity: string): Promise<OpenVikingWorkspace | null> {
    return this.findWorkspace("workspace.identity = $1", identity);
  }

  async relinkWorkspace(id: string, rootPath: string, displayName: string): Promise<OpenVikingWorkspace> {
    const result = await this.database.query(
      `
        update agent_recall.openviking_workspaces
        set root_path = $2, display_name = $3, updated_at = $4
        where id = $1
      `,
      [id, rootPath, displayName, new Date().toISOString()],
    );
    if (result.rowCount === 0) throw new Error("OpenViking workspace was not found.");
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error("OpenViking workspace was not found after relinking.");
    return workspace;
  }

  async updateImportJob(
    workspaceId: string,
    input: UpdateOpenVikingImportJobInput,
  ): Promise<OpenVikingImportJob> {
    const result = await this.database.query<ImportJobRow>(
      `
        update agent_recall.openviking_import_jobs
        set
          state = $2,
          imported_turns = $3,
          total_turns = $4,
          cursor_session_key = $5,
          last_error = $6,
          updated_at = $7
        where workspace_id = $1
        returning *
      `,
      [
        workspaceId,
        input.state,
        input.importedTurns,
        input.totalTurns,
        input.cursorSessionKey,
        input.lastError,
        new Date().toISOString(),
      ],
    );
    if (!result.rows[0]) throw new Error("OpenViking import job was not found.");
    return mapImportJob(result.rows[0]);
  }

  async getImportJob(workspaceId: string): Promise<OpenVikingImportJob | null> {
    const result = await this.database.query<ImportJobRow>(
      "select * from agent_recall.openviking_import_jobs where workspace_id = $1",
      [workspaceId],
    );
    return result.rows[0] ? mapImportJob(result.rows[0]) : null;
  }

  async recordImportedTurn(workspaceId: string, sourceTurnId: string, fingerprint: string): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.openviking_imported_turns (
          workspace_id, source_turn_id, fingerprint, imported_at
        )
        values ($1, $2, $3, $4)
        on conflict do nothing
      `,
      [workspaceId, sourceTurnId, fingerprint, new Date().toISOString()],
    );
  }

  async hasImportedTurn(workspaceId: string, sourceTurnId: string, fingerprint: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from agent_recall.openviking_imported_turns
          where workspace_id = $1 and source_turn_id = $2 and fingerprint = $3
        ) as exists
      `,
      [workspaceId, sourceTurnId, fingerprint],
    );
    return Boolean(result.rows[0]?.exists);
  }

  async countImportedTurns(workspaceId: string): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      `
        select count(*)::int as count
        from agent_recall.openviking_imported_turns
        where workspace_id = $1
      `,
      [workspaceId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const result = await this.database.query(
      "delete from agent_recall.openviking_workspaces where id = $1",
      [id],
    );
    return result.rowCount > 0;
  }

  private async findWorkspace(clause: string, value: string): Promise<OpenVikingWorkspace | null> {
    const result = await this.database.query<WorkspaceRow>(`${WORKSPACE_SELECT} where ${clause}`, [value]);
    return result.rows[0] ? mapWorkspace(result.rows[0]) : null;
  }
}

function mapWorkspace(row: WorkspaceRow): OpenVikingWorkspace {
  return {
    id: row.id,
    userId: row.user_id,
    rootPath: row.root_path,
    identity: row.identity,
    displayName: row.display_name,
    managed: row.managed,
    importState: row.import_state,
    importedTurns: Number(row.imported_turns),
    totalTurns: Number(row.total_turns),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapImportJob(row: ImportJobRow): OpenVikingImportJob {
  return {
    workspaceId: row.workspace_id,
    state: row.state,
    importedTurns: Number(row.imported_turns),
    totalTurns: Number(row.total_turns),
    cursorSessionKey: row.cursor_session_key,
    lastError: row.last_error,
    updatedAt: iso(row.updated_at),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
