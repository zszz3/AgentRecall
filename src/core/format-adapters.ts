import type {
  CodeBuddyConversationLine,
  ClaudeConversationLine,
  CodexConversationLine,
  SessionFormat,
  SessionAttachment,
  SessionMessage,
  SessionSource,
} from "./types";
import { sessionSourceDescriptor } from "./session-sources";

export type ParsedLine = Omit<SessionMessage, "index"> | null;

export interface FormatAdapter {
  format: SessionFormat;
  parseLine(raw: unknown): ParsedLine;
}

function attachmentPreviewKind(mimeType: string): SessionAttachment["previewKind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("text/") || /json|xml|yaml/.test(mimeType)) return "text";
  return "file";
}

function attachmentFileName(mimeType: string, index: number, explicit?: unknown): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim().split(/[\\/]/).pop() || `attachment-${index + 1}`;
  const extension = mimeType === "image/png"
    ? "png"
    : mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "application/pdf"
        ? "pdf"
        : "bin";
  return index === 0 ? `image.${extension}` : `attachment-${index + 1}.${extension}`;
}

function attachmentFromBlock(block: Record<string, unknown>, index: number): SessionAttachment | null {
  const type = typeof block.type === "string" ? block.type : "";
  if (!["input_image", "image", "input_file", "file_attachment"].includes(type)) return null;
  const source = block.source && typeof block.source === "object"
    ? block.source as Record<string, unknown>
    : null;
  const rawValue = block.image_url
    ?? block.file_path
    ?? block.path
    ?? source?.data
    ?? source?.path;
  if (typeof rawValue !== "string" || !rawValue.trim()) return null;
  const value = rawValue.trim();
  const dataMatch = value.match(/^data:([^;,]+);base64,(.+)$/s);
  const sourceMime = typeof source?.media_type === "string" ? source.media_type : undefined;
  const mimeType = dataMatch?.[1]
    || sourceMime
    || (type.includes("image") ? "image/png" : "application/octet-stream");
  const sourceKind = dataMatch || source?.type === "base64" ? "inline" : "path";
  const sourceValue = dataMatch?.[2] ?? value;
  const fileName = attachmentFileName(
    mimeType,
    index,
    block.filename ?? block.name ?? block.file_name ?? (sourceKind === "path" ? sourceValue : undefined),
  );
  return {
    id: `attachment-${index + 1}`,
    fileName,
    mimeType,
    previewKind: attachmentPreviewKind(mimeType),
    status: "available",
    source: { kind: sourceKind, value: sourceValue },
  };
}

function extractContentBlocks(content: unknown): { text: string; attachments?: SessionAttachment[] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };
  const texts: string[] = [];
  const attachments: SessionAttachment[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const attachment = attachmentFromBlock(block, attachments.length);
    if (attachment) {
      attachments.push(attachment);
      continue;
    }
    if (block.type === "tool_use" || block.type === "tool_result") continue;
    if (typeof block.text === "string" && block.text) texts.push(block.text);
  }
  return {
    text: texts.join("\n") || (attachments.length > 0 ? "[Attachment]" : ""),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

function extractTextBlocks(content: unknown): string {
  return extractContentBlocks(content).text;
}

export const claudeAdapter: FormatAdapter = {
  format: "claude",
  parseLine(raw) {
    if (!raw || typeof raw !== "object") return null;
    const line = raw as ClaudeConversationLine;
    if (line.type !== "user" && line.type !== "assistant") return null;
    if (!line.message?.content) return null;

    const parsed = extractContentBlocks(line.message.content);
    if (!parsed.text) return null;

    return {
      role: line.type,
      content: parsed.text,
      timestamp: line.timestamp || "",
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
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
      const parsed = extractContentBlocks(line.payload.content);
      if (!parsed.text) return null;
      return {
        role: line.payload.role,
        content: parsed.text,
        timestamp: line.timestamp || "",
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
      };
    }

    if (line.type === "message" && line.role && line.content) {
      if (line.role !== "user" && line.role !== "assistant") return null;
      const parsed = extractContentBlocks(line.content);
      if (!parsed.text) return null;
      return {
        role: line.role,
        content: parsed.text,
        timestamp: line.timestamp || "",
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
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

    const parsed = extractContentBlocks(line.content);
    const content = parsed.text;
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
      ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
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
      const parsed = extractContentBlocks(contentFromRaw(raw));
      if (!parsed.text) return null;
      return {
        role,
        content: parsed.text,
        timestamp: timestampFromRaw(raw),
        ...(parsed.attachments ? { attachments: parsed.attachments } : {}),
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
export const zcodeAdapter = genericAdapter("zcode");
export const codeWizAdapter = genericAdapter("codewiz");
export const traeAdapter = genericAdapter("trae");
export const qoderAdapter = genericAdapter("qoder");

export function getFormatForSource(source: SessionSource): SessionFormat {
  return sessionSourceDescriptor(source).format;
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
  if (sourceOrFormat === "zcode") return zcodeAdapter;
  if (sourceOrFormat === "cursor") return cursorAdapter;
  if (sourceOrFormat === "trae") return traeAdapter;
  if (sourceOrFormat === "qoder") return qoderAdapter;
  const format = getFormatForSource(sourceOrFormat);
  if (format === "claude") return claudeAdapter;
  if (format === "codebuddy") return codebuddyAdapter;
  if (format === "codewiz") return codeWizAdapter;
  if (format === "openclaw") return openClawAdapter;
  if (format === "hermes") return hermesAdapter;
  if (format === "opencode") return openCodeAdapter;
  if (format === "zcode") return zcodeAdapter;
  if (format === "cursor") return cursorAdapter;
  if (format === "trae") return traeAdapter;
  if (format === "qoder") return qoderAdapter;
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
