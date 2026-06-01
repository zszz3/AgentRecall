import type { IndexedSession, SessionMessage, SessionSearchResult } from "./types";

const SOURCE_LABEL: Record<string, string> = {
  "claude-cli": "Claude Code",
  "claude-app": "Claude App",
  "claude-internal": "Claude Internal",
  "codex-cli": "Codex CLI",
  "codex-app": "Codex App",
  "codex-internal": "Codex Internal",
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

export function formatSessionMarkdown(session: SessionSearchResult | IndexedSession, messages: SessionMessage[]): string {
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
  return [...header, ...body].join("\n");
}

export function formatSessionPlainText(session: SessionSearchResult | IndexedSession, messages: SessionMessage[]): string {
  return formatSessionMarkdown(session, messages).replace(/^#+\s/gm, "");
}
