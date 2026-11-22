/** One MCP server in the personal Library: a local command or a remote HTTP endpoint. */
export type LibraryMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string> }
  | { url: string; headers?: Record<string, string> };

export type LibraryMcpServers = Record<string, LibraryMcpServer>;

/** Names every supported agent accepts as a key, including as a bare TOML key in Codex. */
export const LIBRARY_MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** AgentRecall registers its own Gateway under this name; the Library never writes it. */
export const RESERVED_MCP_NAME = "agent-recall";
