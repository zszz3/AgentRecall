import type { AgentId, AgentTestEvent } from "../../../../shared/types";

export interface AgentTestUiState {
  agentId: string;
  state: "running" | "passed" | "failed";
  phase: string;
  message: string;
  startedAt: number;
  testedAt?: number;
  elapsedMs?: number;
  runtimeAgentId: AgentId;
  channelId: string;
  modelId: string;
  providerLabel: string;
  output?: string;
  transcript: AgentTestTranscriptItem[];
}

export interface AgentTestTranscriptItem {
  id: string;
  type: AgentTestEvent["type"];
  content: string;
  timestamp: number;
}
