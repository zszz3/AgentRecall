import type { PersistedAppStateV5 } from "./agent-hub-persistence";
import { asRecord } from "./agent-hub-persistence";

export function isPersistedAppStateV5(raw: unknown): raw is PersistedAppStateV5 {
  const record = asRecord(raw);
  return Boolean(
    record
      && record.version === 5
      && typeof record.workDir === "string"
      && Array.isArray(record.sessions)
      && Array.isArray(record.messages)
      && Array.isArray(record.events)
      && Array.isArray(record.tasks)
      && Array.isArray(record.taskMessages)
      && Array.isArray(record.taskEvents)
      && Array.isArray(record.teams)
      && Array.isArray(record.teamRuns)
      && (record.workflowNodeConversations === undefined || Array.isArray(record.workflowNodeConversations)),
  );
}
