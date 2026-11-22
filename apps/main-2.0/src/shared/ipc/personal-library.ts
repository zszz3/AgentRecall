import { z } from "zod";
import { LIBRARY_AGENT_IDS, type LibraryAgentId } from "../../core/library-agent-ids";
import type { LibraryMcpServer, LibraryMcpServers } from "../../core/library-mcp-server";
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

/**
 * - off: AgentRecall does not write this agent's MCP servers.
 * - synced: every Library server is in the file as AgentRecall last wrote it.
 * - conflict: some servers were edited or removed outside AgentRecall, or the file already has a server with that name; `conflicts` names them.
 * - error: the file cannot be read; `problem` says why.
 * - unsupported: the agent has no user-level MCP file AgentRecall can write.
 */
export type LibraryMcpAgentState = "off" | "synced" | "conflict" | "error" | "unsupported";

export interface LibraryMcpAgentStatus {
  id: LibraryAgentId;
  name: string;
  installed: boolean;
  enabled: boolean;
  state: LibraryMcpAgentState;
  file: string | null;
  conflicts: string[];
  problem: string | null;
}

export interface PersonalLibrarySnapshot {
  instructions: string;
  agents: LibraryAgentStatus[];
  mcp: { servers: LibraryMcpServers; agents: LibraryMcpAgentStatus[] };
}

/** Server names a change would add, replace or remove in one agent's file, and the ones it would leave as they are. */
export interface LibraryMcpPreview {
  file: string;
  add: string[];
  update: string[];
  remove: string[];
  conflicts: string[];
}

export interface LibraryMcpImportCandidate {
  name: string;
  server: LibraryMcpServer;
  agents: LibraryAgentId[];
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
const stringMap = z.record(z.string().max(200), z.string().max(10_000));
export const libraryMcpServerSchema: z.ZodType<LibraryMcpServer> = z.union([
  z.strictObject({ command: z.string().trim().min(1).max(2_000), args: z.array(z.string().max(10_000)).max(200).optional(), env: stringMap.optional() }),
  z.strictObject({ url: z.string().regex(/^https?:\/\/\S+$/).max(2_000), headers: stringMap.optional() }),
]);
export const libraryMcpServersSchema: z.ZodType<LibraryMcpServers> = z.record(z.string().max(200), libraryMcpServerSchema);

export const PERSONAL_LIBRARY_IPC = {
  snapshot: defineIpcRequest("personal-library:snapshot", z.tuple([])),
  saveInstructions: defineIpcRequest("personal-library:save-instructions", z.tuple([z.string().max(200_000)])),
  preview: defineIpcRequest("personal-library:preview", z.tuple([agentId, z.boolean()])),
  setAgentEnabled: defineIpcRequest("personal-library:set-agent-enabled", z.tuple([agentId, z.boolean()])),
  resolveConflict: defineIpcRequest("personal-library:resolve-conflict", z.tuple([agentId, z.enum(["use-file", "overwrite"])])),
  importCandidates: defineIpcRequest("personal-library:import-candidates", z.tuple([])),
  importParagraphs: defineIpcRequest("personal-library:import-paragraphs", z.tuple([z.array(paragraph).max(500), z.boolean()])),
  saveMcpServers: defineIpcRequest("personal-library:save-mcp-servers", z.tuple([libraryMcpServersSchema])),
  previewMcp: defineIpcRequest("personal-library:preview-mcp", z.tuple([agentId, z.boolean()])),
  setMcpAgentEnabled: defineIpcRequest("personal-library:set-mcp-agent-enabled", z.tuple([agentId, z.boolean()])),
  overwriteMcp: defineIpcRequest("personal-library:overwrite-mcp", z.tuple([agentId])),
  mcpImportCandidates: defineIpcRequest("personal-library:mcp-import-candidates", z.tuple([])),
  importMcpServers: defineIpcRequest("personal-library:import-mcp-servers", z.tuple([z.array(z.strictObject({ name: z.string().max(200), server: libraryMcpServerSchema })).max(500)])),
} as const;
