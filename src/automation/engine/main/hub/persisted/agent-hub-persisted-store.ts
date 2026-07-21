import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ScheduledWorkflowRun,
  ScheduledWorkflowRunnerConfig,
  ScheduledWorkflowRunnerStatus,
  ScheduledWorkflowSchedule,
  WorkflowDraftState,
  WorkflowRunState,
} from "../../../shared/types";
import type { SqliteAppStore } from "./sqlite-store";
import { restoreScheduledWorkflowStoreCollections, restoreWorkflowStoreCollections } from "../workflow/agent-hub-workflow-restore";
import { asRecord, type PersistedAppStateV5 } from "./agent-hub-persistence";

export async function loadPersistedPayload(input: {
  storagePath: string;
  sqliteStoreFactory: (storagePath: string) => SqliteAppStore;
  warn: (message: string, error: unknown) => void;
}): Promise<{
  payload: unknown | undefined;
  sqliteStore: SqliteAppStore | undefined;
  shouldBootstrapPersist: boolean;
}> {
  if (path.extname(input.storagePath) === ".db") {
    const sqliteStore = input.sqliteStoreFactory(input.storagePath);
    try {
      const payload = await sqliteStore.load();
      return {
        payload,
        sqliteStore,
        shouldBootstrapPersist: payload === undefined,
      };
    } catch (error) {
      input.warn(`Failed to load app state from SQLite ${input.storagePath}:`, error);
      return {
        payload: undefined,
        sqliteStore,
        shouldBootstrapPersist: true,
      };
    }
  }

  try {
    const raw = await readFile(input.storagePath, "utf8");
    return {
      payload: JSON.parse(raw) as unknown,
      sqliteStore: undefined,
      shouldBootstrapPersist: false,
    };
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOENT") {
      input.warn(`Failed to load chat history from ${input.storagePath}:`, error);
    }
    return {
      payload: undefined,
      sqliteStore: undefined,
      shouldBootstrapPersist: false,
    };
  }
}

export function restoreWorkflowStoreState(input: {
  rawStore: unknown;
  workflowsTarget: Map<string, WorkflowDraftState>;
  workflowRunsTarget: Map<string, WorkflowRunState>;
  restoreWorkflowDraft: (raw: unknown) => WorkflowDraftState | undefined;
  restoreWorkflowRun: (raw: unknown) => WorkflowRunState | undefined;
}): { ok: boolean; activeWorkflowId: string | undefined } {
  input.workflowsTarget.clear();
  input.workflowRunsTarget.clear();

  const restored = restoreWorkflowStoreCollections(input.rawStore, {
    restoreWorkflowDraft: input.restoreWorkflowDraft,
    restoreWorkflowRun: input.restoreWorkflowRun,
  });
  if (!restored) {
    return { ok: false, activeWorkflowId: undefined };
  }

  for (const workflow of restored.workflows) input.workflowsTarget.set(workflow.workflowId, workflow);
  for (const run of restored.runs) input.workflowRunsTarget.set(run.runId, run);
  return {
    ok: true,
    activeWorkflowId: restored.activeWorkflowId,
  };
}

export function restoreScheduledWorkflowStoreState(input: {
  rawStore: unknown;
  schedulesTarget: Map<string, ScheduledWorkflowSchedule>;
  runsTarget: Map<string, ScheduledWorkflowRun>;
  restoreRunnerConfig: (raw: unknown) => ScheduledWorkflowRunnerConfig | undefined;
  restoreSchedule: (raw: unknown) => ScheduledWorkflowSchedule | undefined;
  restoreRun: (raw: unknown) => ScheduledWorkflowRun | undefined;
}): {
  activeScheduledWorkflowId: string | undefined;
  runnerConfig: ScheduledWorkflowRunnerConfig;
  runnerStatus: ScheduledWorkflowRunnerStatus;
} {
  input.schedulesTarget.clear();
  input.runsTarget.clear();

  const restored = restoreScheduledWorkflowStoreCollections(input.rawStore, {
    restoreRunnerConfig: input.restoreRunnerConfig,
    restoreSchedule: input.restoreSchedule,
    restoreRun: input.restoreRun,
  });
  for (const schedule of restored.schedules) input.schedulesTarget.set(schedule.scheduleId, schedule);
  for (const run of restored.runs) input.runsTarget.set(run.runId, run);
  return {
    activeScheduledWorkflowId: restored.activeScheduleId,
    runnerConfig: restored.runnerConfig,
    runnerStatus: restored.runnerStatus,
  };
}

export async function writePersistedPayload(input: {
  storagePath: string;
  sqliteStore: SqliteAppStore | undefined;
  payload: PersistedAppStateV5;
}): Promise<void> {
  if (input.sqliteStore) {
    await input.sqliteStore.save(input.payload);
    return;
  }

  const tempPath = `${input.storagePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(input.storagePath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(input.payload, null, 2)}\n`, "utf8");
  await rename(tempPath, input.storagePath);
}
