interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  start: number;
}

interface MarkdownLine {
  start: number;
  end: number;
  value: string;
}

function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;

  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline === -1 ? markdown.length : newline + 1;
    lines.push({ start, end, value: markdown.slice(start, newline === -1 ? end : newline).replace(/\r$/, "") });
    start = end;
  }

  return lines;
}

function openingFence(line: string, start: number): MarkdownFence | null {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
  if (!match) return null;
  const marker = match[1][0] as MarkdownFence["marker"];
  return { marker, length: match[1].length, start };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const match = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function beginsMarkdownBlock(line: string): boolean {
  return /^(?:[ \t]{0,3}(?:#{1,6}[ \t]+|>|(?:[-+*]|\d+[.)])[ \t]+)|[ \t]{0,3}(?:={3,}|-{3,})[ \t]*$)/.test(line);
}

function wordBoundary(markdown: string, limit: number): number {
  const prefix = markdown.slice(0, limit);
  const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\t"));
  return boundary >= Math.floor(limit * 0.7) ? boundary : limit;
}

function closeLeadingFence(markdown: string, limit: number, fence: MarkdownFence): string {
  const closingFence = fence.marker.repeat(fence.length);
  const contentLimit = Math.max(0, limit - closingFence.length - 1);
  return `${markdown.slice(0, contentLimit).trimEnd()}\n${closingFence}`;
}

export function truncateMarkdownAtBlockBoundary(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;
  if (maxChars <= 0) return "";

  let fence: MarkdownFence | null = null;
  let lastBlockBoundary = 0;
  let lastSafeLineEnd = 0;

  for (const line of markdownLines(markdown)) {
    if (line.start >= maxChars) break;

    if (fence) {
      if (closesFence(line.value, fence) && line.end <= maxChars) {
        fence = null;
        lastSafeLineEnd = line.end;
        lastBlockBoundary = line.end;
      }
      continue;
    }

    const nextFence = openingFence(line.value, line.start);
    if (nextFence) {
      if (line.start > 0) lastBlockBoundary = line.start;
      fence = nextFence;
      continue;
    }

    if (line.end <= maxChars) {
      if (beginsMarkdownBlock(line.value) && line.start > 0) lastBlockBoundary = line.start;
      lastSafeLineEnd = line.end;
      if (line.value.trim() === "") lastBlockBoundary = line.start;
    }
  }

  if (fence) {
    if (fence.start === 0) return closeLeadingFence(markdown, maxChars, fence);
    return markdown.slice(0, fence.start).trimEnd();
  }

  const nearbyBoundary = Math.max(0, maxChars - Math.min(800, Math.floor(maxChars * 0.25)));
  const cutoff = lastBlockBoundary >= nearbyBoundary
    ? lastBlockBoundary
    : lastSafeLineEnd > 0
      ? lastSafeLineEnd
      : wordBoundary(markdown, maxChars);
  return markdown.slice(0, cutoff).trimEnd();
}

export function markdownPreview(markdown: string, maxChars: number, truncatedNotice: string): string {
  if (markdown.length <= maxChars) return markdown;
  const preview = truncateMarkdownAtBlockBoundary(markdown, maxChars);
  return preview ? `${preview}\n\n${truncatedNotice}` : truncatedNotice;
}
