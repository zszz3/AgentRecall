import { z } from "zod";
import { LIBRARY_AGENT_IDS, type LibraryAgentId } from "../../core/library-agent-ids";
import { defineIpcRequest } from "./contract";

/**
 * - off: AgentRecall does not write this agent's file.
 * - synced: the file holds the Library block exactly as AgentRecall last wrote it.
 * - conflict: the block was edited, removed or written by something else; nothing is written until the user picks a version.
 * - magpie: magpie's Library manages the file; AgentRecall leaves it alone.
 * - unsupported: the agent has no user-level instructions file.
 */
export type LibraryAgentState = "off" | "synced" | "conflict" | "magpie" | "unsupported";

export interface LibraryAgentStatus {
  id: LibraryAgentId;
  name: string;
  installed: boolean;
  enabled: boolean;
  state: LibraryAgentState;
  file: string | null;
  /** While this file exists the agent reads it instead of `file`, so the Library block has no effect. */
  override: string | null;
}

export interface PersonalLibrarySnapshot {
  instructions: string;
  agents: LibraryAgentStatus[];
}

export interface LibraryPreview {
  file: string;
  before: string;
  after: string;
}

export interface LibraryImportCandidate {
  text: string;
  agents: LibraryAgentId[];
}

const agentId: z.ZodType<LibraryAgentId> = z.enum(LIBRARY_AGENT_IDS);
const paragraph = z.string().max(20_000);

export const PERSONAL_LIBRARY_IPC = {
  snapshot: defineIpcRequest("personal-library:snapshot", z.tuple([])),
  saveInstructions: defineIpcRequest("personal-library:save-instructions", z.tuple([z.string().max(200_000)])),
  preview: defineIpcRequest("personal-library:preview", z.tuple([agentId, z.boolean()])),
  setAgentEnabled: defineIpcRequest("personal-library:set-agent-enabled", z.tuple([agentId, z.boolean()])),
  resolveConflict: defineIpcRequest("personal-library:resolve-conflict", z.tuple([agentId, z.enum(["use-file", "overwrite"])])),
  importCandidates: defineIpcRequest("personal-library:import-candidates", z.tuple([])),
  importParagraphs: defineIpcRequest("personal-library:import-paragraphs", z.tuple([z.array(paragraph).max(500), z.boolean()])),
} as const;
