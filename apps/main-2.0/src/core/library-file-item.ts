/** Slash commands and subagents: kinds of Library items stored as one file per item in each agent. */
export type LibraryFileKind = "commands" | "subagents";

/**
 * One slash command or subagent. A command's body is the prompt, with
 * `$ARGUMENTS` where the user's arguments go; a subagent's body is its
 * instructions.
 */
export interface LibraryFileItem {
  description: string;
  body: string;
}

export type LibraryFileItems = Record<string, LibraryFileItem>;
