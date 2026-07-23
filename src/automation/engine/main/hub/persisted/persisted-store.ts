import type { PersistedAppStateV5 } from "./agent-hub-persistence";

export interface AgentHubPersistedStore {
  load(): Promise<unknown | undefined>;
  save(payload: PersistedAppStateV5): Promise<void>;
  close(): Promise<void> | void;
  readonly label: string;
  readonly fileStoragePath?: string;
}
