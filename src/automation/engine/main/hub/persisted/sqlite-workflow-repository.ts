import { replaceAggregateSet } from "./sqlite-aggregate-sync";
import {
  asArray,
  asNumber,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
  json,
  optional,
  parseJson,
  type DatabaseSync,
  type RecordValue,
} from "./sqlite-values";

export class SqliteWorkflowRepository {
  constructor(private readonly readSetting: (db: DatabaseSync, key: string) => string | undefined) {}

  sync(db: DatabaseSync, rawStore: unknown): void {
    const store = asRecord(rawStore);
    const workflows = asArray(store.workflows);
    const changedRunIds = new Set(
      workflows.flatMap((workflow) => Array.isArray(workflow.runIds)
        ? workflow.runIds.filter((runId): runId is string => typeof runId === "string")
        : []),
    );
    replaceAggregateSet({
      db,
      table: "workflows",
      idColumn: "id",
      aggregates: workflows,
      idOf: (workflow) => asString(workflow.workflowId),
      idFromRow: (row) => asString(asRecord(row).id),
      write: () => this.saveWorkflows(db, {
        ...store,
        workflows,
        runs: asArray(store.runs).filter((run) => changedRunIds.has(asString(run.runId))),
      }),
    });
  }

  private saveWorkflows(db: DatabaseSync, rawStore: unknown): void {
    const store = asRecord(rawStore);
    const runs = asArray(store.runs);
    const runsById = new Map(runs.map((run) => [asString(run.runId), run]));
    for (const workflow of asArray(store.workflows)) {
      const workflowId = asString(workflow.workflowId);
      db.prepare(
        `insert into workflows
         (id, source_type, topology_locked, title, status, revision, configured_agent_id, model_id, objective, work_dir,
          reply, error, run_context_document, context_document, final_report, runtime_conversation_json,
          definition_json, workflow_v2_plan_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        workflowId,
        workflow.sourceType === "official" ? "official" : "user",
        workflow.topologyLocked === true ? 1 : 0,
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
        json(workflow.runtimeConversation),
        json(workflow.definition),
        json(workflow.workflowV2Plan),
        asNumber(workflow.createdAt),
        asNumber(workflow.updatedAt),
      );
      asArray(workflow.messages).forEach((message, sequence) => {
        db.prepare(
          "insert into workflow_draft_messages (id, workflow_id, role, content, sequence) values (?, ?, ?, ?, ?)",
        ).run(asString(message.id), workflowId, asString(message.role), asString(message.content), sequence);
      });
      asArray(workflow.runProgress).forEach((item, sequence) => {
        db.prepare(
          `insert into workflow_run_progress
           (workflow_id, node_id, title, status, detail, task_id, input_request_json, intervention_json, sequence)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workflowId,
          asString(item.nodeId),
          asString(item.title),
          asString(item.status),
          asOptionalString(item.detail) ?? null,
          asOptionalString(item.taskId) ?? null,
          json(item.inputRequest),
          json(item.intervention),
          sequence,
        );
      });

      const orderedRunIds = Array.isArray(workflow.runIds) ? workflow.runIds.filter((id): id is string => typeof id === "string") : [];
      orderedRunIds.forEach((runId, sequence) => {
        const run = runsById.get(runId);
        if (run) this.saveRun(db, workflowId, run, sequence);
      });
    }
  }

  private saveRun(db: DatabaseSync, workflowId: string, run: RecordValue, sequence: number): void {
    const runId = asString(run.runId);
    db.prepare(
      `insert into workflow_runs
       (id, workflow_id, workflow_v2_plan_json, status, context_document, final_report, started_at, finished_at, last_error)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      workflowId,
      json(run.workflowV2Plan),
      asString(run.status),
      asString(run.contextDocument),
      asOptionalString(run.finalReport) ?? null,
      asNumber(run.startedAt),
      asOptionalNumber(run.finishedAt) ?? null,
      asOptionalString(run.lastError) ?? null,
    );
    db.prepare("insert into workflow_run_order (workflow_id, run_id, sequence) values (?, ?, ?)").run(workflowId, runId, sequence);
    asArray(run.progress).forEach((item, itemSequence) => {
      db.prepare(
        `insert into workflow_run_nodes
         (run_id, node_id, title, status, detail, task_id, input_request_json, intervention_json, sequence)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        asString(item.nodeId),
        asString(item.title),
        asString(item.status),
        asOptionalString(item.detail) ?? null,
        asOptionalString(item.taskId) ?? null,
        json(item.inputRequest),
        json(item.intervention),
        itemSequence,
      );
    });
    asArray(run.events).forEach((event, eventSequence) => {
      const eventId = `${runId}:event:${eventSequence}`;
      db.prepare(
        `insert into workflow_events
         (id, run_id, node_id, type, at, attempt, task_id, detail, pass, summary, error, question, answer, sequence)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId,
        runId,
        asString(event.nodeId),
        asString(event.type),
        asNumber(event.at),
        asOptionalNumber(event.attempt) ?? null,
        asOptionalString(event.taskId) ?? null,
        asOptionalString(event.detail) ?? null,
        typeof event.pass === "boolean" ? (event.pass ? 1 : 0) : null,
        asOptionalString(event.summary) ?? null,
        asOptionalString(event.error) ?? null,
        asOptionalString(event.question) ?? null,
        asOptionalString(event.answer) ?? null,
        eventSequence,
      );
      asArray(event.artifactRefs).forEach((artifact, artifactSequence) => {
        db.prepare(
          `insert into workflow_event_artifacts
           (event_id, sequence, kind, title, content, path, url) values (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          artifactSequence,
          asString(artifact.kind),
          asString(artifact.title),
          asOptionalString(artifact.content) ?? null,
          asOptionalString(artifact.path) ?? null,
          asOptionalString(artifact.url) ?? null,
        );
      });
    });
  }

  load(db: DatabaseSync): RecordValue {
    const workflows = db
      .prepare("select * from workflows order by created_at, id")
      .all()
      .map(asRecord)
      .map((row) => this.loadWorkflow(db, row));
    const runs = db
      .prepare("select r.* from workflow_runs r join workflow_run_order o on o.run_id = r.id order by o.workflow_id, o.sequence")
      .all()
      .map(asRecord)
      .map((row) => this.loadRun(db, row));
    return {
      activeWorkflowId: this.readSetting(db, "active_workflow_id"),
      workflows,
      runs,
    };
  }

  private loadWorkflow(db: DatabaseSync, row: RecordValue): RecordValue {
    const workflowId = asString(row.id);
    const runIds = db
      .prepare("select run_id from workflow_run_order where workflow_id = ? order by sequence")
      .all(workflowId)
      .map((item) => asString(asRecord(item).run_id));
    const workflow: RecordValue = {
      workflowId,
      sourceType: row.source_type === "official" ? "official" : "user",
      topologyLocked: row.topology_locked === 1,
      title: row.title,
      status: row.status,
      revision: row.revision,
      configuredAgentId: row.configured_agent_id,
      modelId: row.model_id,
      objective: row.objective,
      messages: db
        .prepare("select id, role, content from workflow_draft_messages where workflow_id = ? order by sequence")
        .all(workflowId)
        .map((message) => {
          const item = asRecord(message);
          return { id: item.id, role: item.role, content: item.content };
        }),
      reply: row.reply,
      runProgress: this.loadProgress(db, "workflow_run_progress", "workflow_id", workflowId),
      runContextDocument: row.run_context_document,
      contextDocument: row.context_document,
      runIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    optional(workflow, "workDir", row.work_dir);
    optional(workflow, "error", row.error);
    optional(workflow, "finalReport", row.final_report);
    optional(workflow, "definition", parseJson(row.definition_json));
    optional(workflow, "workflowV2Plan", parseJson(row.workflow_v2_plan_json));
    if (row.runtime_conversation_json) workflow.runtimeConversation = parseJson(row.runtime_conversation_json);
    return workflow;
  }

  private loadRun(db: DatabaseSync, row: RecordValue): RecordValue {
    const runId = asString(row.id);
    const run: RecordValue = {
      runId,
      workflowId: row.workflow_id,
      status: row.status,
      progress: this.loadProgress(db, "workflow_run_nodes", "run_id", runId),
      events: db
        .prepare("select * from workflow_events where run_id = ? order by sequence")
        .all(runId)
        .map(asRecord)
        .map((event) => this.loadWorkflowEvent(db, event)),
      contextDocument: row.context_document,
      startedAt: row.started_at,
    };
    optional(run, "finalReport", row.final_report);
    optional(run, "finishedAt", row.finished_at);
    optional(run, "lastError", row.last_error);
    optional(run, "workflowV2Plan", parseJson(row.workflow_v2_plan_json));
    return run;
  }

  private loadProgress(db: DatabaseSync, table: string, ownerColumn: string, ownerId: string): RecordValue[] {
    return db
      .prepare(`select * from ${table} where ${ownerColumn} = ? order by sequence`)
      .all(ownerId)
      .map(asRecord)
      .map((row) => {
        const item: RecordValue = { nodeId: row.node_id, title: row.title, status: row.status };
        optional(item, "detail", row.detail);
        optional(item, "taskId", row.task_id);
        optional(item, "inputRequest", parseJson(row.input_request_json));
        optional(item, "intervention", parseJson(row.intervention_json));
        return item;
      });
  }

  private loadWorkflowEvent(db: DatabaseSync, row: RecordValue): RecordValue {
    const event: RecordValue = { type: row.type, nodeId: row.node_id, at: row.at };
    optional(event, "attempt", row.attempt);
    optional(event, "taskId", row.task_id);
    optional(event, "detail", row.detail);
    if (row.pass !== null && row.pass !== undefined) event.pass = row.pass === 1;
    optional(event, "summary", row.summary);
    optional(event, "error", row.error);
    optional(event, "question", row.question);
    optional(event, "answer", row.answer);
    const artifacts = db
      .prepare("select * from workflow_event_artifacts where event_id = ? order by sequence")
      .all(row.id)
      .map(asRecord)
      .map((artifact) => {
        const value: RecordValue = { kind: artifact.kind, title: artifact.title };
        optional(value, "content", artifact.content);
        optional(value, "path", artifact.path);
        optional(value, "url", artifact.url);
        return value;
      });
    if (artifacts.length > 0) event.artifactRefs = artifacts;
    return event;
  }
}
