export const MESSAGE_LINK_SCHEME = "agent-recall-v2";

export interface MessageLocator {
  sessionKey: string;
  messageIndex: number;
  fingerprint: string;
}

export interface MessageBookmark extends MessageLocator {
  title: string;
  excerpt: string;
  createdAt: number;
  /** Resolved at read time; null when the original message can no longer be identified. */
  resolvedMessageIndex?: number | null;
}

export interface RedactionFinding {
  id: string;
  start: number;
  end: number;
  kind: "secret" | "email" | "path" | "custom";
  replacement: string;
}

export interface RedactionChoice { id: string; replacement: string }
export type ReviewExportFormat = "markdown" | "text";
export interface ExportReview {
  id: string;
  text: string;
  findings: RedactionFinding[];
  format: ReviewExportFormat;
}

export function parseMessageLocator(value: unknown): MessageLocator {
  if (!value || typeof value !== "object") throw new Error("Invalid message location.");
  const item = value as Record<string, unknown>;
  if (typeof item.sessionKey !== "string" || !item.sessionKey.trim() || item.sessionKey.length > 2048
    || /[\u0000-\u001f]/u.test(item.sessionKey)
    || !Number.isSafeInteger(item.messageIndex) || (item.messageIndex as number) < 0
    || typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(item.fingerprint)) {
    throw new Error("Invalid message location.");
  }
  return { sessionKey: item.sessionKey, messageIndex: item.messageIndex as number, fingerprint: item.fingerprint };
}

export function messageLink(locator: MessageLocator): string {
  const item = parseMessageLocator(locator);
  const url = new URL(`${MESSAGE_LINK_SCHEME}://message`);
  url.searchParams.set("session", item.sessionKey);
  url.searchParams.set("index", String(item.messageIndex));
  url.searchParams.set("fingerprint", item.fingerprint);
  return url.href;
}

export function parseMessageLink(value: unknown): MessageLocator | null {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== `${MESSAGE_LINK_SCHEME}:` || url.hostname !== "message"
      || url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== "/")) return null;
    if ([...url.searchParams.keys()].length !== 3 || !/^\d+$/u.test(url.searchParams.get("index") ?? "")) return null;
    return parseMessageLocator({ sessionKey: url.searchParams.get("session"),
      messageIndex: Number(url.searchParams.get("index")), fingerprint: url.searchParams.get("fingerprint") });
  } catch { return null; }
}

/** Scan the complete rendered export, including metadata and tool traces. Never send it to a provider. */
export function findRedactions(text: string): RedactionFinding[] {
  const candidates: RedactionFinding[] = [];
  const patterns: Array<[RedactionFinding["kind"], RegExp]> = [
    ["secret", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
    ["secret", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu],
    ["secret", /\b(?:authorization\s*[:=]\s*["']?\s*Bearer\s+|(?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s"'`,;<>]{4,}/giu],
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu],
    ["path", /(?:\b[A-Z]:[\\/]|\\\\[^\s\\/]+[\\/]|\/(?:Users|home|root|tmp|var|opt|private)\/)[^\r\n"'`<>|)\]}]+/gu],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].trimEnd().length;
      if (!candidates.some((item) => start < item.end && end > item.start)) {
        candidates.push({ id: `${start}:${end}`, start, end, kind, replacement: `[${kind.toUpperCase()}]` });
      }
      if (candidates.length > 10_000) throw new Error("Too many sensitive matches. Export a smaller conversation.");
    }
  }
  return candidates.sort((a, b) => a.start - b.start);
}

/** Custom matches use literal text, never a user-supplied regular expression. */
export function addCustomRedactions(text: string, findings: RedactionFinding[], value: string): RedactionFinding[] {
  if (!value || value.length > 4096) throw new Error("Enter between 1 and 4096 characters.");
  const result = [...findings];
  let start = text.indexOf(value);
  while (start !== -1) {
    const end = start + value.length;
    if (!result.some((item) => start < item.end && end > item.start)) {
      result.push({ id: `${start}:${end}`, start, end, kind: "custom", replacement: "[REDACTED]" });
    }
    if (result.length > 10_000) throw new Error("Too many sensitive matches. Use a longer phrase.");
    start = text.indexOf(value, end);
  }
  return result.sort((a, b) => a.start - b.start);
}

export function applyRedactions(text: string, findings: RedactionFinding[], choices: RedactionChoice[]): string {
  if (!Array.isArray(choices) || choices.length > findings.length) throw new Error("Invalid redaction choices.");
  const seen = new Set<string>();
  const selected = choices.map((choice) => {
    if (!choice || typeof choice.id !== "string" || seen.has(choice.id)
      || typeof choice.replacement !== "string" || choice.replacement.length > 4096) throw new Error("Invalid redaction choice.");
    seen.add(choice.id);
    const finding = findings.find((item) => item.id === choice.id);
    if (!finding) throw new Error("Export preview changed. Review it again.");
    return { ...finding, replacement: choice.replacement };
  }).sort((a, b) => a.start - b.start);
  let cursor = 0;
  const parts: string[] = [];
  for (const item of selected) {
    if (item.start < cursor) throw new Error("Overlapping redactions.");
    parts.push(text.slice(cursor, item.start), item.replacement);
    cursor = item.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
