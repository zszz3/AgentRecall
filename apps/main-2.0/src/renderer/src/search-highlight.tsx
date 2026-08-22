import type { ReactElement } from "react";

export interface HighlightedTextPart {
  text: string;
  highlighted: boolean;
}

export function searchHighlightTerms(query: string): string[] {
  const terms: string[] = [];
  const expression = /"([^"]+)"|([\p{L}\p{N}_]+)/gu;
  for (const match of query.matchAll(expression)) {
    const quoted = Boolean(match[1]);
    const value = (match[1] ?? match[2] ?? "").trim().toLocaleLowerCase();
    if (!value || value === "and" || (!quoted && [...value].length < 2)) continue;
    if (!terms.includes(value)) terms.push(value);
  }
  return terms;
}

export function highlightedTextParts(text: string, terms: string[]): HighlightedTextPart[] {
  const normalizedTerms = [...new Set(terms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))];
  if (!text || normalizedTerms.length === 0) return [{ text, highlighted: false }];
  const expression = new RegExp(`(${normalizedTerms.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "giu");
  const termSet = new Set(normalizedTerms);
  return text
    .split(expression)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, highlighted: termSet.has(part.toLocaleLowerCase()) }));
}

export function HighlightedSearchText({ text, terms }: { text: string; terms: string[] }): ReactElement {
  return (
    <>
      {highlightedTextParts(text, terms).map((part, index) =>
        part.highlighted ? <mark key={`${index}:${part.text}`}>{part.text}</mark> : <span key={`${index}:${part.text}`}>{part.text}</span>,
      )}
    </>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
