// UI and standalone MCP share lexical semantics, not their presentation filters
// or ranking. Keep this module free of Electron/database dependencies.
export function parseSearchClauses(query: string): string[] {
  const clauses: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|(\S+)/gu)) {
    const quoted = Boolean(match[1]);
    const value = (match[1] || match[2] || "").trim();
    if (!value || value.toLocaleLowerCase() === "and") continue;
    // Single characters are noisy substring matches unless explicitly quoted.
    if (!quoted && [...value].length < 2) continue;
    if (!clauses.includes(value)) clauses.push(value);
  }
  return clauses;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}
