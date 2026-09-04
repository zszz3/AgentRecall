import type {
  RuntimeInvocationRecorder,
  RuntimeInvocationStart,
  RuntimeInvocationStatus,
  RuntimeSessionBinding,
} from "../../automation/engine/main/agents/runtime/runtime-invocation-recorder";
import type { PostgresDatabase } from "./database";
import { postgresJsonValue, postgresText } from "./session-records";

/** Stores AgentRecall Runtime invocation lifecycle records in PostgreSQL. */
export class PostgresRuntimeInvocationRepository implements RuntimeInvocationRecorder {
  constructor(private readonly database: PostgresDatabase) {}

  async begin(input: RuntimeInvocationStart): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.runtime_invocations (
          id, initiator, surface, role, owner_reference, runtime_id,
          channel_id, environment_id, status, started_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
      `,
      [
        postgresText(input.id),
        input.initiator,
        input.invocation.surface,
        input.invocation.role ? postgresText(input.invocation.role) : null,
        postgresJsonValue(input.invocation.ownerReference ?? {}),
        input.runtimeId,
        input.channelId ? postgresText(input.channelId) : null,
        postgresText(input.environmentId ?? "local"),
        new Date(input.startedAt).toISOString(),
      ],
    );
  }

  async bind(invocationId: string, binding: RuntimeSessionBinding): Promise<void> {
    await this.database.query(
      `
        insert into agent_recall.runtime_session_bindings (
          invocation_id, runtime_id, channel_id, environment_id,
          runtime_session_id, runtime_turn_id, relation, bound_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8)
        on conflict (invocation_id, runtime_id, channel_id, environment_id, runtime_session_id)
        do update set
          runtime_turn_id = coalesce(excluded.runtime_turn_id, agent_recall.runtime_session_bindings.runtime_turn_id),
          relation = excluded.relation,
          bound_at = least(excluded.bound_at, agent_recall.runtime_session_bindings.bound_at)
      `,
      [
        postgresText(invocationId),
        binding.runtimeId,
        postgresText(binding.channelId ?? ""),
        postgresText(binding.environmentId ?? "local"),
        postgresText(binding.sessionId),
        binding.turnId ? postgresText(binding.turnId) : null,
        binding.relation,
        new Date(binding.boundAt).toISOString(),
      ],
    );
  }

  async finish(
    invocationId: string,
    status: Exclude<RuntimeInvocationStatus, "pending">,
    finishedAt: number,
    error?: string,
  ): Promise<void> {
    await this.database.query(
      `
        update agent_recall.runtime_invocations
        set status = $2, finished_at = $3, error = $4
        where id = $1 and status = 'pending'
      `,
      [
        postgresText(invocationId),
        status,
        new Date(finishedAt).toISOString(),
        error ? postgresText(error) : null,
      ],
    );
  }

  /** Marks invocations left pending by a previous application process as failed. */
  async recoverPending(finishedAt: number): Promise<number> {
    const result = await this.database.query(
      `
        update agent_recall.runtime_invocations
        set status = 'failed',
            finished_at = $1,
            error = 'AgentRecall stopped before this Runtime invocation finished.'
        where status = 'pending'
      `,
      [new Date(finishedAt).toISOString()],
    );
    return result.rowCount;
  }
}
