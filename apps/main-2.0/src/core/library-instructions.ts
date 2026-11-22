/**
 * The block of a user-level instructions file (CLAUDE.md, AGENTS.md, …) that
 * the personal Library owns. Everything outside it is the user's own text and
 * is never changed by a Library write.
 */
export const LIBRARY_BEGIN = "<!-- agentrecall:library begin -->";
export const LIBRARY_END = "<!-- agentrecall:library end -->";

const BROKEN = "The AgentRecall Library block in this file is broken or repeated. Fix or remove it by hand, then try again.";
// Blocks other tools own in the same files: the team space's and magpie's.
const MANAGED_BLOCK = /<!--\s*(agentrecall:[a-z-]+|magpie:)\s*begin\b[^>]*-->[\s\S]*?<!--\s*\1\s*end\s*-->/g;

function locate(text: string): { start: number; end: number } | null {
  const starts = text.split(LIBRARY_BEGIN).length - 1;
  const ends = text.split(LIBRARY_END).length - 1;
  if (starts === 0 && ends === 0) return null;
  const start = text.indexOf(LIBRARY_BEGIN);
  const end = text.indexOf(LIBRARY_END);
  if (starts !== 1 || ends !== 1 || end < start) throw new Error(BROKEN);
  return { start, end: end + LIBRARY_END.length };
}

/** The Library block's body, or null when the file has none. */
export function ownedBlock(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const block = locate(normalized);
  return block ? normalized.slice(block.start + LIBRARY_BEGIN.length, block.end - LIBRARY_END.length).trim() : null;
}

/** The file with the Library block set to body, or taken out for null. A new block goes after the user's text. */
export function withOwnedBlock(text: string, body: string | null): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const block = locate(normalized);
  const before = (block ? normalized.slice(0, block.start) : normalized).replace(/\n+$/, "");
  const after = block ? normalized.slice(block.end).replace(/^\n+/, "").replace(/\n+$/, "") : "";
  const owned = body?.trim() ? `${LIBRARY_BEGIN}\n${body.trim()}\n${LIBRARY_END}` : "";
  const parts = [before, owned, after].filter((part) => part.trim() !== "");
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** The user's own paragraphs, outside every managed block, with spacing tidied for comparison. */
export function personalParagraphs(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(MANAGED_BLOCK, "\n\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.split("\n").map((line) => line.replace(/(\S)[ \t]+/g, "$1 ").trimEnd()).join("\n").trim())
    .filter(Boolean);
}

/** The file without the user's paragraphs whose tidied text is in `paragraphs`. Managed blocks stay as they are. */
export function withoutParagraphs(text: string, paragraphs: ReadonlySet<string>): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const kept: string[] = [];
  let index = 0;
  const keepPersonal = (chunk: string) => {
    for (const paragraph of chunk.split(/\n[ \t]*\n/)) {
      if (!paragraph.trim()) continue;
      const [tidied] = personalParagraphs(paragraph);
      if (!tidied || !paragraphs.has(tidied)) kept.push(paragraph.replace(/^\n+|\s+$/g, ""));
    }
  };
  for (const match of normalized.matchAll(MANAGED_BLOCK)) {
    keepPersonal(normalized.slice(index, match.index));
    kept.push(match[0]);
    index = match.index + match[0].length;
  }
  keepPersonal(normalized.slice(index));
  return kept.length ? `${kept.join("\n\n")}\n` : "";
}

/** magpie writes its own Library into the same files; two tools rewriting one file would undo each other. */
export function hasMagpieBlock(text: string): boolean {
  return text.includes("<!-- magpie:begin");
}
