import type {
  RuntimeInvocationRecorder,
  RuntimeInvocationStart,
  RuntimeInvocationStatus,
  RuntimeSessionBinding,
} from "../../automation/engine/main/agents/runtime/runtime-invocation-recorder";
import { runtimeInvocationErrorMessage } from "../../automation/engine/main/agents/runtime/runtime-invocation-recorder";
import type { SqliteDatabase } from "./database";
import { sqliteJsonParameter, sqliteText } from "./values";

/** Stores AgentRecall Runtime invocation lifecycle records in SQLite. */
export class SqliteRuntimeInvocationRepository implements RuntimeInvocationRecorder {
  constructor(private readonly database: SqliteDatabase) {}

  async begin(input: RuntimeInvocationStart): Promise<void> {
    this.database.run(
      `
        INSERT INTO runtime_invocations (
          id, initiator, surface, role, owner_reference, runtime_id,
          channel_id, environment_id, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `,
      sqliteText(input.id),
      input.initiator,
      input.invocation.surface,
      input.invocation.role ? sqliteText(input.invocation.role) : null,
      sqliteJsonParameter(input.invocation.ownerReference ?? {}) ?? "{}",
      input.runtimeId,
      input.channelId ? sqliteText(input.channelId) : null,
      sqliteText(input.environmentId ?? "local"),
      Math.floor(input.startedAt),
    );
  }

  async bind(invocationId: string, binding: RuntimeSessionBinding): Promise<void> {
    this.database.run(
      `
        INSERT INTO runtime_session_bindings (
          invocation_id, runtime_id, channel_id, environment_id,
          runtime_session_id, runtime_turn_id, relation, bound_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (invocation_id, runtime_id, channel_id, environment_id, runtime_session_id)
        DO UPDATE SET
          runtime_turn_id = COALESCE(excluded.runtime_turn_id, runtime_session_bindings.runtime_turn_id),
          relation = excluded.relation,
          bound_at = min(excluded.bound_at, runtime_session_bindings.bound_at)
      `,
      sqliteText(invocationId),
      binding.runtimeId,
      sqliteText(binding.channelId ?? ""),
      sqliteText(binding.environmentId ?? "local"),
      sqliteText(binding.sessionId),
      binding.turnId ? sqliteText(binding.turnId) : null,
      binding.relation,
      Math.floor(binding.boundAt),
    );
  }

  async finish(
    invocationId: string,
    status: Exclude<RuntimeInvocationStatus, "pending">,
    finishedAt: number,
    error?: string,
  ): Promise<void> {
    this.database.run(
      `
        UPDATE runtime_invocations
        SET status = ?, finished_at = ?, error = ?
        WHERE id = ? AND status = 'pending'
      `,
      status,
      Math.floor(finishedAt),
      error ? sqliteText(runtimeInvocationErrorMessage(error)) : null,
      sqliteText(invocationId),
    );
  }

  /** Marks invocations left pending by a previous application process as failed. */
  async recoverPending(finishedAt: number): Promise<number> {
    const result = this.database.run(
      `
        UPDATE runtime_invocations
        SET status = 'failed',
            finished_at = ?,
            error = 'AgentRecall stopped before this Runtime invocation finished.'
        WHERE status = 'pending'
      `,
      Math.floor(finishedAt),
    );
    return result.changes;
  }
}
