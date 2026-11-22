/** Agents the personal Library can write to, in the order the Library page lists them. Browser-safe. */
export const LIBRARY_AGENT_IDS = ["claude-code", "codex", "gemini", "opencode", "pi", "stepcode", "qwen", "cursor", "dsh", "zcode"] as const;
export type LibraryAgentId = typeof LIBRARY_AGENT_IDS[number];
