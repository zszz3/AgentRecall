import type { IndexedSession, SessionMessage, SessionSearchResult, SessionTraceEvent } from "./types";

const SOURCE_LABEL: Record<string, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude Code",
  "claude-internal": "Claude Code Internal",
  "codex-cli": "Codex",
  "codex-app": "Codex",
  "codex-internal": "Codex Internal",
  "tclaude-cli": "TClaude",
  "tcodex-cli": "TCodex",
  "codebuddy-cli": "CodeBuddy CLI",
  "codewiz-cli": "CodeWiz",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  "opencode-cli": "OpenCode",
  "cursor-agent": "Cursor Agent",
  trae: "Trae",
};

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatMessageTime(ts: string): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function traceMarker(event: SessionTraceEvent): string {
  if (event.kind === "tool_call") return "→";
  if (event.status === "success") return "✓";
  if (event.status === "failure") return "✗";
  return "•";
}

function traceTitle(event: SessionTraceEvent): string {
  const eventType = event.eventType ? ` · ${event.eventType}` : "";
  const callId = event.callId ? ` · \`${event.callId}\`` : "";
  const time = formatMessageTime(event.timestamp);
  const timeSuffix = time ? ` · *${time}*` : "";
  return `${traceMarker(event)} ${event.title}${eventType}${callId}${timeSuffix}`;
}

function formatTraceMarkdown(traceEvents: SessionTraceEvent[]): string[] {
  if (traceEvents.length === 0) return [];
  return [
    "## Tool Trace",
    "",
    ...traceEvents.flatMap((event) => [
      `### ${traceTitle(event)}`,
      "",
      event.detail ? `\`\`\`text\n${event.detail}\n\`\`\`` : "_No detail captured._",
      "",
      "---",
      "",
    ]),
  ];
}

export function formatSessionMarkdown(
  session: SessionSearchResult | IndexedSession,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[] = [],
): string {
  const title = "displayTitle" in session ? session.displayTitle : session.firstQuestion || session.originalTitle;
  const source = SOURCE_LABEL[session.source] || session.source;
  const header = [
    `# ${title}`,
    "",
    `${source} · \`${session.projectPath}\` · ${new Date(session.timestamp).toLocaleString()} · ${messages.length} messages`,
    "",
    "---",
    "",
  ];
  const body = messages.flatMap((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    const time = formatMessageTime(message.timestamp);
    return [`## ${time ? `${role} (${time})` : role}`, "", message.content, "", "---", ""];
  });
  return [...header, ...body, ...formatTraceMarkdown(traceEvents)].join("\n");
}

export function formatSessionPlainText(
  session: SessionSearchResult | IndexedSession,
  messages: SessionMessage[],
  traceEvents: SessionTraceEvent[] = [],
): string {
  return formatSessionMarkdown(session, messages, traceEvents).replace(/^#+\s/gm, "");
}
