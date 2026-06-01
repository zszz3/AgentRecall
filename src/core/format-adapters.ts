import type {
  ClaudeConversationLine,
  CodexConversationLine,
  SessionFormat,
  SessionMessage,
  SessionSource,
} from "./types";

export type ParsedLine = Omit<SessionMessage, "index"> | null;

export interface FormatAdapter {
  format: SessionFormat;
  parseLine(raw: unknown): ParsedLine;
}

function extractTextBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block: { type?: string; text?: string }) => {
      if (block.type === "tool_use" || block.type === "tool_result" || block.type === "input_image") return "";
      return block.text || "";
    })
    .filter(Boolean)
    .join("\n");
}

export const claudeAdapter: FormatAdapter = {
  format: "claude",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as ClaudeConversationLine;
    if (line.type !== "user" && line.type !== "assistant") return null;
    if (!line.message?.content) return null;

    const content = extractTextBlocks(line.message.content);
    if (!content) return null;

    return {
      role: line.type,
      content,
      timestamp: line.timestamp || "",
    };
  },
};

export const codexAdapter: FormatAdapter = {
  format: "codex",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as CodexConversationLine;

    if (line.type === "response_item" && line.payload?.type === "message" && line.payload.role) {
      if (line.payload.role !== "user" && line.payload.role !== "assistant") return null;
      const content = extractTextBlocks(line.payload.content);
      if (!content) return null;
      return {
        role: line.payload.role,
        content,
        timestamp: line.timestamp || "",
      };
    }

    if (line.type === "message" && line.role && line.content) {
      if (line.role !== "user" && line.role !== "assistant") return null;
      const content = extractTextBlocks(line.content);
      if (!content) return null;
      return {
        role: line.role,
        content,
        timestamp: line.timestamp || "",
      };
    }

    return null;
  },
};

export function getFormatForSource(source: SessionSource): SessionFormat {
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" ? "claude" : "codex";
}

export function getAdapter(sourceOrFormat: SessionSource | SessionFormat): FormatAdapter {
  if (sourceOrFormat === "claude" || sourceOrFormat === "codex") {
    return sourceOrFormat === "claude" ? claudeAdapter : codexAdapter;
  }
  return getFormatForSource(sourceOrFormat) === "claude" ? claudeAdapter : codexAdapter;
}

export function isMeaningfulUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^#\s*(AGENTS|CLAUDE)\.md/i.test(trimmed)) return false;
  if (
    /^<(system-reminder|environment_context|command-message|command-name|command-args|task-notification|local-command-stdout|local-command-stderr|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)[\s>]/.test(
      trimmed,
    )
  ) {
    return false;
  }
  if (trimmed.startsWith("Caveat:")) return false;
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(trimmed)) return false;
  if (/^\[Image:[^\]]*\]$/.test(trimmed)) return false;
  return true;
}

export function cleanTitle(text: string): string {
  const stripped = text.trim().replace(/^<[^>]+>\s*/, "");
  const firstLine = stripped
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (firstLine || stripped).slice(0, 120);
}
