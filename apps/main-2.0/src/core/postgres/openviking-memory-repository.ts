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
  completedTasks?: number;
  totalTasks?: number;
  cursorSessionKey: string | null;
  selectedSessionKeys?: string[] | null;
  lastError: string | null;
  updatedAt: string;
}

export interface OpenVikingImportTaskTurn {
  sourceTurnId: string;
  fingerprint: string;
  user: string;
  assistant: string;
  startedAt?: string;
  endedAt?: string;
}

export interface OpenVikingImportTaskPayload {
  context: OpenVikingImportTaskTurn[];
  primary: OpenVikingImportTaskTurn[];
  keepRecentCount?: number;
}

export type OpenVikingImportTaskState =
  | "queued"
  | "uploading"
  | "waiting"
  | "completed"
  | "failed";

export interface OpenVikingImportTask {
  id: string;
  position: number;
  workspaceId: string;
  sessionKey: string;
  sourceRevision: string;
  sessionTitle: string;
  payload: OpenVikingImportTaskPayload;
  state: OpenVikingImportTaskState;
  attemptCount: number;
  remoteTaskId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOpenVikingImportTaskInput {
  id: string;
  position: number;
  workspaceId: string;
  sessionKey: string;
  sourceRevision: string;
  sessionTitle: string;
  payload: OpenVikingImportTaskPayload;
}

export interface OpenVikingImportedTurnCheckpoint {
  sourceTurnId: string;
  fingerprint: string;
}

export interface OpenVikingSessionCheckpoint {
  workspaceId: string;
  sessionKey: string;
  sourceRevision: string;
  importedTurns: number;
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
  completed_tasks: number;
  total_tasks: number;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ImportJobRow extends Record<string, unknown> {
  workspace_id: string;
  state: OpenVikingImportState;
  imported_turns: number;
  total_turns: number;
  completed_tasks: number;
  total_tasks: number;
  cursor_session_key: string | null;
  selected_session_keys: unknown;
  last_error: string | null;
  updated_at: Date | string;
}

interface ImportTaskRow extends Record<string, unknown> {
  id: string;
  position: number;
  workspace_id: string;
  session_key: string;
  source_revision: string;
  session_title: string;
  payload: OpenVikingImportTaskPayload;
  state: OpenVikingImportTaskState;
  attempt_count: number;
  remote_task_id: string | null;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SessionCheckpointRow extends Record<string, unknown> {
  workspace_id: string;
  session_key: string;
  source_revision: string;
  imported_turns: number;
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
    job.completed_tasks,
    job.total_tasks,
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

  async setWorkspaceManaged(id: string, managed: boolean): Promise<OpenVikingWorkspace> {
    const result = await this.database.query(
      `
        update agent_recall.openviking_workspaces
        set managed = $2, updated_at = $3
        where id = $1
      `,
      [id, managed, new Date().toISOString()],
    );
    if (result.rowCount === 0) throw new Error("OpenViking workspace was not found.");
    const workspace = await this.getWorkspace(id);
    if (!workspace) throw new Error("OpenViking workspace was not found after updating management.");
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

  async setImportSelection(
    workspaceId: string,
    sessionKeys: string[],
  ): Promise<OpenVikingImportJob> {
    const result = await this.database.query<ImportJobRow>(
      `
        update agent_recall.openviking_import_jobs
        set selected_session_keys = $2::jsonb, updated_at = $3
        where workspace_id = $1
        returning *
      `,
      [workspaceId, JSON.stringify(sessionKeys), new Date().toISOString()],
    );
    if (!result.rows[0]) throw new Error("OpenViking import job was not found.");
    return mapImportJob(result.rows[0]);
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

  async listImportedTurns(workspaceId: string): Promise<OpenVikingImportedTurnCheckpoint[]> {
    const result = await this.database.query<{
      source_turn_id: string;
      fingerprint: string;
    }>(
      `
        select source_turn_id, fingerprint
        from agent_recall.openviking_imported_turns
        where workspace_id = $1
      `,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      sourceTurnId: row.source_turn_id,
      fingerprint: row.fingerprint,
    }));
  }

  async listSessionCheckpoints(workspaceId: string): Promise<OpenVikingSessionCheckpoint[]> {
    const result = await this.database.query<SessionCheckpointRow>(
      `
        select workspace_id, session_key, source_revision, imported_turns, updated_at
        from agent_recall.openviking_imported_sessions
        where workspace_id = $1
      `,
      [workspaceId],
    );
    return result.rows.map(mapSessionCheckpoint);
  }

  async recordSessionCheckpoint(
    workspaceId: string,
    sessionKey: string,
    sourceRevision: string,
    importedTurns: number,
  ): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.openviking_imported_sessions (
          workspace_id, session_key, source_revision, imported_turns, updated_at
        )
        values ($1, $2, $3, $4, $5)
        on conflict (workspace_id, session_key) do update
        set
          source_revision = excluded.source_revision,
          imported_turns = excluded.imported_turns,
          updated_at = excluded.updated_at
      `,
      [workspaceId, sessionKey, sourceRevision, importedTurns, new Date().toISOString()],
    );
  }

  async syncImportTasks(
    workspaceId: string,
    inputs: CreateOpenVikingImportTaskInput[],
    activeRevisions: Array<{ sessionKey: string; sourceRevision: string }>,
  ): Promise<OpenVikingImportTask[]> {
    const now = new Date().toISOString();
    await this.database.transaction(async (client) => {
      const taskIds = inputs.map((input) => input.id);
      const activeRevisionKeys = new Set(activeRevisions.map(
        (entry) => `${entry.sessionKey}\0${entry.sourceRevision}`,
      ));
      const existing = await client.query<Pick<
        ImportTaskRow,
        "id" | "session_key" | "source_revision" | "state"
      >>(
        `
          select id, session_key, source_revision, state
          from agent_recall.openviking_import_tasks
          where workspace_id = $1
        `,
        [workspaceId],
      );
      const retainedTaskIds = new Set(taskIds);
      const staleTaskIds = existing.rows
        .filter((task) => {
          const revisionIsActive = activeRevisionKeys.has(
            `${task.session_key}\0${task.source_revision}`,
          );
          return !revisionIsActive || (task.state !== "completed" && !retainedTaskIds.has(task.id));
        })
        .map((task) => task.id);
      if (staleTaskIds.length > 0) {
        await client.query(
          `
            delete from agent_recall.openviking_import_tasks
            where workspace_id = $1 and id = any($2::text[])
          `,
          [workspaceId, staleTaskIds],
        );
      }
      for (const input of inputs) {
        await client.query(
          `
            insert into agent_recall.openviking_import_tasks (
              id, workspace_id, session_key, source_revision, session_title, position,
              payload, state, attempt_count, created_at, updated_at
            )
            values ($1, $2, $3, $4, $5, $6, $7, 'queued', 0, $8, $8)
            on conflict (id) do update
            set
              session_title = excluded.session_title,
              position = excluded.position,
              payload = excluded.payload,
              updated_at = excluded.updated_at
          `,
          [
            input.id,
            input.workspaceId,
            input.sessionKey,
            input.sourceRevision,
            input.sessionTitle,
            input.position,
            JSON.stringify(input.payload),
            now,
          ],
        );
      }
      await client.query(
        `
          update agent_recall.openviking_import_jobs
          set
            completed_tasks = (
              select count(*)::int
              from agent_recall.openviking_import_tasks
              where workspace_id = $1 and state = 'completed'
            ),
            total_tasks = (
              select count(*)::int
              from agent_recall.openviking_import_tasks
              where workspace_id = $1
            ),
            updated_at = $2
          where workspace_id = $1
        `,
        [workspaceId, now],
      );
    });
    return this.listImportTasks(workspaceId);
  }

  async listImportTasks(workspaceId: string): Promise<OpenVikingImportTask[]> {
    const result = await this.database.query<ImportTaskRow>(
      `
        select *
        from agent_recall.openviking_import_tasks
        where workspace_id = $1
        order by position, created_at, id
      `,
      [workspaceId],
    );
    return result.rows.map(mapImportTask);
  }

  async beginImportTaskAttempt(taskId: string): Promise<OpenVikingImportTask> {
    const result = await this.database.query<ImportTaskRow>(
      `
        update agent_recall.openviking_import_tasks
        set
          state = 'uploading',
          attempt_count = attempt_count + 1,
          remote_task_id = null,
          last_error = null,
          updated_at = $2
        where id = $1
        returning *
      `,
      [taskId, new Date().toISOString()],
    );
    if (!result.rows[0]) throw new Error("OpenViking import task was not found.");
    return mapImportTask(result.rows[0]);
  }

  async waitForImportTask(taskId: string, remoteTaskId: string): Promise<void> {
    const result = await this.database.query(
      `
        update agent_recall.openviking_import_tasks
        set state = 'waiting', remote_task_id = $2, last_error = null, updated_at = $3
        where id = $1
      `,
      [taskId, remoteTaskId, new Date().toISOString()],
    );
    if (result.rowCount === 0) throw new Error("OpenViking import task was not found.");
  }

  async completeImportTask(taskId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.database.transaction(async (client) => {
      const result = await client.query<ImportTaskRow>(
        "select * from agent_recall.openviking_import_tasks where id = $1 for update",
        [taskId],
      );
      const task = result.rows[0];
      if (!task) throw new Error("OpenViking import task was not found.");
      if (task.state === "completed") return;
      for (const turn of task.payload.primary) {
        await client.query(
          `
            insert into agent_recall.openviking_imported_turns (
              workspace_id, source_turn_id, fingerprint, imported_at
            )
            values ($1, $2, $3, $4)
            on conflict do nothing
          `,
          [task.workspace_id, turn.sourceTurnId, turn.fingerprint, now],
        );
      }
      await client.query(
        `
          update agent_recall.openviking_import_tasks
          set state = 'completed', last_error = null, updated_at = $2
          where id = $1
        `,
        [taskId, now],
      );
      await client.query(
        `
          update agent_recall.openviking_import_jobs
          set
            completed_tasks = (
              select count(*)::int
              from agent_recall.openviking_import_tasks
              where workspace_id = $1 and state = 'completed'
            ),
            updated_at = $2
          where workspace_id = $1
        `,
        [task.workspace_id, now],
      );
    });
  }

  async failImportTask(taskId: string, error: string): Promise<void> {
    await this.database.query(
      `
        update agent_recall.openviking_import_tasks
        set state = 'failed', last_error = $2, updated_at = $3
        where id = $1
      `,
      [taskId, error, new Date().toISOString()],
    );
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
    completedTasks: Number(row.completed_tasks),
    totalTasks: Number(row.total_tasks),
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
    completedTasks: Number(row.completed_tasks),
    totalTasks: Number(row.total_tasks),
    cursorSessionKey: row.cursor_session_key,
    selectedSessionKeys: Array.isArray(row.selected_session_keys)
      ? row.selected_session_keys.filter((value): value is string => typeof value === "string")
      : null,
    lastError: row.last_error,
    updatedAt: iso(row.updated_at),
  };
}

function mapSessionCheckpoint(row: SessionCheckpointRow): OpenVikingSessionCheckpoint {
  return {
    workspaceId: row.workspace_id,
    sessionKey: row.session_key,
    sourceRevision: row.source_revision,
    importedTurns: Number(row.imported_turns),
    updatedAt: iso(row.updated_at),
  };
}

function mapImportTask(row: ImportTaskRow): OpenVikingImportTask {
  return {
    id: row.id,
    position: Number(row.position),
    workspaceId: row.workspace_id,
    sessionKey: row.session_key,
    sourceRevision: row.source_revision,
    sessionTitle: row.session_title,
    payload: row.payload,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    remoteTaskId: row.remote_task_id,
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
