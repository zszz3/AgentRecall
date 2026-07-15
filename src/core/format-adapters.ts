import type {
  CodeBuddyConversationLine,
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

export const codebuddyAdapter: FormatAdapter = {
  format: "codebuddy",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as CodeBuddyConversationLine;
    if (line.type !== "message" || !line.role || !line.content) return null;
    if (line.role !== "user" && line.role !== "assistant") return null;

    const content = extractTextBlocks(line.content);
    if (!content) return null;

    // The CodeBuddy CLI injects a root user message whose text is the literal
    // launch keyword "code". It is not a real prompt, so drop it (otherwise it
    // becomes every session's title). Only the root message (no parentId) is
    // filtered, so a genuine later "code" reply is preserved.
    if (line.role === "user" && line.parentId == null && content.trim() === "code") return null;

    return {
      role: line.role,
      content,
      timestamp: typeof line.timestamp === "number" ? new Date(line.timestamp).toISOString() : "",
    };
  },
};

function roleFromRaw(raw: unknown): "user" | "assistant" | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : null;
  const role = record.role ?? message?.role ?? record.type;
  return role === "user" || role === "assistant" ? role : null;
}

function contentFromRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  const message = record.message && typeof record.message === "object" ? (record.message as Record<string, unknown>) : null;
  return record.content ?? record.text ?? message?.content ?? message?.text ?? "";
}

function timestampFromRaw(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const value = (raw as Record<string, unknown>).timestamp ?? (raw as Record<string, unknown>).time ?? (raw as Record<string, unknown>).createdAt;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  return "";
}

function genericAdapter(format: SessionFormat): FormatAdapter {
  return {
    format,
    parseLine(raw) {
      const role = roleFromRaw(raw);
      if (!role) return null;
      const content = extractTextBlocks(contentFromRaw(raw));
      if (!content) return null;
      return {
        role,
        content,
        timestamp: timestampFromRaw(raw),
      };
    },
  };
}

export function extractCursorUserQuery(text: string): string {
  const queryMatch = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (queryMatch) return queryMatch[1].trim();
  return text.replace(/<timestamp>[\s\S]*?<\/timestamp>\s*/gi, "").trim();
}

function timestampFromCursorRaw(raw: unknown): string {
  const direct = timestampFromRaw(raw);
  if (direct) return direct;
  const content = extractTextBlocks(contentFromRaw(raw));
  const match = content.match(/<timestamp>([^<]+)<\/timestamp>/i);
  return match ? match[1].trim() : "";
}

export const cursorAdapter: FormatAdapter = {
  format: "cursor",
  parseLine(raw) {
    const role = roleFromRaw(raw);
    if (!role) return null;
    let content = extractTextBlocks(contentFromRaw(raw));
    if (!content) return null;
    if (role === "user") {
      content = extractCursorUserQuery(content);
      if (!content) return null;
    }
    return {
      role,
      content,
      timestamp: timestampFromCursorRaw(raw),
    };
  },
};

export function cursorTimestampFromRow(raw: unknown): string {
  return timestampFromCursorRaw(raw);
}

export const openClawAdapter = genericAdapter("openclaw");
export const hermesAdapter = genericAdapter("hermes");
export const openCodeAdapter = genericAdapter("opencode");
export const codeWizAdapter = genericAdapter("codewiz");
export const traeAdapter = genericAdapter("trae");

export function getFormatForSource(source: SessionSource): SessionFormat {
  if (source === "codebuddy-cli") return "codebuddy";
  if (source === "codewiz-cli") return "codewiz";
  if (source === "openclaw") return "openclaw";
  if (source === "hermes") return "hermes";
  if (source === "opencode-cli") return "opencode";
  if (source === "cursor-agent") return "cursor";
  if (source === "trae") return "trae";
  return source === "claude-cli" || source === "claude-app" || source === "claude-internal" || source === "tclaude-cli" ? "claude" : "codex";
}

export function getAdapter(sourceOrFormat: SessionSource | SessionFormat): FormatAdapter {
  if (sourceOrFormat === "claude" || sourceOrFormat === "codex") {
    return sourceOrFormat === "claude" ? claudeAdapter : codexAdapter;
  }
  if (sourceOrFormat === "codebuddy") return codebuddyAdapter;
  if (sourceOrFormat === "codewiz") return codeWizAdapter;
  if (sourceOrFormat === "openclaw") return openClawAdapter;
  if (sourceOrFormat === "hermes") return hermesAdapter;
  if (sourceOrFormat === "opencode") return openCodeAdapter;
  if (sourceOrFormat === "cursor") return cursorAdapter;
  if (sourceOrFormat === "trae") return traeAdapter;
  const format = getFormatForSource(sourceOrFormat);
  if (format === "claude") return claudeAdapter;
  if (format === "codebuddy") return codebuddyAdapter;
  if (format === "codewiz") return codeWizAdapter;
  if (format === "openclaw") return openClawAdapter;
  if (format === "hermes") return hermesAdapter;
  if (format === "opencode") return openCodeAdapter;
  if (format === "cursor") return cursorAdapter;
  if (format === "trae") return traeAdapter;
  return codexAdapter;
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
  if (/^The beginning of the above subagent result is already visible/.test(trimmed)) return false;
  if (/^<system_notification>/.test(trimmed)) return false;
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
