import type { PostgresQueryable } from "../../../../../core/postgres/database";
import {
  asArray,
  asNumber,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
  optional,
  type RecordValue,
} from "./persisted-values";
import { jsonParameter, postgresJson, postgresTime } from "./postgres-values";

export class PostgresWorkflowRepository {
  async load(
    database: PostgresQueryable,
    activeWorkflowId: string | undefined,
  ): Promise<RecordValue> {
    const [
      workflowRows,
      draftMessageRows,
      progressRows,
      runRows,
      runOrderRows,
      runNodeRows,
      eventRows,
      artifactRows,
    ] = await Promise.all([
      database.query("select * from agent_recall.workflows order by created_at, id"),
      database.query(
        "select * from agent_recall.workflow_draft_messages order by workflow_id, sequence",
      ),
      database.query(
        "select * from agent_recall.workflow_run_progress order by workflow_id, sequence",
      ),
      database.query("select * from agent_recall.workflow_runs order by started_at, id"),
      database.query(
        "select * from agent_recall.workflow_run_order order by workflow_id, sequence",
      ),
      database.query(
        "select * from agent_recall.workflow_run_nodes order by run_id, sequence",
      ),
      database.query(
        "select * from agent_recall.workflow_events order by run_id, sequence",
      ),
      database.query(
        "select * from agent_recall.workflow_event_artifacts order by event_id, sequence",
      ),
    ]);

    const messagesByWorkflow = groupBy(draftMessageRows.rows, "workflow_id");
    const progressByWorkflow = groupBy(progressRows.rows, "workflow_id");
    const runIdsByWorkflow = new Map<string, string[]>();
    for (const value of runOrderRows.rows) {
      const row = asRecord(value);
      const workflowId = asString(row.workflow_id);
      const ids = runIdsByWorkflow.get(workflowId) ?? [];
      ids.push(asString(row.run_id));
      runIdsByWorkflow.set(workflowId, ids);
    }
    const nodesByRun = groupBy(runNodeRows.rows, "run_id");
    const eventsByRun = groupBy(eventRows.rows, "run_id");
    const artifactsByEvent = groupBy(artifactRows.rows, "event_id");

    const workflows = workflowRows.rows.map((value) => {
      const row = asRecord(value);
      const workflowId = asString(row.id);
      const workflow: RecordValue = {
        workflowId,
        sourceType: row.source_type === "official" ? "official" : "user",
        topologyLocked: row.topology_locked === true,
        title: row.title,
        status: row.status,
        revision: Number(row.revision),
        configuredAgentId: row.configured_agent_id,
        modelId: row.model_id,
        objective: row.objective,
        messages: (messagesByWorkflow.get(workflowId) ?? []).map((message) => {
          const draftMessage: RecordValue = {
            id: message.id,
            role: message.role,
            content: message.content,
          };
          optional(draftMessage, "events", postgresJson(message.events));
          return draftMessage;
        }),
        reply: row.reply,
        runProgress: mapProgress(progressByWorkflow.get(workflowId) ?? []),
        runContextDocument: row.run_context_document,
        contextDocument: row.context_document,
        runIds: runIdsByWorkflow.get(workflowId) ?? [],
        createdAt: postgresTime(row.created_at),
        updatedAt: postgresTime(row.updated_at),
      };
      optional(workflow, "workDir", row.work_dir);
      optional(workflow, "error", row.error);
      optional(workflow, "finalReport", row.final_report);
      optional(workflow, "definition", postgresJson(row.definition));
      optional(workflow, "workflowV2Plan", postgresJson(row.workflow_v2_plan));
      if (row.runtime_conversation !== null && row.runtime_conversation !== undefined) {
        workflow.runtimeConversation = postgresJson(row.runtime_conversation);
      }
      return workflow;
    });

    const runs = runRows.rows.map((value) => {
      const row = asRecord(value);
      const runId = asString(row.id);
      const run: RecordValue = {
        runId,
        workflowId: row.workflow_id,
        status: row.status,
        triggerSource: isWorkflowTriggerSource(row.trigger_source)
          ? row.trigger_source
          : "manual",
        progress: mapProgress(nodesByRun.get(runId) ?? []),
        events: (eventsByRun.get(runId) ?? []).map((event) =>
          mapEvent(event, artifactsByEvent.get(asString(event.id)) ?? [])),
        contextDocument: row.context_document,
        startedAt: postgresTime(row.started_at),
      };
      optional(run, "finalReport", row.final_report);
      if (row.finished_at !== null && row.finished_at !== undefined) {
        run.finishedAt = postgresTime(row.finished_at);
      }
      optional(run, "lastError", row.last_error);
      optional(run, "workflowV2Plan", postgresJson(row.workflow_v2_plan));
      optional(
        run,
        "configurationSnapshot",
        postgresJson(row.configuration_snapshot),
      );
      return run;
    });

    return { activeWorkflowId, workflows, runs };
  }

  async replace(database: PostgresQueryable, rawStore: unknown): Promise<void> {
    await database.query("delete from agent_recall.workflows");
    const store = asRecord(rawStore);
    const runsById = new Map(
      asArray(store.runs).map((run) => [asString(run.runId), run] as const),
    );

    for (const workflow of asArray(store.workflows)) {
      const workflowId = asString(workflow.workflowId);
      await database.query(
        `insert into agent_recall.workflows (
          id, title, status, revision, configured_agent_id, model_id, objective,
          work_dir, reply, error, run_context_document, context_document,
          final_report, runtime_conversation, definition, workflow_v2_plan,
          source_type, topology_locked, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14::jsonb, $15::jsonb, $16::jsonb, $17, $18, $19, $20
        )`,
        [
          workflowId,
          asString(workflow.title),
          asString(workflow.status),
          asNumber(workflow.revision),
          asString(workflow.configuredAgentId),
          asString(workflow.modelId),
          asString(workflow.objective),
          asOptionalString(workflow.workDir) ?? null,
          asString(workflow.reply),
          asOptionalString(workflow.error) ?? null,
          asString(workflow.runContextDocument),
          asString(workflow.contextDocument),
          asOptionalString(workflow.finalReport) ?? null,
          jsonParameter(workflow.runtimeConversation),
          jsonParameter(workflow.definition),
          jsonParameter(workflow.workflowV2Plan),
          workflow.sourceType === "official" ? "official" : "user",
          workflow.topologyLocked === true,
          new Date(asNumber(workflow.createdAt)),
          new Date(asNumber(workflow.updatedAt)),
        ],
      );

      for (const [sequence, message] of asArray(workflow.messages).entries()) {
        await database.query(
          `insert into agent_recall.workflow_draft_messages (
            id, workflow_id, role, content, events, sequence
          ) values ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            asString(message.id),
            workflowId,
            asString(message.role),
            asString(message.content),
            jsonParameter(message.events),
            sequence,
          ],
        );
      }
      for (const [sequence, item] of asArray(workflow.runProgress).entries()) {
        await insertProgress(
          database,
          "workflow_run_progress",
          "workflow_id",
          workflowId,
          item,
          sequence,
        );
      }

      const runIds = Array.isArray(workflow.runIds)
        ? workflow.runIds.filter((id): id is string => typeof id === "string")
        : [];
      for (const [sequence, runId] of runIds.entries()) {
        const run = runsById.get(runId);
        if (run) await this.insertRun(database, workflowId, run, sequence);
      }
    }
  }

  private async insertRun(
    database: PostgresQueryable,
    workflowId: string,
    run: RecordValue,
    sequence: number,
  ): Promise<void> {
    const runId = asString(run.runId);
    await database.query(
      `insert into agent_recall.workflow_runs (
        id, workflow_id, workflow_v2_plan, status, trigger_source,
        configuration_snapshot, context_document, final_report, started_at,
        finished_at, last_error
      ) values (
        $1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10, $11
      )`,
      [
        runId,
        workflowId,
        jsonParameter(run.workflowV2Plan),
        asString(run.status),
        isWorkflowTriggerSource(run.triggerSource) ? run.triggerSource : "manual",
        jsonParameter(run.configurationSnapshot),
        asString(run.contextDocument),
        asOptionalString(run.finalReport) ?? null,
        new Date(asNumber(run.startedAt)),
        optionalDate(run.finishedAt),
        asOptionalString(run.lastError) ?? null,
      ],
    );
    await database.query(
      `insert into agent_recall.workflow_run_order (
        workflow_id, run_id, sequence
      ) values ($1, $2, $3)`,
      [workflowId, runId, sequence],
    );

    for (const [itemSequence, item] of asArray(run.progress).entries()) {
      await insertProgress(
        database,
        "workflow_run_nodes",
        "run_id",
        runId,
        item,
        itemSequence,
      );
    }
    for (const [eventSequence, event] of asArray(run.events).entries()) {
      const eventId = `${runId}:event:${eventSequence}`;
      await database.query(
        `insert into agent_recall.workflow_events (
          id, run_id, node_id, type, occurred_at, attempt, task_id, detail,
          pass, summary, error, question, answer, sequence
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )`,
        [
          eventId,
          runId,
          asString(event.nodeId),
          asString(event.type),
          new Date(asNumber(event.at)),
          asOptionalNumber(event.attempt) ?? null,
          asOptionalString(event.taskId) ?? null,
          asOptionalString(event.detail) ?? null,
          typeof event.pass === "boolean" ? event.pass : null,
          asOptionalString(event.summary) ?? null,
          asOptionalString(event.error) ?? null,
          asOptionalString(event.question) ?? null,
          asOptionalString(event.answer) ?? null,
          eventSequence,
        ],
      );
      for (const [artifactSequence, artifact] of asArray(event.artifactRefs).entries()) {
        await database.query(
          `insert into agent_recall.workflow_event_artifacts (
            event_id, sequence, kind, title, content, path, url
          ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            eventId,
            artifactSequence,
            asString(artifact.kind),
            asString(artifact.title),
            asOptionalString(artifact.content) ?? null,
            asOptionalString(artifact.path) ?? null,
            asOptionalString(artifact.url) ?? null,
          ],
        );
      }
    }
  }
}

async function insertProgress(
  database: PostgresQueryable,
  table: "workflow_run_progress" | "workflow_run_nodes",
  ownerColumn: "workflow_id" | "run_id",
  ownerId: string,
  item: RecordValue,
  sequence: number,
): Promise<void> {
  await database.query(
    `insert into agent_recall.${table} (
      ${ownerColumn}, node_id, title, status, detail, task_id, input_request,
      input_summary, intervention, messages, outputs, telemetry, sequence
    ) values (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
      $10::jsonb, $11::jsonb, $12::jsonb, $13
    )`,
    [
      ownerId,
      asString(item.nodeId),
      asString(item.title),
      asString(item.status),
      asOptionalString(item.detail) ?? null,
      asOptionalString(item.taskId) ?? null,
      jsonParameter(item.inputRequest),
      jsonParameter(item.inputSummary),
      jsonParameter(item.intervention),
      jsonParameter(item.messages),
      jsonParameter(item.outputs),
      jsonParameter(item.telemetry),
      sequence,
    ],
  );
}

function groupBy(
  values: Array<Record<string, unknown>>,
  key: string,
): Map<string, RecordValue[]> {
  const grouped = new Map<string, RecordValue[]>();
  for (const value of values) {
    const row = asRecord(value);
    const id = asString(row[key]);
    const rows = grouped.get(id) ?? [];
    rows.push(row);
    grouped.set(id, rows);
  }
  return grouped;
}

function mapProgress(rows: RecordValue[]): RecordValue[] {
  return rows.map((row) => {
    const item: RecordValue = {
      nodeId: row.node_id,
      title: row.title,
      status: row.status,
    };
    optional(item, "detail", row.detail);
    optional(item, "taskId", row.task_id);
    optional(item, "inputRequest", postgresJson(row.input_request));
    optional(item, "inputSummary", postgresJson(row.input_summary));
    optional(item, "intervention", postgresJson(row.intervention));
    optional(item, "messages", postgresJson(row.messages));
    optional(item, "outputs", postgresJson(row.outputs));
    optional(item, "telemetry", postgresJson(row.telemetry));
    return item;
  });
}

function mapEvent(row: RecordValue, artifactRows: RecordValue[]): RecordValue {
  const event: RecordValue = {
    type: row.type,
    nodeId: row.node_id,
    at: postgresTime(row.occurred_at),
    sequence: asNumber(row.sequence),
  };
  optional(event, "attempt", row.attempt);
  optional(event, "taskId", row.task_id);
  optional(event, "detail", row.detail);
  if (typeof row.pass === "boolean") event.pass = row.pass;
  optional(event, "summary", row.summary);
  optional(event, "error", row.error);
  optional(event, "question", row.question);
  optional(event, "answer", row.answer);
  const artifacts = artifactRows.map((artifact) => {
    const value: RecordValue = { kind: artifact.kind, title: artifact.title };
    optional(value, "content", artifact.content);
    optional(value, "path", artifact.path);
    optional(value, "url", artifact.url);
    return value;
  });
  if (artifacts.length > 0) event.artifactRefs = artifacts;
  return event;
}

function optionalDate(value: unknown): Date | null {
  const number = asOptionalNumber(value);
  return number === undefined ? null : new Date(number);
}

function isWorkflowTriggerSource(
  value: unknown,
): value is "manual" | "scheduled" | "mcp" | "recovery" | "rerun" {
  return value === "manual"
    || value === "scheduled"
    || value === "mcp"
    || value === "recovery"
    || value === "rerun";
}
